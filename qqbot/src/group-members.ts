import {
  GroupOpenIdSchema as Identity, GroupMemberSchema, GroupMemberFiltersSchema as FiltersSchema,
  GroupMemberQuerySchema, GroupRosterPageSchema as RosterPageSchema,
  type GroupMember, type GroupMemberFilters as Filters, type GroupMemberQuery, type GroupMemberResult,
} from './shared/group-members.ts';
import { ApiError, type QQBot } from '@tencent-connect/qqbot-nodejs';
import { setTimeout as delay } from 'node:timers/promises';
import type { State, StateStore } from './state.ts';


function filterMembers(members: GroupMember[], filters: Filters): GroupMember[] {
  const nickname = filters.nickname?.trim().toLowerCase();
  return members.filter(member => (filters.member_openid === undefined || member.member_openid === filters.member_openid)
    && (!nickname || Boolean(member.username?.toLowerCase().includes(nickname))));
}

function mergeProfiles(previous: Record<string, GroupMember>, members: readonly GroupMember[]): Record<string, GroupMember> | undefined {
  let changed: Record<string, GroupMember> | undefined;
  for (const member of members) {
    const profiles = changed ?? previous;
    const old = Object.hasOwn(profiles, member.member_openid) ? profiles[member.member_openid] : undefined;
    const next = { ...old, member_openid: member.member_openid };
    for (const field of ['username', 'member_role', 'bot', 'joined_at', 'union_openid'] as const) {
      const value = member[field];
      if (value !== undefined && !(field === 'username' && typeof value === 'string' && !value.trim())) Object.defineProperty(next, field, { value, enumerable: true, configurable: true, writable: true });
    }
    if (old && Object.entries(next).every(([field, value]) => old[field as keyof GroupMember] === value)) continue;
    changed ??= { ...previous };
    Object.defineProperty(changed, member.member_openid, { value: next, enumerable: true, configurable: true, writable: true });
  }
  return changed;
}

function assertWritable(state: State, appId: string, groupOpenid: string, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (state.config.appId !== appId) throw new Error('QQ 机器人账号已替换');
  if (state.access.groupMode === 'disabled' || (state.access.groupMode === 'allowlist' && !state.access.allowGroup.some(member => member.openid === groupOpenid))) throw new Error('当前群已不允许机器人访问');
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  void work.then(resolve, reject);
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  void promise.then(cleanup, cleanup);
  return promise;
}

interface Pace { chain: Promise<void>; nextAt: number }
// Platform limits are per account, not per group or directory instance.
const accountPacing = new Map<string, { list: Pace; member: Pace }>();

/** Learned identities are separate from access lists and are never a live-roster assertion. */
export class GroupMembers {
  constructor(private readonly store: StateStore, private readonly appId: string, private readonly api: QQBot['api'], private readonly signal: AbortSignal) {
    Identity.parse(appId);
  }

  async list(groupOpenid: string, filters: Filters = {}): Promise<GroupMember[]> {
    const group = Identity.parse(groupOpenid);
    const input = FiltersSchema.parse(filters);
    return filterMembers(await this.read(group, this.signal), input);
  }

  async record(groupOpenid: string, members: readonly GroupMember[]): Promise<void> {
    const group = Identity.parse(groupOpenid);
    const profiles = GroupMemberSchema.array().parse(members);
    await this.save(group, profiles, this.signal);
  }

