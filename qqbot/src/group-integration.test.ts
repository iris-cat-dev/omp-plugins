import { afterEach, expect, it, vi } from 'vitest';
import type { PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { OmpAgentHandle, OmpAgentStream } from '@omp-desktop/client';
import type { QQBot, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { Gateway } from './gateway.ts';
import { StateSchema, StateStore, Pairing, peerKey, type Peer } from './state.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

function conversation(responses:string[] = []) {
  let revision = 0;
  let values = StateSchema.parse({ config: { appId: 'test-account', streaming: false, autoCompactTokens: 0 } });
  const storage: PluginStorage = {
    async get<T>() { return { revision, values: structuredClone(values) as T }; },
    async patch<T>(patch: Partial<T>, expected: number) {
      if (expected !== revision) throw new Error('STORAGE_REVISION_CONFLICT');
      values = StateSchema.parse({ ...values, ...patch });
      return { revision: ++revision, values: structuredClone(values) as T };
    },
  };
  const store = new StateStore(storage);
  const ctx = { signal: new AbortController().signal, installation: { id: 'fixture', generation: 1 }, omp: { hostId: 'host' } } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-secret', logger, vi.fn());
  cleanups.push(() => gateway.dispose());
  const inputs: string[] = [];
  const peer: Peer = { appId: 'test-account', scope: 'group', openid: 'GROUP_OPENID', hostId: 'host', agentId: 'agent', workspaceId: 'workspace', cwd: '/fixture', preset: 'default', template: values.config.presets[0]!, protocolPrompt: '', lastDeliveredSequence: 0 };
  const route = { peer, agent: {} as OmpAgentHandle, unsubscribe: null, enabledDelivery: false, target: undefined, buffer: null, files: new Map(), textRows: new Map(), toolRevisions: new Map(), pending: new Map(), chain:Promise.resolve(), lastSeq: 0 };
  const internal = gateway as unknown as {
    bot: QQBot & { handleInboundMessage(message: Omit<QQBotInboundMessage, 'replyTarget'>): Promise<void> };
    routes: Map<string, typeof route>;
    getOrCreate(): Promise<typeof route>;
    event(route: typeof route, event: OmpAgentStream): Promise<void>;
    sender: { sendMarkdown: (...args: unknown[]) => Promise<unknown> };
  };
  let sequence=0;
  route.agent = { send: async (text: string, options: { messageId: string }) => {
    inputs.push(text);
    const turnId = options.messageId;
    await internal.event(route, { seq:++sequence,event: { type: 'turn_started', turnId } } as OmpAgentStream);
    await internal.event(route, { seq:++sequence,event: { type: 'timeline', turnId, item: { type: 'user_message', text, clientMessageId: options.messageId } } } as OmpAgentStream);
    const response=responses.shift()??'';
    for(let offset=0;offset<response.length;offset+=7)await internal.event(route,{seq:++sequence,event:{type:'timeline',turnId,item:{type:'assistant_message',text:response.slice(offset,offset+7),messageId:turnId}}} as OmpAgentStream);
    await internal.event(route, { seq:++sequence,event: { type: 'turn_completed', turnId } } as OmpAgentStream);
  } } as unknown as OmpAgentHandle;
  internal.routes.set(peerKey(peer.appId, peer.scope, peer.openid), route);
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  const delivered = vi.spyOn(internal.sender, 'sendMarkdown').mockResolvedValue({});
  let messageSequence = 0;
  const send = (message: Partial<QQBotInboundMessage>) => internal.bot.handleInboundMessage({
    rawEventType: 'GROUP_AT_MESSAGE_CREATE', kind: 'group', groupOpenid: peer.openid,
    messageId: `message-${++messageSequence}`, timestamp: '2026-11-13T00:00:00Z',
    senderId: 'CAROL_FULL_OPENID', senderName: '小陈', senderIsBot: false, content: '<@BOT_FULL_OPENID> 你好',
    mentions: [{ id: 'BOT_FULL_OPENID', is_you: true, username: '机器人' }],
    raw: { id: 'raw-message', group_openid: peer.openid, content: message.content ?? '你好', timestamp: '2026-11-13T00:00:00Z', author: { member_openid: message.senderId ?? 'CAROL_FULL_OPENID', username: message.senderName ?? '小陈' } } as QQBotInboundMessage['raw'], ...message,
  });
  return { gateway, internal, store, inputs, delivered, send, logger, peer };
}

it('the real SDK gateway sends complete sender, mention and cached quote identities to the agent', async () => {
  const f = conversation(['','{"type":"member_query","nickname":"同名"}','两位同名群员有不同的完整OpenID。']);
  await f.send({ rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'ALICE_FULL_OPENID', senderName: '小明', content: '未 @机器人也保留引用作者', msgIdx: 'quiet-reference', mentions: [] });
  expect(f.inputs).toEqual([]);
  await f.send({ content: '<@BOT_FULL_OPENID> 两位同名群员分别是谁？', refMsgIdx: 'quiet-reference', msgElements: [{ content: '平台提供的完整引用正文' }], mentions: [
    { id: 'BOT_FULL_OPENID', is_you: true, username: '机器人' },
    { id: 'BOB_FULL_OPENID', username: '同名' },
    { id: 'DAN_FULL_OPENID', username: '同名' },
  ] });
  expect(f.inputs).toHaveLength(1);
  for (const id of ['CAROL_FULL_OPENID', 'ALICE_FULL_OPENID', 'BOB_FULL_OPENID', 'DAN_FULL_OPENID']) expect(f.inputs[0]).toContain(id);
  expect(f.inputs[0]).toContain('平台提供的完整引用正文');
  expect(f.inputs[0]).not.toContain('<@BOT_FULL_OPENID>');
  await f.send({ content: '<@BOT_FULL_OPENID> 现在再查同名群员' });
  const result=JSON.parse(f.inputs[2]!.split('\n')[1]!);
  expect(result.members.map((member:{member_openid:string})=>member.member_openid)).toEqual(['BOB_FULL_OPENID','DAN_FULL_OPENID']);
  expect(f.delivered.mock.calls.map(call=>call[1])).toEqual(['两位同名群员有不同的完整OpenID。']);
  expect((await f.store.read()).values.access.owners).toEqual([]);
});

it('the current-group members command returns all duplicate names and supports an exact full ID', async () => {
  const f = conversation();
  for (const id of ['BOB_FULL_OPENID', 'DAN_FULL_OPENID']) await f.send({ rawEventType: 'GROUP_MESSAGE_CREATE', senderId: id, senderName: '同名', content: '普通群消息', mentions: [] });
  await f.send({ content: '<@BOT_FULL_OPENID> /members 同名' });
  const result = JSON.parse(String(f.delivered.mock.calls[0]?.[1]));
  expect(result).toMatchObject({ group_openid: f.peer.openid, source: 'directory', complete: false });
  expect(result.members.map((member: { member_openid: string }) => member.member_openid)).toEqual(['BOB_FULL_OPENID', 'DAN_FULL_OPENID']);
  await f.send({ content: '<@BOT_FULL_OPENID> /members --id DAN_FULL_OPENID' });
  const exact = JSON.parse(String(f.delivered.mock.calls[1]?.[1]));
  expect(exact.members).toEqual([{ member_openid: 'DAN_FULL_OPENID', username: '同名', bot: false }]);
  expect(f.inputs).toEqual([]);
});

it('agent-bound lookup cannot cross groups, run in C2C, or survive revoked group access', async () => {
  const f = conversation();
  await f.send({ rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'BOB_FULL_OPENID', senderName: '小明', content: '普通群消息', mentions: [] });
  await f.store.mutate(state => {
    state.peers[peerKey(f.peer.appId, f.peer.scope, f.peer.openid)] = f.peer;
    const direct = { ...f.peer, scope: 'c2c' as const, agentId: 'direct-agent' };
    state.peers[peerKey(direct.appId, direct.scope, direct.openid)] = direct;
    state.groupMembers[JSON.stringify([f.peer.appId, 'OTHER_GROUP'])] = { OTHER_MEMBER: { member_openid: 'OTHER_MEMBER', username: '小明' } };
  });
  const result = await f.gateway.queryGroupMembers(f.peer.agentId, { nickname: '小明' });
  expect(result.members).toEqual([{ member_openid: 'BOB_FULL_OPENID', username: '小明', bot: false }]);
  await expect(f.gateway.queryGroupMembers('direct-agent', {})).rejects.toThrow('仅支持当前 QQ 群会话');
  await expect(f.gateway.queryGroupMembers('unknown-agent', {})).rejects.toThrow('仅支持当前 QQ 群会话');
  await f.store.mutate(state => { state.access.groupMode = 'disabled'; });
  await expect(f.gateway.queryGroupMembers(f.peer.agentId, {})).rejects.toThrow('当前群已不允许机器人访问');
});

it('rejects a peer migrated to another host during refresh even when its agent ID is unchanged', async () => {
  const f = conversation();
  const key = peerKey(f.peer.appId, f.peer.scope, f.peer.openid);
  await f.store.mutate(state => { state.peers[key] = f.peer; });
  expect(await f.gateway.queryGroupMembers(f.peer.agentId, {})).toMatchObject({ source: 'directory', complete: false });
  vi.spyOn(f.internal.bot.api, 'get').mockImplementation(async () => {
    await f.store.mutate(state => { state.peers[key]!.hostId = 'another-host'; });
    return { members: [{ member_openid: 'BOB_FULL_OPENID' }], next_cursor: '' };
  });
  await expect(f.gateway.queryGroupMembers(f.peer.agentId, { refresh: true })).rejects.toBeInstanceOf(Error);
});
