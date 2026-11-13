import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import type { PluginStorage } from '@omp-desktop/plugin';
import { ApiError, QQBot } from '@tencent-connect/qqbot-nodejs';
import { GroupMembers } from './group-members.ts';
import { GroupDirectorySchema, GroupMemberSchema, GroupMemberQuerySchema, GroupMemberResultSchema, type GroupMember } from './shared/group-members.ts';
import { StateSchema, StateStore, switchAccount } from './state.ts';

const servers: Server[] = [];
let accountSequence = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

function memoryStorage(appId: string) {
  let revision = 0;
  let values: Record<string, unknown> = StateSchema.parse({ config: { appId }, access: { owners: [{ openid: 'owner', nickname: 'Existing owner', scene: 'c2c', claimedAt: 1 }] } });
  const patch = vi.fn(async <T>(update: Partial<T>, expected: number) => {
    if (expected !== revision) throw new Error('STORAGE_REVISION_CONFLICT');
    values = { ...values, ...JSON.parse(JSON.stringify(update)) };
    return { revision: ++revision, values: structuredClone(values) as T };
  });
  const storage: PluginStorage = { async get<T>() { return { revision, values: structuredClone(values) as T }; }, patch };
  return { storage, patch, store: new StateStore(storage) };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => json(res, 500, { message: 'Unexpected request' })) {
  const requests: string[] = [];
  const requested = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    if (req.url === '/app/getAppAccessToken') { json(res, 200, { access_token: 'local-fixture-token', expires_in: 7200 }); return; }
    requests.push(`${req.method} ${req.url}`);
    requested.resolve();
    handler(req, res);
  });
  servers.push(server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture address');
  const appId = `member-fixture-${++accountSequence}`;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const bot = new QQBot({ appId, appSecret: 'fixture-only-secret', baseUrl, tokenBaseUrl: baseUrl, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const controller = new AbortController();
  const memory = memoryStorage(appId);
  const directory = new GroupMembers(memory.store, appId, bot.api, controller.signal);
  return { ...memory, appId, bot, controller, directory, requests, requested: requested.promise };
}

const alice: GroupMember = { member_openid: 'full-alice-0123456789', username: 'Same Name', member_role: 'admin', bot: false, joined_at: '2026-01-01T00:00:00Z', union_openid: 'union-alice' };
const bob: GroupMember = { member_openid: 'full-bob-0123456789', username: 'Same Name' };

describe('persistent learned QQ group identities', () => {
  it('retains complete IDs, colliding nicknames and account/group isolation across storage reloads without granting access', async () => {
    const f = await fixture();
    const access = (await f.store.read()).values.access;
    await f.directory.record('current-group', [alice, bob]);
    await f.directory.record('other-group', [{ member_openid: 'full-carol', username: 'Same Name' }]);
    const reloaded = new GroupMembers(new StateStore(f.storage), f.appId, f.bot.api, f.controller.signal);
    expect(await reloaded.query('current-group', { nickname: ' NAME ' })).toEqual({ group_openid: 'current-group', source: 'directory', complete: false, members: [alice, bob] });
    expect(await reloaded.list('current-group', { member_openid: bob.member_openid })).toEqual([bob]);
    expect(await reloaded.list('current-group', { member_openid: 'full-bob' })).toEqual([]);
    expect(await reloaded.list('current-group', { nickname: 'different', member_openid: bob.member_openid })).toEqual([]);
    expect(f.requests).toEqual([]);
    expect((await f.store.read()).values.access).toEqual(access);
    await f.store.mutate(state => switchAccount(state, `${f.appId}-second`));
    const otherAccount = new GroupMembers(f.store, `${f.appId}-second`, f.bot.api, f.controller.signal);
    expect(await otherAccount.list('current-group')).toEqual([]);
    await otherAccount.record('current-group', [{ member_openid: alice.member_openid, username: 'Second account name' }]);
    expect(await reloaded.list('current-group')).toEqual([alice, bob]);
    expect(await otherAccount.list('current-group')).toEqual([{ member_openid: alice.member_openid, username: 'Second account name' }]);
  });

  it('preserves profile details on sparse observations and skips unchanged writes, while accepting renames and false flags', async () => {
    const f = await fixture();
    await f.directory.record('group', [{ ...alice, bot: true }]);
    const writes = f.patch.mock.calls.length;
    await f.directory.record('group', [{ member_openid: alice.member_openid }, { member_openid: alice.member_openid, username: '   ', member_role: undefined }]);
    expect(f.patch.mock.calls).toHaveLength(writes);
    expect(await f.directory.list('group')).toEqual([{ ...alice, bot: true }]);
    await f.directory.record('group', [{ member_openid: alice.member_openid, username: 'Renamed', member_role: 'member', bot: false }]);
    expect(await f.directory.list('group')).toEqual([{ ...alice, username: 'Renamed', member_role: 'member', bot: false }]);
    const afterRename = f.patch.mock.calls.length;
    await f.directory.record('group', []);
    expect(f.patch.mock.calls).toHaveLength(afterRename);
  });

  it('persists prototype-shaped IDs as ordinary records through schema and JSON storage', async () => {
    const f = await fixture();
    const members = ['__proto__', 'constructor', 'toString'].map(member_openid => ({ member_openid, username: 'Distinct identity' }));
    await f.directory.record('__proto__', members);
    const reloaded = new GroupMembers(new StateStore(f.storage), f.appId, f.bot.api, f.controller.signal);
    expect(await reloaded.list('__proto__')).toEqual(members);
    expect(await reloaded.list('missing-group')).toEqual([]);
    expect(({} as Record<string, unknown>).username).toBeUndefined();
    const persisted = (await f.store.read()).values.groupMembers[JSON.stringify([f.appId, '__proto__'])]!;
    expect(Object.hasOwn(persisted, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(persisted)).toBe(Object.prototype);
  });

  it('rejects malformed persisted directory records and identity/key mismatches instead of losing records', () => {
    const key = JSON.stringify(['app', 'group']);
    expect(() => GroupDirectorySchema.parse({ [key]: { alice: { member_openid: 'bob' } } })).toThrow();
    expect(() => GroupDirectorySchema.parse({ [key]: [] })).toThrow();
    expect(() => GroupDirectorySchema.parse({ 'not-a-scoped-key': {} })).toThrow();
    expect(() => GroupDirectorySchema.parse({ [key]: { alice: { member_openid: 'alice', bot: 'false' } } })).toThrow();
  });

  it('shares strict public query/result contracts while ignoring unrelated platform profile fields', () => {
    expect(GroupMemberQuerySchema.parse({ nickname: 'Name', member_openid: '  full-ID  ', refresh: true })).toEqual({ nickname: 'Name', member_openid: 'full-ID', refresh: true });
    expect(() => GroupMemberQuerySchema.parse({ group_openid: 'arbitrary-group' })).toThrow();
    expect(() => GroupMemberQuerySchema.parse({ refresh: 'true' })).toThrow();
    expect(() => GroupMemberQuerySchema.parse({ member_openid: 'path/injection' })).toThrow();
    expect(GroupMemberSchema.parse({ ...alice, unrelated_platform_field: 'ignored' })).toEqual(alice);
    const result = { group_openid: 'group', members: [alice], source: 'directory', complete: false };
    expect(GroupMemberResultSchema.parse(result)).toEqual(result);
    expect(() => GroupMemberResultSchema.parse({ ...result, complete: 'false' })).toThrow();
    expect(() => GroupMemberResultSchema.parse({ ...result, source: 'cache' })).toThrow();
    expect(() => GroupMemberResultSchema.parse({ ...result, extra: true })).toThrow();
  });

  it.each(['disabled', 'allowlist'] as const)('does not write observed profiles for a denied group (%s)', async groupMode => {
    const f = await fixture();
    await f.store.mutate(state => { state.access.groupMode = groupMode; });
    const writes = f.patch.mock.calls.length;
    await expect(f.directory.record('denied', [alice])).rejects.toThrow('不允许');
    expect(f.patch.mock.calls).toHaveLength(writes);
    expect(await f.directory.list('denied')).toEqual([]);
  });

  it.each(['account', 'group', 'cancel'] as const)('rechecks %s after an observation waits for the scoped mutation queue', async change => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = f.store.mutate(async state => {
      entered.resolve();
      await release.promise;
      if (change === 'account') switchAccount(state, `${f.appId}-replaced`);
      else if (change === 'group') state.access.groupMode = 'disabled';
    });
    await entered.promise;
    const record = f.directory.record('group', [alice]);
    const settled = record.then(() => undefined, error => error);
    await nextImmediate();
    if (change === 'cancel') f.controller.abort(new Error('Disposed directory'));
    release.resolve();
    await blocker;
    expect(await settled).toBeInstanceOf(Error);
    expect((await f.store.read()).values.groupMembers).toEqual({});
    expect(f.patch.mock.calls).toHaveLength(1);
  });

  it('validates an entire observation before committing any identity', async () => {
    const f = await fixture();
    await expect(f.directory.record('group', [alice, { member_openid: 42 } as unknown as GroupMember])).rejects.toThrow();
    expect(await f.directory.list('group')).toEqual([]);
    expect(f.patch).not.toHaveBeenCalled();
  });
});

describe('official QQ member roster and detail refresh', () => {
  it('paginates all pages before one commit, filters afterward, and keeps sparse profile fields across pages', async () => {
    const secondPageRequested = Promise.withResolvers<void>();
    const secondPageResponse = Promise.withResolvers<ServerResponse>();
    const f = await fixture((req, res) => {
      if (!new URL(req.url!, 'http://localhost').searchParams.has('cursor')) json(res, 200, { members: [alice], next_cursor: 'page+2/&?' });
      else { secondPageResponse.resolve(res); secondPageRequested.resolve(); }
    });
    await f.directory.record('current-group', [{ member_openid: 'former-member', username: 'Former' }]);
    const writes = f.patch.mock.calls.length;
    const work = f.directory.query('current-group', { refresh: true, nickname: 'same' });
    await secondPageRequested.promise;
    expect(await f.directory.list('current-group')).toEqual([{ member_openid: 'former-member', username: 'Former' }]);
    json(await secondPageResponse.promise, 200, { members: [{ member_openid: alice.member_openid, username: '   ' }, bob, { member_openid: 'unmatched', username: 'Other' }], next_cursor: '' });
    expect(await work).toEqual({ group_openid: 'current-group', source: 'platform', complete: true, members: [alice, bob] });
    expect(f.requests).toEqual(['GET /v2/groups/current-group/members', 'GET /v2/groups/current-group/members?cursor=page%2B2%2F%26%3F']);
    expect(f.patch.mock.calls).toHaveLength(writes + 1);
    expect(await f.directory.list('current-group')).toEqual([{ member_openid: 'former-member', username: 'Former' }, alice, bob, { member_openid: 'unmatched', username: 'Other' }]);
    expect((await f.directory.query('current-group', {})).complete).toBe(false);
  });

  it('uses normalized complete OpenIDs in the detail URL and never calls detail a complete roster', async () => {
    const member = { ...alice, member_openid: 'member_with-full-ID' };
    const f = await fixture((_req, res) => json(res, 200, member));
    expect(await f.directory.query('  group-with_full-ID  ', { member_openid: `  ${member.member_openid}  `, refresh: true })).toEqual({ group_openid: 'group-with_full-ID', members: [member], source: 'platform', complete: false });
    expect(f.requests).toEqual(['GET /v2/groups/group-with_full-ID/members/member_with-full-ID']);
    expect(await f.directory.list('group-with_full-ID')).toEqual([member]);
  });

  it('rejects invalid group/member URL segments before sending any SDK request', async () => {
    const f = await fixture();
    await expect(f.directory.query('group/path?query', { refresh: true })).rejects.toThrow();
    await expect(f.directory.query('group', { member_openid: 'member/path?query', refresh: true })).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it('preserves previously learned names and detail fields after a sparse platform detail refresh', async () => {
    const f = await fixture((_req, res) => json(res, 200, { member_openid: alice.member_openid, username: '', bot: false }));
    await f.directory.record('group', [alice]);
    await f.directory.query('group', { member_openid: alice.member_openid, refresh: true });
    expect(await f.directory.list('group')).toEqual([alice]);
  });

  it('rejects a detail response for a different identity without caching it', async () => {
    const f = await fixture((_req, res) => json(res, 200, bob));
    await expect(f.directory.query('group', { member_openid: alice.member_openid, refresh: true })).rejects.toThrow('不匹配');
    expect(await f.directory.list('group')).toEqual([]);
  });

  it('returns explicit permission-only fallback for SDK ApiError 11253, including filtered detail misses', async () => {
    const f = await fixture((_req, res) => json(res, 403, { code: 11253, message: 'No interface permission' }));
    await f.directory.record('group', [alice, bob]);
    const writes = f.patch.mock.calls.length;
    expect(await f.directory.query('group', { refresh: true, nickname: ' SAME ' })).toMatchObject({ source: 'directory', complete: false, members: [alice, bob], platform_error: { code: 11253 } });
    expect(await f.directory.query('group', { refresh: true, member_openid: 'unknown' })).toMatchObject({ source: 'directory', complete: false, members: [], platform_error: { code: 11253 } });
    expect(f.patch.mock.calls).toHaveLength(writes);
  });

  it.each([403, 502])('propagates non-permission HTTP %s failures instead of hiding them with the directory', async status => {
    const f = await fixture((_req, res) => json(res, status, { code: 99999, message: 'Platform failed' }));
    await f.directory.record('group', [alice]);
    await expect(f.directory.query('group', { refresh: true })).rejects.toBeInstanceOf(ApiError);
    expect(await f.directory.list('group')).toEqual([alice]);
  });

  it('does not mistake a successful error-shaped or duck-typed error value for permission fallback', async () => {
    const f = await fixture((_req, res) => json(res, 200, { code: 11253, message: 'Not an SDK ApiError' }));
    await expect(f.directory.query('group', { refresh: true })).rejects.toThrow();
    vi.spyOn(f.bot.api, 'get').mockRejectedValue({ bizCode: 11253 });
    await expect(f.directory.query('group', { member_openid: 'alice', refresh: true })).rejects.toEqual({ bizCode: 11253 });
    expect(f.patch).not.toHaveBeenCalled();
  });

  it.each(['failure', 'permission', 'malformed-member', 'malformed-page', 'repeated-cursor'] as const)('never persists a partial roster after a later-page %s', async mode => {
    const f = await fixture((req, res) => {
      if (!req.url!.includes('?')) { json(res, 200, { members: [bob], next_cursor: 'next' }); return; }
      if (mode === 'failure') json(res, 502, { message: 'Upstream failure' });
      else if (mode === 'permission') json(res, 403, { code: 11253, message: 'No interface permission' });
      else if (mode === 'malformed-member') json(res, 200, { members: [{ member_openid: 'new', member_role: 'moderator' }], next_cursor: '' });
      else if (mode === 'malformed-page') json(res, 200, { members: [] });
      else json(res, 200, { members: [], next_cursor: 'next' });
    });
    await f.directory.record('group', [alice]);
    const writes = f.patch.mock.calls.length;
    const work = f.directory.query('group', { refresh: true });
    if (mode === 'permission') expect(await work).toMatchObject({ source: 'directory', complete: false, members: [alice], platform_error: { code: 11253 } });
    else await expect(work).rejects.toThrow();
    expect(await f.directory.list('group')).toEqual([alice]);
    expect(f.patch.mock.calls).toHaveLength(writes);
  });

  it.each([
    { member_openid: '' }, { member_openid: 'has\0nul' }, { member_openid: 42 },
    { member_openid: 'alice', username: 42 }, { member_openid: 'alice', bot: 'false' },
    { member_openid: 'alice', joined_at: 42 }, { member_openid: 'alice', union_openid: 'bad\0value' },
  ])('rejects invalid public platform records: %j', async member => {
    const f = await fixture((_req, res) => json(res, 200, { members: [member], next_cursor: '' }));
    await expect(f.directory.query('group', { refresh: true })).rejects.toThrow();
    expect(f.patch).not.toHaveBeenCalled();
  });

  it('accepts an empty complete roster without inventing members', async () => {
    const f = await fixture((_req, res) => json(res, 200, { members: [], next_cursor: '' }));
    expect(await f.directory.query('group', { refresh: true })).toEqual({ group_openid: 'group', source: 'platform', complete: true, members: [] });
    expect(f.patch).not.toHaveBeenCalled();
  });

  it.each(['account', 'group'] as const)('refuses to persist a successful platform refresh after %s changes', async change => {
    const response = Promise.withResolvers<ServerResponse>();
    const f = await fixture((_req, res) => response.resolve(res));
    const work = f.directory.query('group', { refresh: true });
    await f.requested;
    await f.store.mutate(state => { if (change === 'account') switchAccount(state, `${f.appId}-replaced`); else state.access.groupMode = 'disabled'; });
    json(await response.promise, 200, { members: [alice], next_cursor: '' });
    await expect(work).rejects.toThrow();
    expect((await f.store.read()).values.groupMembers).toEqual({});
  });

  it('cancels an in-flight SDK request promptly and never persists its eventual response', async () => {
    const response = Promise.withResolvers<ServerResponse>();
    const f = await fixture((_req, res) => response.resolve(res));
    const completed = Promise.withResolvers<void>();
    const original = f.bot.api.get.bind(f.bot.api);
    vi.spyOn(f.bot.api, 'get').mockImplementation(async (path, query) => {
      try { return await original(path, query); } finally { completed.resolve(); }
    });
    const controller = new AbortController();
    const reason = new Error('Cancelled in flight');
    const work = f.directory.query('group', { refresh: true }, controller.signal);
    await f.requested;
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
    json(await response.promise, 200, { members: [alice], next_cursor: '' });
    await completed.promise;
    await nextImmediate();
    expect(f.patch).not.toHaveBeenCalled();
  });

  it('cancels between pages without requesting or caching the next page', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled after first page');
    const f = await fixture((_req, res) => { controller.abort(reason); json(res, 200, { members: [alice], next_cursor: 'next' }); });
    await expect(f.directory.query('group', { refresh: true }, controller.signal)).rejects.toBe(reason);
    expect(f.requests).toEqual(['GET /v2/groups/group/members']);
    expect(f.patch).not.toHaveBeenCalled();
  });

  it.each(['list', 'member'] as const)('shares %s pacing across groups and directory instances, and cancels queued calls', async kind => {
    const f = await fixture((_req, res) => json(res, 200, kind === 'list' ? { members: [], next_cursor: '' } : alice));
    const other = new GroupMembers(new StateStore(f.storage), f.appId, f.bot.api, f.controller.signal);
    const input = kind === 'list' ? { refresh: true } : { refresh: true, member_openid: alice.member_openid };
    await f.directory.query('first-group', input);
    const requestController = new AbortController();
    const reason = new Error('Cancelled while paced');
    const waiting = other.query('second-group', input, requestController.signal);
    await nextImmediate();
    requestController.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(f.requests).toHaveLength(1);
  });

  it.each(['list', 'member'] as const)('starts concurrent %s calls no faster than the account limit', async kind => {
    const f = await fixture((_req, res) => json(res, 200, kind === 'list' ? { members: [], next_cursor: '' } : alice));
    await f.bot.api.getToken();
    const starts: number[] = [];
    const original = f.bot.api.get.bind(f.bot.api);
    vi.spyOn(f.bot.api, 'get').mockImplementation(async (path, query) => { starts.push(Date.now()); return original(path, query); });
    const other = new GroupMembers(new StateStore(f.storage), f.appId, f.bot.api, f.controller.signal);
    const input = kind === 'list' ? { refresh: true } : { refresh: true, member_openid: alice.member_openid };
    await Promise.all([f.directory.query('first-group', input), other.query('second-group', input)]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(kind === 'list' ? 1000 : 2000);
    expect(f.requests).toHaveLength(2);
  });

  it('leaves another account unblocked by a paced account', async () => {
    const f = await fixture((_req, res) => json(res, 200, { members: [], next_cursor: '' }));
    await f.directory.query('group', { refresh: true });
    const second = memoryStorage(`${f.appId}-independent`);
    const independent = new GroupMembers(second.store, `${f.appId}-independent`, f.bot.api, f.controller.signal);
    const started = Date.now();
    await independent.query('group', { refresh: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.requests).toHaveLength(2);
  });
});