  async query(groupOpenid: string, input: GroupMemberQuery, signal?: AbortSignal): Promise<GroupMemberResult> {
    const group = Identity.parse(groupOpenid);
    const filters = GroupMemberQuerySchema.parse(input);
    const active = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    active.throwIfAborted();
    if (!filters.refresh) return { group_openid: group, members: filterMembers(await this.read(group, active), filters), source: 'directory', complete: false };

    let members: GroupMember[];
    const complete = filters.member_openid === undefined;
    try {
      const path = `/v2/groups/${encodeURIComponent(group)}/members`;
      if (filters.member_openid !== undefined) {
        const member = GroupMemberSchema.parse(await this.platformGet(`${path}/${encodeURIComponent(filters.member_openid)}`, 'member', active));
        if (member.member_openid !== filters.member_openid) throw new TypeError('平台返回的群成员 OpenID 与请求不匹配');
        members = [member];
      } else {
        const fetched = new Map<string, GroupMember>();
        const cursors = new Set<string>();
        let cursor = '';
        do {
          const page = RosterPageSchema.parse(await this.platformGet(path, 'list', active, cursor ? { cursor } : undefined));
          for (const member of page.members) {
            const old = fetched.get(member.member_openid);
            const next = { ...old, ...member };
            if (!member.username?.trim() && old?.username) next.username = old.username;
            fetched.set(member.member_openid, next);
          }
          cursor = page.next_cursor;
          if (cursor && cursors.has(cursor)) throw new Error('群成员列表分页游标重复');
          cursors.add(cursor);
        } while (cursor);
        members = [...fetched.values()];
      }
    } catch (error) {
      active.throwIfAborted();
      if (!(error instanceof ApiError) || error.bizCode !== 11253) throw error;
      return { group_openid: group, members: filterMembers(await this.read(group, active), filters), source: 'directory', complete: false,
        platform_error: { code: 11253, message: '应用无群成员接口访问权限；请联系 QQ 平台申请白名单。以下仅为已知身份，不是完整群名单。' } };
    }
    await this.save(group, members, active);
    active.throwIfAborted();
    return { group_openid: group, members: filterMembers(members, filters), source: 'platform', complete };
  }

  private async read(groupOpenid: string, signal: AbortSignal): Promise<GroupMember[]> {
    signal.throwIfAborted();
    const { values } = await this.store.read();
    signal.throwIfAborted();
    const key = JSON.stringify([this.appId, groupOpenid]);
    return Object.hasOwn(values.groupMembers, key) ? Object.values(values.groupMembers[key]!) : [];
  }

  private async save(groupOpenid: string, members: readonly GroupMember[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!members.length) return;
    const key = JSON.stringify([this.appId, groupOpenid]);
    const { values } = await this.store.read();
    assertWritable(values, this.appId, groupOpenid, signal);
    const previous = Object.hasOwn(values.groupMembers, key) ? values.groupMembers[key]! : {};
    // StateStore always patches a successful mutation; avoid entering it for
    // unchanged observations while retaining the mutation-time permission check.
    if (!mergeProfiles(previous, members)) return;
    await this.store.mutate(state => {
      assertWritable(state, this.appId, groupOpenid, signal);
      const current = Object.hasOwn(state.groupMembers, key) ? state.groupMembers[key]! : {};
      const updated = mergeProfiles(current, members);
      if (updated) Object.defineProperty(state.groupMembers, key, { value: updated, enumerable: true, configurable: true, writable: true });
    });
  }

  private async platformGet(path: string, kind: 'list' | 'member', signal: AbortSignal, query?: Record<string, string>): Promise<unknown> {
    signal.throwIfAborted();
    let pacing = accountPacing.get(this.appId);
    if (!pacing) {
      pacing = { list: { chain: Promise.resolve(), nextAt: 0 }, member: { chain: Promise.resolve(), nextAt: 0 } };
      accountPacing.set(this.appId, pacing);
    }
    const pace = pacing[kind];
    const turn = pace.chain.then(async () => {
      signal.throwIfAborted();
      while (Date.now() < pace.nextAt) await delay(pace.nextAt - Date.now(), undefined, { signal });
      signal.throwIfAborted();
      // Start cooling after settlement so token/access checks cannot compress the HTTP gap.
      try { return await this.api.get<unknown>(path, query); }
      finally { pace.nextAt = Date.now() + (kind === 'list' ? 1000 : 2000); }
    });
    pace.chain = turn.then(() => undefined, () => undefined);
    // SDK 1.0.5's gateway has no AbortSignal parameter. Stop awaiting on cancel;
    // the SDK request may finish, but its result can never reach persistence.
    const result = await abortable(turn, signal);
    signal.throwIfAborted();
    return result;
  }
}
