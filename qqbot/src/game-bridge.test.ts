import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { MiddlewareContext, QQBot, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { OmpAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey, type Peer } from './state.ts';
import type { Game } from './game-api.ts';
import { testEngine, testEngineDirectory } from '../tests/game-fixture.ts';
import { GAME_PROTOCOL, parseGameOutput, executeGameAction } from './game-bridge.ts';
import { gameInspect } from './rpc.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture(responses: string[], enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-bridge-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'fixture.sqlite');
  const { createGame, openStore, data, stats } = await testEngine(root);
  const random = vi.fn(() => 0);
  const game = createGame({ databasePath, now: () => Date.parse('2026-11-13T01:00:00Z'), random });
  let values = StateSchema.parse({ config: { appId: 'app', game: { enabled, engineDirectory: testEngineDirectory }, streaming: false, autoCompactTokens: 0 }, access: { commandMode: 'allowlist', owners: [{ openid: 'iris', scene: 'group', groupOpenid: 'group', claimedAt: 1 }] } });
  const store = new StateStore({ get: async () => ({ revision: 0, values: structuredClone(values) }), patch: async (patch: unknown) => { values = StateSchema.parse(patch); return { revision: 0, values }; } } as PluginStorage);
  const ctx = { signal: new AbortController().signal, installation: { id: 'bridge-test', generation: 1 }, omp: { hostId: 'host', agents: { create: async () => {
    let text='';
    const snapshot={pendingPermissions:[],activeTurn:null,status:'idle'};
    return {id:'review-child',observe:async()=>({snapshot,unsubscribe:()=>{},timeline:{}}),
      run:async()=>{const response=responses.shift();if(response===undefined)throw new Error('Fixture review response exhausted');text=response;return{status:'idle',error:null,final:snapshot};},
      timeline:{refetch:async()=>({entries:[{seqStart:1,seqEnd:1,item:{type:'assistant_message',text,messageId:'review-result'}}],error:null,hasOlder:false,hasNewer:false,gap:false})},
      stop:async()=>{},archive:async()=>({archivedAt:'2026-11-14T00:00:00Z'}),respondToPermission:async()=>{}};
  } } } } as unknown as PluginServiceContext;
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-only', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
  cleanups.push(() => { gateway.dispose(); if (!enabled) game.close(); });
  const peer: Peer = { appId: 'app', scope: 'group', openid: 'group', hostId: 'host', workspaceId: 'workspace', agentId: 'agent', cwd: root, sandbox: { root }, preset: 'default', template: values.config.presets[0]!, protocolPrompt: enabled ? GAME_PROTOCOL : 'QQ', lastDeliveredSequence: 0 };
  let sequence = 0;
  const agent = { id: 'agent', refresh: vi.fn(async()=>({agent:{id:'agent',provider:'omp',model:'test/model',activeTurn:null}})), stop: vi.fn(async () => {}), send: vi.fn(async (_text: string, options: { messageId: string }) => {
    const response = responses.shift();
    if (response === undefined) throw new Error('Fixture response exhausted');
    const turnId = `turn-${++sequence}`;
    route.chain = route.chain.then(async () => {
      await event({ type: 'turn_started', turnId });
      await event({ type: 'timeline', turnId, item: { type: 'user_message', text: _text, clientMessageId: options.messageId } });
      // OMP emits a new canonical seq for each delta, with a stable messageId.
      // Splits deliberately cross JSON keys, string values and natural words.
      for(let offset=0;offset<response.length;offset+=7){
        await event({ type: 'timeline', turnId, item: { type: 'assistant_message', messageId: `assistant-${turnId}`, text: response.slice(offset,offset+7) } });
        expect(sent.mock.calls.every(call => !/game_action|game_answer|"scores"/.test(String(call[1])))).toBe(true);
      }
      await event({ type: 'turn_completed', turnId });
    }).catch(error => { for(const pending of route.pending.values())pending.fail(error); });
  }) };
  const route = { peer, agent, unsubscribe: null, buffer: null, textRows: new Map(), files: new Map(), toolRevisions: new Map(), chain: Promise.resolve(), pending: new Map(), lastSeq: 0, enabledDelivery: false };
  const internal = gateway as unknown as { bot: QQBot & { handleInboundMessage(message: Omit<QQBotInboundMessage,'replyTarget'>): Promise<void> }; game: Game | null; routes: Map<string, typeof route>; getOrCreate: () => Promise<typeof route>; message: (context: MiddlewareContext) => Promise<void>; event: (route: typeof route, stream: OmpAgentStream) => Promise<void>; sender: { sendMarkdown: (...args: unknown[]) => Promise<unknown> }; authorized: (peer: Peer, sender: string, command?: boolean) => Promise<boolean>; cardAuthorized: (peer: Peer, sender: string, approval?: boolean) => Promise<boolean> };
  internal.game = enabled ? game : null;
  internal.routes.set(peerKey('app', 'group', 'group'), route);
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  const sent = vi.spyOn(internal.sender, 'sendMarkdown').mockResolvedValue(undefined);
  const event = (event: OmpAgentStream['event'], seq = ++sequence) => internal.event(route, { event, seq } as OmpAgentStream);
  const message = (text: string, senderId = 'player') => internal.message({ bot: internal.bot, replyTarget: { scope: 'group', targetId: 'group', msgId: `${senderId}-${text}` }, message: { kind: 'group', groupOpenid: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: `${senderId}-${text}`, timestamp: '2026-11-13T01:00:00Z', content: text, senderId, senderName: senderId, senderIsBot: false, mentions: [], raw: { author: { member_openid: senderId }, group_openid: 'group' } }, state: {} } as unknown as MiddlewareContext);
  let messageIndex=0;
  const ingest=(text:string,senderId='player',mentions:NonNullable<QQBotInboundMessage['mentions']>=[])=>internal.bot.handleInboundMessage({kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',groupOpenid:'group',messageId:`inbound-${++messageIndex}`,timestamp:'2026-11-13T01:00:00Z',senderId,senderName:'同名',senderIsBot:false,content:`<@app> ${text}`,mentions:[{id:'app',is_you:true},...mentions],raw:{id:`raw-${messageIndex}`,group_openid:'group',author:{member_openid:senderId},content:text,timestamp:'2026-11-13T01:00:00Z'}});
  const player = (userId = 'player') => game.getPlayer(peerKey('app', 'group', 'group'), userId);
  const ready = () => {
    game.handleCommand({ groupId: peerKey('app', 'group', 'group'), userId: 'player', text: '我要修仙' });
    const current = player()!;
    current.realm = 1; current.exp = Math.floor(data.realms[2].exp * 1.2); current.hp = Math.floor(current.exp / 2); current.mp = Math.floor(current.exp / 4);
    const storage = openStore(databasePath);
    try { storage.save(peerKey('app', 'group', 'group'), current); } finally { storage.close(); }
    game.handleCommand({ groupId: peerKey('app', 'group', 'group'), userId: 'player', text: '突破' });
  };
  return { gateway, internal, game, store, route, agent, sent, message, ingest, event, player, ready, random, stats };
}

it.each([
  '{"type":"game_action","command":"状态","userId":"iris"}',
  '{"type":"game_action","command":"状态","path":"/tmp/state"}',
  '{"type":"game_action","command":"状态","engineDirectory":"/tmp/engine"}',
  '{"type":"game_action","command":"状态","random":0}',
  '```json\n{"type":"game_action","command":"状态"}\n```',
  '已执行。{"type":"game_action","command":"状态"}',
  '{"type":"game_act',
])('quarantines malformed, mixed or extended protocol: %s', text => {
  expect(parseGameOutput(text)).toEqual({ type: 'invalid' });
});
it('keeps ordinary chat outside the game action boundary', () => {
  expect(parseGameOutput('你好，今天想聊什么？')).toEqual({ type: 'text', text: '你好，今天想聊什么？' });
  expect(parseGameOutput('{"type":"game_action","command":"状态"}')).toEqual({ type: 'action', action: { type: 'game_action', command: '状态' } });
  const json='{"hello":"world"}';const fenced=`\`\`\`json\n${json}\n\`\`\``;
  expect(parseGameOutput(json)).toEqual({type:'text',text:json});
  expect(parseGameOutput(fenced)).toEqual({type:'text',text:fenced});
});

it('natural language and a typo produce real bounded actions for the original player only', async () => {
  const f = await fixture(['{"type":"game_action","command":"我要修仙"}', '{"type":"game_action","command":"我的状态"}', '你已加入仙途，这是当前状态。']);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.ingest('想开始修仙，然后看看状太');
  expect(run.mock.calls.map(call => call[0].text)).toEqual(['我要修仙', '我的状态']);
  expect(run.mock.calls.every(call => call[0].groupId === peerKey('app', 'group', 'group') && call[0].userId === 'player')).toBe(true);
  expect(f.player()).not.toBeNull(); expect(f.player('iris')).toBeNull();
  expect(f.agent.send.mock.calls[1]?.[0]).toContain('插件宿主真实游戏结果');
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['你已加入仙途，这是当前状态。']);
});
it('routes a migrated natural-language request through the fixed engine', async () => {
  const f = await fixture(['{"type":"game_action","command":"灵庄帮助"}', '灵庄玩法已由游戏引擎返回。']);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.message('灵庄要怎么玩？');
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].text).toBe('灵庄帮助');
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['灵庄玩法已由游戏引擎返回。']);
});
it('recognized commands execute without model interpretation and ordinary players bypass command allowlist', async () => {
  const f = await fixture(['签到结果已收到。']);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.ingest('/修仙签到');
  expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0]?.[0].text).toBe('修仙签到');
  expect(await f.internal.authorized(f.route.peer, 'player', true)).toBe(false);
  expect(await f.internal.authorized(f.route.peer, 'player')).toBe(true);
});
it.each([true, false])('ordinary chat never invokes the game (enabled=%s)', async enabled => {
  const f = await fixture(['今天过得怎么样？'], enabled);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.ingest('你好呀');
  expect(run).not.toHaveBeenCalled(); expect(f.sent.mock.calls.map(call => call[1])).toEqual(['今天过得怎么样？']);
});
it('pending breakthrough does not swallow chat, but the original natural short answer enters full review', async () => {
  const answer = '慢';
  const review = { scores: { experience: { value: 0, quote: '', factIds: [] }, problem: { value: 1, quote: answer }, reason: { value: 1, quote: answer }, change: { value: 2, quote: answer } }, feedback: '你找到了原因，也说出了改变。', followUp: null };
  const f = await fixture(['你好，先聊聊也可以。', '{"type":"game_answer","answer":"慢"}', JSON.stringify(review), '突破问答评分已经由游戏确认。']);
  f.ready();
  f.random.mockClear();
  const before = structuredClone(f.player());
  await f.message('你好');
  expect(f.player()).toEqual(before);
  expect(f.random).not.toHaveBeenCalled();
  const resolve = vi.spyOn(f.game, 'resolveReview');
  const execute = vi.spyOn(f.game, 'handleMessage');
  await f.message(answer);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({ groupId: peerKey('app', 'group', 'group'), userId: 'player', kind: 'breakthrough', requestId: before!.breakthroughTrial!.id, revision: 1, review });
  const settled = f.player()!;
  expect(settled.breakthroughTrial!.answers).toEqual([answer]);
  expect(settled.breakthroughTrial!.status).toBe('settled');
  expect(settled.realm).toBe(before!.realm + 1);
  expect(settled.exp).toBe(before!.exp);
  expect(settled.money).toBe(before!.money);
  expect(settled.inventory).toEqual(before!.inventory);
  const attributes = f.stats(settled);
  expect(settled.hp).toBe(attributes.maxHp);
  expect(settled.mp).toBe(attributes.maxMp);
  expect(settled.hp).toBeGreaterThan(before!.hp);
  expect(settled.mp).toBeGreaterThan(before!.mp);
  expect(settled.breakthroughAt).toBe(Date.parse('2026-11-13T01:00:00Z'));
  expect(settled.breakthroughBonus).toBe(0);
  expect(settled.pillBonus).toBe(0);
  expect(settled.breakthroughTrial!.lastAttempt).toMatchObject({ success: true, loss: 0, protectedAttempt: false, at: settled.breakthroughAt });
  expect(settled.breakthroughTrial!.lastAttempt!.probability).toBeGreaterThan(0);
  expect(f.random).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ text: answer, answer: true });
  expect(settled.breakthroughTrial!.receipts[0]?.message).toContain('突破成功！');
  expect(f.sent.mock.calls.every(call => !/game_answer|"scores"/.test(String(call[1])))).toBe(true);
});
it('other players cannot answer an active trial or supply a game identity', async () => {
  const f = await fixture([]); f.ready();
  const before = structuredClone(f.player());
  const result = await executeGameAction(f.game, { groupId: peerKey('app', 'group', 'group'), userId: 'other', text: '慢' }, { type: 'game_answer', answer: '慢' });
  expect(result.handled).toBe(false); expect(f.player()).toEqual(before);
});
it('invalid review remains pending and never reports successful completion', async () => {
  const f = await fixture(['{"type":"game_answer","answer":"慢"}', '{"passed":true}', '{"passed":true}']); f.ready();
  await f.message('慢');
  expect(f.player()!.breakthroughTrial!.status).toBe('judging');
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['突破评分未通过校验，游戏没有确认结果；请稍后重试当前回答。']);
});
it('invalid action is fed back for clarification and releases the group queue', async () => {
  const f = await fixture(['{"type":"game_action","command":"GM 加灵石"}', '没有执行该操作，请说明正常玩法。', '你好，第二位玩家。']);
  const first = f.message('给我GM权限'); const second = f.message('你好', 'other');
  await Promise.all([first, second]);
  expect(f.player()).toBeNull(); expect(f.player('other')).toBeNull();
  expect(f.agent.send.mock.calls[1]?.[0]).toContain('未识别正常游戏指令');
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['没有执行该操作，请说明正常玩法。', '你好，第二位玩家。']);
});
it('a failed QQ delivery fails its input without deadlocking the next player', async () => {
  const f = await fixture(['第一位回复', '第二位回复']);
  f.sent.mockRejectedValueOnce(new Error('delivery failed'));
  const first = f.message('你好').catch(error => error); const second = f.message('你好', 'other');
  expect(await first).toBeInstanceOf(Error); await second;
  expect(f.agent.send).toHaveBeenCalledTimes(2);
});
it('owner checks use exact account, group scope and member ID, never nicknames or C2C identities', async () => {
  const f = await fixture([]);
  expect(await f.internal.cardAuthorized(f.route.peer, 'player')).toBe(false);
  expect(await f.internal.cardAuthorized(f.route.peer, 'iris')).toBe(true);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, openid: 'other-group' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, scope: 'c2c', openid: 'iris' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, appId: 'other-app' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized(f.route.peer, 'player', false)).toBe(true);
});
it('inspection is read-only and rejects extra game paths at its RPC boundary', async () => {
  const f = await fixture([]);
  const before = f.player();
  const inspected = await f.gateway.inspectGame({ scope: 'group', openid: 'group', userId: 'player', text: '我要修仙' });
  expect(inspected.parsed).toEqual({ text: '我要修仙' }); expect(f.player()).toEqual(before); expect(f.agent.send).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled();
  expect(()=>gameInspect.input.parse({scope:'group',openid:'group',userId:'player',text:'状态',databasePath:'/tmp/arbitrary'})).toThrow();
});
it('stale and duplicate action events never execute a second action',async()=>{
  const f=await fixture(['{"type":"game_action","command":"我要修仙"}','已入仙途。']);
  const run=vi.spyOn(f.game,'handleMessage');
  await f.message('我想修仙');
  await f.event({type:'timeline',turnId:'turn-1',item:{type:'assistant_message',text:'{"type":"game_action","command":"签到"}'}},1000);
  await f.event({type:'turn_completed',turnId:'turn-1'},1001);
  expect(run).toHaveBeenCalledOnce();
  expect(f.sent.mock.calls.map(call=>call[1])).toEqual(['已入仙途。']);
});
it.each(['cancel','foreign','missing-turn'] as const)('an invalidated %s input cannot execute and releases its queue',async kind=>{
  const f=await fixture(['下一位正常回复']);
  const run=vi.spyOn(f.game,'handleMessage');
  f.agent.send.mockImplementationOnce(async(text,options)=>{
    const turnId=kind==='missing-turn'?undefined:'bound-turn';
    await f.event({type:'turn_started',turnId},1);
    await f.event({type:'timeline',turnId,item:{type:'user_message',text,clientMessageId:options.messageId}},2);
    if(kind==='foreign')await f.event({type:'timeline',turnId,item:{type:'user_message',text:'other player',clientMessageId:'external-message'}},3);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',text:'{"type":"game_action","command":"我要修仙"}'}},4);
    await f.event({type:kind==='cancel'?'turn_canceled':'turn_completed',turnId},5);
  });
  const first=f.message('我想修仙').catch(error=>error);
  const second=f.message('你好','other');
  expect(await first).toBeInstanceOf(Error);await second;
  expect(run).not.toHaveBeenCalled();expect(f.player()).toBeNull();
  expect(f.agent.send).toHaveBeenCalledTimes(2);
  expect(f.sent.mock.calls.every(call=>!/game_action/.test(String(call[1])))).toBe(true);
});
it('real middleware denies bot management slash commands while preserving normal player commands',async()=>{
  const f=await fixture(['已收到修仙签到结果。']);
  const run=vi.spyOn(f.game,'handleMessage');
  await f.ingest('/reset');
  expect(f.agent.send).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  expect(f.sent.mock.calls[0]?.[1]).toBe('该发送者没有斜杠命令权限。');
  await f.ingest('/修仙签到');
  expect(run).toHaveBeenCalledOnce();
});
it('target binding accepts only an explicit group member mention, not nickname or user_openid fallback',async()=>{
  const f=await fixture(['{"type":"game_action","command":"切磋"}','已收到游戏结果。']);
  const run=vi.spyOn(f.game,'handleMessage');
  await f.ingest('跟提及的同名玩家切磋','player',[{member_openid:'group-member',nickname:'同名'},{user_openid:'c2c-id',nickname:'同名'}]);
  expect(run.mock.calls[0]?.[0]).toMatchObject({groupId:peerKey('app','group','group'),userId:'player',targetId:'group-member',text:'切磋'});
  expect(run.mock.calls[0]?.[0].targetId).not.toBe('c2c-id');
});
it('never executes protocol assembled from two distinct assistant messages',async()=>{
  const f=await fixture(['未执行该动作，请重新说明。']);
  const run=vi.spyOn(f.game,'handleMessage');
  f.agent.send.mockImplementationOnce(async(text,options)=>{
    const turnId='split-message-turn';
    await f.event({type:'turn_started',turnId},1);
    await f.event({type:'timeline',turnId,item:{type:'user_message',text,clientMessageId:options.messageId}},2);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',messageId:'first-message',text:'{"type":"game_action",'}},3);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',messageId:'second-message',text:'"command":"我要修仙"}'}},4);
    await f.event({type:'turn_completed',turnId},5);
  });
  await f.message('我想修仙');
  expect(run).not.toHaveBeenCalled();expect(f.player()).toBeNull();
  expect(f.sent.mock.calls.map(call=>call[1])).toEqual(['未执行该动作，请重新说明。']);
});

it('pending rift action is routed through strict host review and advances one scene', async () => {
  const action = '贴着石壁观察符纹，再用碎石试探雾中脚步。';
  const review = { outcome: 'success', reason: '行动同时处理了符纹和雾中威胁。', narrative: '碎石触发一道暗光，你借石壁掩护穿过了灵雾。' };
  const f = await fixture([
    JSON.stringify({ type: 'game_answer', answer: action }),
    JSON.stringify(review),
    '你破开了入口危机，已进入第二幕。'
  ]);
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'player', nickname: 'player', text: '我要修仙' });
  f.game.handleCommand({ groupId, userId: 'player', nickname: 'player', text: '秘境探索' });
  const resolve = vi.spyOn(f.game, 'resolveReview');
  await f.message(action);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({
    groupId, userId: 'player', kind: 'rift', requestId: f.player()!.riftAdventure!.id, revision: 1, review
  });
  expect(f.player()!.riftAdventure).toMatchObject({ status: 'awaiting', round: 1, score: 2 });
  expect(f.player()!.riftAdventure!.history[0]?.action).toBe(action);
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['你破开了入口危机，已进入第二幕。']);
});
