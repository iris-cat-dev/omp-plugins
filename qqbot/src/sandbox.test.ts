import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createActivationScope, createPluginOmpApi } from '@omp-desktop/plugin/server';
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import type * as Os from 'node:os';
import { basename, join, parse } from 'node:path';
import type { PluginInstallation, PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { OmpApi, OmpAgentHandle, OmpAgentCreateOptions, OmpAgentObservation, OmpAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey, type Peer } from './state.ts';
import * as media from './media.ts';
import { testEngineDirectory } from '../tests/game-fixture.ts';

const isolatedHome = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, homedir: () => isolatedHome.path ?? actual.homedir() };
});
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); isolatedHome.path=null;vi.restoreAllMocks(); });


const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
interface AgentDirectoryFixture {
  entries: Array<{ agent: { id: string; sandbox?: Peer['sandbox'] } }>;
  pageInfo: { nextCursor: string | null; prevCursor: null; hasMore: boolean };
}
interface DownloadedSandboxAttachment { path: string; relativePath: string; mimeType: string; size: number }
async function fixture(sandboxPath?: string, provider = 'omp', presentedFiles = false, sandboxCapabilities?: { javascript: boolean; network: boolean; imageGeneration?: boolean }, gameEnabled = false, engineDirectory = gameEnabled ? testEngineDirectory : '') {
  const directory = await mkdtemp(join(tmpdir(), 'qq-sandbox-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const key = peerKey('saved-app', 'c2c', 'peer');
  let values = StateSchema.parse({ config: { appId: 'saved-app', sandboxPath: sandboxPath ?? root, sandboxCapabilities, streaming:false,autoCompactTokens:0,game: { enabled: gameEnabled, engineDirectory }, sendFile: { sendPresentedFiles: presentedFiles, extraRoots: ['/outside'] }, presets: [{ name: 'default', config: { provider, modeId: 'full', thinkingOptionId: 'high', systemPrompt: 'Keep prompt' }, qq: { prompt: 'QQ context' } }] }, modelSelections: { [key]: 'provider/model' }, credentialVersions: { 'saved-app': 1 } });
  let revision = 0;
  const storage = { get: async () => ({ revision, values: structuredClone(values) }), patch: async (patch: unknown, expected: number) => { if (expected !== revision) throw new Error('STORAGE_REVISION_CONFLICT'); values = StateSchema.parse(patch); return { revision: ++revision, values }; } } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const old = { id: 'old-agent', stop: vi.fn(async () => {}), refresh: vi.fn(async () => ({ agent: { id: 'old-agent', sandbox: undefined as Peer['sandbox'] } })) };
  const list = vi.fn(async (_options?: { page?: { cursor?: string } }): Promise<AgentDirectoryFixture> => ({ entries: [await old.refresh()], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }));
  const unsubscribe = vi.fn();
  const fresh = { id: 'new-agent', stop: vi.fn(async () => {}), observe: vi.fn(async () => ({ snapshot: { sandbox: { root }, pendingPermissions: [], activeTurn: null }, timeline: { window: { maxSeq: 0 }, entries: [] }, unsubscribe } as unknown as OmpAgentObservation)) };
  const create = vi.fn(async (_options: OmpAgentCreateOptions) => fresh as unknown as OmpAgentHandle);
  const occupiedWorkspaces = new Set<string>();
  let workspaceSequence = 0;
  const workspace = (id: string) => ({ id, agents: { create: async (options: OmpAgentCreateOptions) => {
    if (occupiedWorkspaces.has(id)) throw new Error('Workspace already has an unarchived root agent');
    const agent = await create(options);
    occupiedWorkspaces.add(id);
    return agent;
  } } });
  const open = vi.fn(async (_path: string) => workspace('directory-workspace'));
  const createWorkspace = vi.fn(async () => workspace(`workspace-${++workspaceSequence}`));
  const native = { invoke: vi.fn(async (_operation: string, input: unknown):Promise<unknown> => { if(!input||typeof input!=='object'||!('action' in input))throw new Error('Missing native action');if(input.action==='open')return{handle:'pinned-handle'};if(input.action==='close')return{ok:true};if(input.action==='read')return{contentBase64:Buffer.from('inside-media').toString('base64')};throw new Error(`Unexpected native action: ${String(input.action)}`); }) };
  const scope = createActivationScope(1);
  cleanups.push(() => scope.dispose());
  const installation: PluginInstallation = { id: 'installation', packageId: packageMetadata.name, owner: 'daemon', version: packageMetadata.version, generation: scope.generation, enabled: true, declaredCapabilities: packageMetadata.ompDesktop.capabilities, grantedCapabilities: packageMetadata.ompDesktop.capabilities };
  const omp = createPluginOmpApi({ hostId: 'host', agents: { list, ref: vi.fn(() => old) }, workspaces: { open, create: createWorkspace } } as unknown as OmpApi, installation, scope, { mode: 'active' });
  const ctx = { signal: scope.signal, installation, native, omp } as unknown as PluginServiceContext;
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
  cleanups.push(() => gateway.dispose());
  const internal = gateway as unknown as { getOrCreate(scope: 'c2c' | 'group', openid: string, reset?: boolean): Promise<{ peer: Peer; agent: OmpAgentHandle }>; routes: Map<string, unknown>; event(route: unknown, stream: OmpAgentStream): Promise<void>; deliverFile(route:unknown,path:string,type:string,target:unknown):Promise<void>; sender: { sendMarkdown: (...args: unknown[]) => Promise<unknown> }; bot: { start():Promise<void>;sendImage:(...args:unknown[])=>Promise<unknown>;apiClient: { request: (...args: unknown[]) => Promise<unknown> } }; deliveryRoute: { run<T>(route: unknown, callback: () => T): T } };
  const saved = (sandbox?: Peer['sandbox']): Peer => ({ appId: 'saved-app', scope: 'c2c', openid: 'peer', hostId: 'host', workspaceId: 'old-workspace', agentId: old.id, cwd: sandbox?.root ?? root, sandbox, preset: 'default', template: values.config.presets[0]!, protocolPrompt: 'Old QQ context', protocolVersion: 2, lastDeliveredSequence: 4 });
  return { ctx, root, key, store, old, fresh, create, internal, gateway, unsubscribe, saved, native, list, occupiedWorkspaces };
}

interface ReplyFixture {key:string;internal:{routes:Map<string,unknown>;event(route:unknown,stream:OmpAgentStream):Promise<void>}}
async function emitReply(f:ReplyFixture,id:string,text:string){
  const route=f.internal.routes.get(f.key)!;const turnId=`turn-${id}`;
  await f.internal.event(route,{event:{type:'turn_started',turnId}} as OmpAgentStream);
  await f.internal.event(route,{seq:5,event:{type:'timeline',turnId,item:{type:'user_message',text:'maintenance or QQ input',clientMessageId:id}}} as OmpAgentStream);
  await f.internal.event(route,{seq:6,event:{type:'timeline',turnId,item:{type:'assistant_message',messageId:`reply-${id}`,text}}} as OmpAgentStream);
  await f.internal.event(route,{seq:7,event:{type:'turn_completed',turnId}} as OmpAgentStream);
}

it('legacy startup leaves the active turn running and the first admitted input migrates with a consumed handoff',async()=>{
  const f=await fixture();const sandbox={root:f.root};
  const saved=f.saved(sandbox);delete saved.protocolVersion;
  await f.store.mutate(state=>{state.peers[f.key]=saved;});
  const waiting=Promise.withResolvers<void>();const finish=Promise.withResolvers<void>();
  const waitForFinish=vi.fn(async()=>{waiting.resolve();await finish.promise;return{status:'idle',error:null};});
  f.old.refresh.mockResolvedValue(Object.assign({agent:{id:f.old.id,sandbox}},{agent:{id:f.old.id,sandbox,activeTurn:{turnId:'already-running'}}}));
  const archive=vi.fn();
  Object.assign(f.old,{observe:f.fresh.observe,waitForFinish,archive,send:async(_text:string,options:{messageId:string})=>emitReply(f,options.messageId,JSON.stringify({memory:'CAROL_FULL_OPENID 偏好简短回复，附件为 source.png。',activeTasks:['完成当前图片修改']}))});
  Object.assign(f.fresh,{send:async(_text:string,options:{messageId:string})=>emitReply(f,options.messageId,'图片修改请求已接收。')});
  const delivered=vi.spyOn(f.internal.sender,'sendMarkdown').mockResolvedValue(undefined);
  vi.spyOn(f.internal.bot,'start').mockResolvedValue();
  await writeFile(join(f.root,'source.png'),'retained attachment');
  await f.gateway.start();
  expect(f.old.stop).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
  const internal=f.gateway as unknown as {message(context:unknown):Promise<void>};
  const work=internal.message({replyTarget:{scope:'c2c',targetId:'peer',msgId:'current-message'},message:{kind:'c2c',senderId:'peer',content:'继续改图'},state:{envelope:'继续改图'}});
  await waiting.promise;
  expect(f.old.stop).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
  await f.store.mutate(state=>{state.modelSelections[f.key]='provider/current-model';});
  finish.resolve();await work;
  const state=(await f.store.read()).values;
  expect(state.peers[f.key]).toMatchObject({agentId:f.fresh.id,protocolVersion:2,cwd:f.root});
  expect(state.peers[f.key]!.handoff).toBeUndefined();
  expect(state.modelSelections[f.key]).toBe('provider/current-model');
  expect(delivered.mock.calls.map(call=>call[1])).toEqual(['图片修改请求已接收。']);
  expect(f.old.stop).toHaveBeenCalledOnce();expect(archive).not.toHaveBeenCalled();
  expect((await stat(join(f.root,'source.png'))).isFile()).toBe(true);
});

it('invalid legacy handoff leaves the saved conversation intact and never replies its JSON to QQ',async()=>{
  const f=await fixture();const sandbox={root:f.root};const saved=f.saved(sandbox);delete saved.protocolVersion;
  await f.store.mutate(state=>{state.peers[f.key]=saved;});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox}});
  Object.assign(f.old,{observe:f.fresh.observe,send:async(_text:string,options:{messageId:string})=>emitReply(f,options.messageId,'{"type":"member_query","refresh":true}')});
  const delivered=vi.spyOn(f.internal.sender,'sendMarkdown').mockResolvedValue(undefined);
  const result=await f.internal.getOrCreate('c2c','peer').catch(error=>error);
  expect(result).toBeInstanceOf(Error);
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe(f.old.id);
  expect(f.create).not.toHaveBeenCalled();expect(f.old.stop).not.toHaveBeenCalled();expect(delivered).not.toHaveBeenCalled();
});

it('creates mandatory sandbox with safe approval while preserving saved model and prompts', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  expect(f.create.mock.calls[0]?.[0].config).toMatchObject({ cwd: f.root, sandbox: { root: f.root }, modeId: 'ask', provider: 'omp/provider/model', thinkingOptionId: 'high' });
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).toContain('Keep prompt');
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).toContain('QQ context');
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).not.toContain(f.root);
  expect(route.peer.sandbox).toEqual({ root: f.root });
  await expect(f.gateway.sendFile(route.peer.agentId, '../outside', 'file')).rejects.toThrow('qqbot_send_file');
});

it('keeps private and group peers independent in one sandbox, including group reset', async () => {
  const f = await fixture();
  const snapshots: AgentDirectoryFixture['entries'] = [];
  f.create.mockImplementation(async () => {
    const agent = { ...f.fresh, id: `peer-agent-${snapshots.length + 1}`, stop: vi.fn(async () => {}) };
    snapshots.push({ agent: { id: agent.id, sandbox: { root: f.root } } });
    return agent as unknown as OmpAgentHandle;
  });
  f.list.mockImplementation(async () => ({ entries: snapshots, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }));
  const direct = await f.internal.getOrCreate('c2c', 'peer');
  const group = await f.internal.getOrCreate('group', 'peer');
  expect(group.peer.agentId).not.toBe(direct.peer.agentId);
  expect(group.peer.workspaceId).not.toBe(direct.peer.workspaceId);
  expect(group.peer.sandbox).toEqual(direct.peer.sandbox);
  expect((await f.internal.getOrCreate('group', 'peer')).peer.agentId).toBe(group.peer.agentId);
  const reset = await f.internal.getOrCreate('group', 'peer', true);
  expect(reset.peer.workspaceId).not.toBe(group.peer.workspaceId);
  expect(reset.peer.workspaceId).not.toBe(direct.peer.workspaceId);
  expect(reset.peer.agentId).not.toBe(group.peer.agentId);
  expect(f.occupiedWorkspaces.has(group.peer.workspaceId)).toBe(true);
  const saved = (await f.store.read()).values.peers;
  expect(saved[f.key]?.agentId).toBe(direct.peer.agentId);
  expect(saved[peerKey('saved-app', 'group', 'peer')]?.agentId).toBe(reset.peer.agentId);
  expect(saved[peerKey('saved-app', 'group', 'peer')]?.sandbox).toEqual({ root: f.root });
});

it.each([{ javascript: true, network: false, imageGeneration: false }, { javascript: false, network: true, imageGeneration: false }, { javascript: true, network: true, imageGeneration: false }, { javascript: false, network: false, imageGeneration: true }])('replaces an unchanged-root peer when capabilities change to %s', async capabilities => {
  const f = await fixture(undefined, 'omp', false, capabilities);
  const sandbox: NonNullable<Peer['sandbox']> = { root: f.root };
  if(capabilities.javascript)sandbox.javascript=true;
  if(capabilities.network)sandbox.network='public';
  if(capabilities.imageGeneration)sandbox.imageGeneration=true;
  await f.store.mutate(state => { state.peers[f.key] = f.saved({ root: f.root }); });
  f.old.refresh.mockResolvedValue({ agent: { id: f.old.id, sandbox: { root: f.root } } });
  f.fresh.observe.mockResolvedValue({ snapshot: { sandbox, pendingPermissions: [], activeTurn: null }, timeline: { window: { maxSeq: 0 }, entries: [] }, unsubscribe: f.unsubscribe } as unknown as OmpAgentObservation);
  const route = await f.internal.getOrCreate('c2c', 'peer');
  expect(route.peer.agentId).toBe(f.fresh.id);
  expect(route.peer.sandbox).toEqual(sandbox);
  expect(f.old.stop.mock.invocationCallOrder[0]).toBeLessThan(f.create.mock.invocationCallOrder[0]!);
  expect((await f.internal.getOrCreate('c2c', 'peer')).peer.agentId).toBe(route.peer.agentId);
  expect(f.create).toHaveBeenCalledOnce();
});

it('refuses an SDK observation that confirms only the root but omits requested capabilities', async () => {
  const f = await fixture(undefined, 'omp', false, { javascript: true, network: true });
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('Desktop agent');
  expect(f.fresh.stop).toHaveBeenCalled();
});

it.each(['legacy', 'moved-root', 'unsupported-agent'] as const)('stops %s peer before replacement without deleting its history', async kind => {
  const f = await fixture();
  const peer = f.saved(kind === 'legacy' ? undefined : { root: kind === 'moved-root' ? join(f.root, 'old') : f.root });
  await f.store.mutate(state => { state.peers[f.key] = peer; });
  const stopped = Promise.withResolvers<void>();
  f.old.stop.mockImplementation(() => stopped.promise);
  const work = f.internal.getOrCreate('c2c', 'peer');
  await vi.waitFor(() => expect(f.old.stop).toHaveBeenCalledOnce());
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe('old-agent');
  stopped.resolve();
  expect((await work).peer.agentId).toBe('new-agent');
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('does not create a replacement if stopping the old agent fails', async () => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(); });
  f.old.stop.mockRejectedValue(new Error('stop failed'));
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('stop failed');
  expect(f.create).not.toHaveBeenCalled();
});

it.each(['legacy', 'confirmed'] as const)('startup recreates a missing %s agent and preserves account and preferences', async kind => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(kind === 'confirmed' ? { root: f.root } : undefined); });
  const before = (await f.store.read()).values;
  f.list.mockResolvedValue({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });
  vi.spyOn(f.internal.bot, 'start').mockResolvedValue();
  await f.gateway.start();
  const after = (await f.store.read()).values;
  expect(after.peers[f.key]).toMatchObject({ agentId: 'new-agent', sandbox: { root: f.root } });
  expect(f.old.stop).not.toHaveBeenCalled();
  expect(after.config).toEqual(before.config);
  expect(after.access).toEqual(before.access);
  expect(after.credentialVersions).toEqual(before.credentialVersions);
  expect(after.modelSelections).toEqual(before.modelSelections);
  expect(after.presetSelections).toEqual(before.presetSelections);
  expect(f.create.mock.calls[0]?.[0].config).toMatchObject({ sandbox: { root: f.root }, modeId: 'ask', provider: 'omp/provider/model', thinkingOptionId: 'high' });
});

it('stops an existing peer found on a later directory page before replacing it', async () => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(); });
  f.list.mockImplementation(async options => options?.page?.cursor === 'next'
    ? { entries: [await f.old.refresh()], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }
    : { entries: [{ agent: { id: 'other-agent', sandbox: undefined } }], pageInfo: { nextCursor: 'next', prevCursor: null, hasMore: true } });
  await f.internal.getOrCreate('c2c', 'peer');
  expect(f.old.stop).toHaveBeenCalledOnce();
  expect(f.old.stop.mock.invocationCallOrder[0]).toBeLessThan(f.create.mock.invocationCallOrder[0]!);
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe('new-agent');
});

it('does not recreate or rewrite a peer when its existence query fails', async () => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(); });
  f.list.mockRejectedValue(new Error('agent lookup denied'));
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('agent lookup denied');
  expect(f.old.stop).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe('old-agent');
});

it.each(['root', 'javascript', 'network', 'imageGeneration'] as const)('does not stop or recreate a peer after lookup outlives a %s config change', async kind => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(); });
  const queried = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<AgentDirectoryFixture>();
  f.list.mockImplementation(() => { queried.resolve(); return pending.promise; });
  const work = f.internal.getOrCreate('c2c', 'peer').catch(error => error);
  await queried.promise;
  await f.store.mutate(state => { if(kind === 'root')state.config.sandboxPath = join(f.root, 'next'); else state.config.sandboxCapabilities[kind] = true; });
  pending.resolve({ entries: [await f.old.refresh()], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });
  expect(await work).toBeInstanceOf(Error);
  expect(f.old.stop).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe('old-agent');
});

it('stops a stale create after root change and never stores or attaches it', async () => {
  const f = await fixture();
  const created = Promise.withResolvers<OmpAgentHandle>();
  const called = Promise.withResolvers<void>();
  f.create.mockImplementation(() => { called.resolve(); return created.promise; });
  const work = f.internal.getOrCreate('c2c', 'peer');
  const settled = work.catch(error => error);
  await called.promise;
  await f.store.mutate(state => { state.config.sandboxPath = join(f.root, 'next'); });
  created.resolve(f.fresh as unknown as OmpAgentHandle);
  expect(await settled).toBeInstanceOf(Error);
  expect(f.fresh.stop).toHaveBeenCalled();
  expect(f.fresh.observe).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]).toBeUndefined();
  expect(f.internal.routes.size).toBe(0);
});

it('rejects unconfirmed sandbox observation instead of reusing the route', async () => {
  const f = await fixture();
  f.fresh.observe.mockResolvedValue({ snapshot: { pendingPermissions: [], activeTurn: null }, timeline: { window: { maxSeq: 0 }, entries: [] }, unsubscribe: f.unsubscribe } as unknown as OmpAgentObservation);
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('未确认');
  expect(f.fresh.stop).toHaveBeenCalled();
  expect(f.unsubscribe).toHaveBeenCalled();
  expect(f.internal.routes.size).toBe(0);
});

it('blocks retired route events and SDK retry HTTP requests', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  f.internal.routes.delete(f.key);
  const send = vi.spyOn(f.internal.sender, 'sendMarkdown');
  await f.internal.event(route, { event: { type: 'turn_failed', error: 'HOST_SECRET' } } as unknown as OmpAgentStream);
  expect(send).not.toHaveBeenCalled();
  await expect(f.internal.deliveryRoute.run(route, () => f.internal.bot.apiClient.request('token', 'POST', '/v2/users/peer/messages', {}))).rejects.toThrow('generation');
});

it('blocks stale old-root delivery immediately after storage changes', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  await f.store.mutate(state => { state.config.sandboxPath = join(f.root, 'next'); });
  const send = vi.spyOn(f.internal.sender, 'sendMarkdown');
  await f.internal.event(route, { event: { type: 'turn_failed', error: 'HOST_SECRET' } } as unknown as OmpAgentStream);
  expect(send).not.toHaveBeenCalled();
  await expect(f.internal.bot.apiClient.request('token', 'POST', '/v2/users/peer/messages', {})).rejects.toThrow('沙箱配置');
});

it('rejects filesystem root and user home as sandbox roots', async () => {
  const f = await fixture();
  for (const broad of [homedir(), parse(f.root).root]) {
    await f.store.mutate(s => { s.config.sandboxPath = broad; });
    const config = (await f.store.read()).values.config;
    const ctx = { signal: new AbortController().signal, installation: { id: 'installation', generation: 1 }, omp: {} } as unknown as PluginServiceContext;
    const gateway = new Gateway(ctx, f.store, new Pairing(f.store), config, 'fixture-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
    cleanups.push(() => gateway.dispose());
    await expect(gateway.start()).rejects.toThrow('根目录或用户主目录');
  }
});

it('blank path creates a dedicated private directory in an isolated home', async () => {
  const f=await fixture('');isolatedHome.path=f.root;
  const expected=join(f.root,'.omp','qqbot-sandbox','installation');
  f.fresh.observe.mockResolvedValue({snapshot:{sandbox:{root:expected},pendingPermissions:[],activeTurn:null},timeline:{window:{maxSeq:0},entries:[]},unsubscribe:f.unsubscribe} as unknown as OmpAgentObservation);
  const route=await f.internal.getOrCreate('c2c','peer');
  expect(route.peer.sandbox?.root).toBe(expected);
  expect((await stat(expected)).mode&0o077).toBe(0);
  expect(f.native.invoke).toHaveBeenCalledWith('files.sandbox',{action:'open',root:expected,maxBytes:200*1024*1024});
});

it('rejects unsupported providers before create rather than letting them ignore sandbox', async () => {
  const f=await fixture(undefined,'codex');
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('仅支持 OMP');
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.config.appId).toBe('saved-app');
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('uploads only pinned byte snapshots and ignores outside extraRoots', async () => {
  const f=await fixture(undefined,'omp',true);
  const route=await f.internal.getOrCreate('c2c','peer');
  const send=vi.spyOn(f.internal.bot,'sendImage').mockResolvedValue({});
  await f.internal.deliverFile(route,`${f.root}/inside.png`,'image',{scope:'c2c',targetId:'peer'});
  expect(send.mock.calls[0]?.[1]).toEqual({buffer:Buffer.from('inside-media')});
  await expect(f.internal.deliverFile(route,'/outside/private.png','image',{scope:'c2c',targetId:'peer'})).rejects.toThrow('沙箱内');
  expect(send).toHaveBeenCalledOnce();
});

it('presented file uploads require explicit opt-in', async () => {
  const f=await fixture();const route=await f.internal.getOrCreate('c2c','peer');
  const send=vi.spyOn(f.internal.bot,'sendImage').mockResolvedValue({});
  await expect(f.internal.deliverFile(route,`${f.root}/inside.png`,'image',{scope:'c2c',targetId:'peer'})).rejects.toThrow('未开启');
  expect(send).not.toHaveBeenCalled();
});

it.each(['root', 'engineDirectory', 'javascript', 'network', 'imageGeneration'] as const)('%s change prevents a late model acknowledgement from overwriting peer preference', async change => {
  const f=await fixture();await f.internal.getOrCreate('c2c','peer');
  const called=Promise.withResolvers<void>();const acknowledged=Promise.withResolvers<void>();
  Object.assign(f.fresh,{setModel:vi.fn(()=>{called.resolve();return acknowledged.promise;})});
  const internal=f.gateway as unknown as {command(context:unknown,text:string):Promise<void>};
  const work=internal.command({replyTarget:{scope:'c2c',targetId:'peer'},message:{senderId:'peer'}},'/model provider/new-model');
  const settled=work.catch(error=>error);await called.promise;
  await f.store.mutate(s=>{if(change==='root')s.config.sandboxPath=join(f.root,'next');else if(change==='engineDirectory')s.config.game.engineDirectory=testEngineDirectory;else s.config.sandboxCapabilities[change]=true;});acknowledged.resolve();
  expect(await settled).toBeInstanceOf(Error);
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('unavailable pinned filesystem stops QQ creation without falling back to host files', async () => {
  const f=await fixture();f.native.invoke.mockRejectedValueOnce(new Error('unsupported secure filesystem'));
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('unsupported secure filesystem');
  expect(f.create).not.toHaveBeenCalled();expect(f.internal.routes.size).toBe(0);
});

it.each([false,true])('revoked grants stop the old turn when the replacement root is forbidden (capabilities %s)', async enabled => {
  const f=await fixture(homedir());
  const previous:NonNullable<Peer['sandbox']>={root:f.root,...(enabled?{javascript:true,network:'public' as const}:{})};
  await f.store.mutate(s=>{s.peers[f.key]=f.saved(previous);});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox:previous}});
  let oldTurnRunning=true;
  f.old.stop.mockImplementation(async()=>{oldTurnRunning=false;});
  await expect(f.gateway.start()).rejects.toBeInstanceOf(Error);
  expect(oldTurnRunning).toBe(false);
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe(f.old.id);
  expect(f.create).not.toHaveBeenCalled();
});

it('revoked access cannot submit a turn after attachment preparation', async () => {
  const f=await fixture();await f.internal.getOrCreate('c2c','peer');
  const called=Promise.withResolvers<void>();
  const downloaded=Promise.withResolvers<DownloadedSandboxAttachment>();
  vi.spyOn(media,'downloadAttachment').mockImplementation(()=>{called.resolve();return downloaded.promise;});
  const submitted:string[]=[];
  Object.assign(f.fresh,{send:async(text:string)=>{submitted.push(text);throw new Error('Revoked peer submitted a turn');}});
  const internal=f.gateway as unknown as {message(context:unknown):Promise<void>};
  const work=internal.message({replyTarget:{scope:'c2c',targetId:'peer',msgId:'fixture-message'},message:{senderId:'peer',content:'file question',attachments:[{filename:'input.txt',content_type:'text/plain',size:1,url:'https://qpic.cn/input.txt'}]},state:{envelope:'file question'}});
  const settled=work.catch(error=>error);await called.promise;
  await f.store.mutate(s=>{s.access.c2cMode='disabled';s.access.revision++;});
  downloaded.resolve({path:join(f.root,'input.txt'),relativePath:'input.txt',mimeType:'text/plain',size:1});
  const result=await settled;
  expect(result).toBeInstanceOf(Error);
  expect(submitted).toEqual([]);
});

it('canonical parent alias keeps the mapped conversation at startup', async () => {
  const f=await fixture();const alias=join(f.root,'parent-alias');await symlink(join(f.root,'..'),alias,'dir');
  const sandbox={root:f.root};
  await f.store.mutate(s=>{s.config.sandboxPath=join(alias,basename(f.root));s.peers[f.key]=f.saved(sandbox);});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox}});
  Object.assign(f.old,{observe:f.fresh.observe});
  let oldTurnRunning=true;f.old.stop.mockImplementation(async()=>{oldTurnRunning=false;});
  const config=(await f.store.read()).values.config;
  const restarted=new Gateway(f.ctx,f.store,new Pairing(f.store),config,'fixture-secret',{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},vi.fn());
  cleanups.push(()=>restarted.dispose());
  // Inspect the known in-process transport only to prevent fixture network I/O.
  const restartedInternal=restarted as unknown as {bot:{start():Promise<void>}};
  vi.spyOn(restartedInternal.bot,'start').mockResolvedValue();
  await restarted.start();
  expect(oldTurnRunning).toBe(true);
  expect((await f.store.read()).values.peers[f.key]).toMatchObject({agentId:f.old.id,workspaceId:'old-workspace',cwd:f.root});
  expect(f.create).not.toHaveBeenCalled();
});

it('revoking image generation replaces the saved agent and preserves peer preferences and history', async () => {
  const f=await fixture();
  const granted={root:f.root,imageGeneration:true};
  const previous=f.saved(granted);
  await f.store.mutate(state=>{state.peers[f.key]=previous;state.presetSelections[f.key]='default';});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox:granted}});
  const route=await f.internal.getOrCreate('c2c','peer');
  expect(f.old.stop).toHaveBeenCalledOnce();
  expect(route.peer.sandbox).toEqual({root:f.root});
  expect(f.create.mock.calls[0]?.[0].config?.sandbox).toEqual({root:f.root});
  const state=(await f.store.read()).values;
  expect(state.modelSelections[f.key]).toBe('provider/model');
  expect(state.presetSelections[f.key]).toBe('default');
  expect(state.config.appId).toBe('saved-app');
  expect(state.config.presets[0]?.config.systemPrompt).toBe('Keep prompt');
  expect(previous.agentId).toBe(f.old.id);
});

it('requires SDK confirmation of the image generation grant', async () => {
  const f=await fixture(undefined,'omp',false,{javascript:false,network:false,imageGeneration:true});
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('Desktop agent');
  expect(f.fresh.stop).toHaveBeenCalledOnce();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.internal.routes.size).toBe(0);
});

it('preserves the sandbox confirmation error if fresh-agent cleanup fails', async () => {
  const f=await fixture(undefined,'omp',false,{javascript:false,network:false,imageGeneration:true});
  f.fresh.stop.mockRejectedValue(new Error('cleanup failed'));
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('Desktop agent 未确认当前 QQ 沙箱');
  expect(f.fresh.stop).toHaveBeenCalledOnce();
  expect(f.internal.routes.size).toBe(0);
});

it('stops a fresh agent after observation failure without replacing the original error', async () => {
  const f=await fixture();const failure=new Error('observation denied');
  f.fresh.observe.mockRejectedValue(failure);f.fresh.stop.mockRejectedValue(new Error('cleanup failed'));
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toBe(failure);
  expect(f.fresh.stop).toHaveBeenCalledOnce();
  expect(f.internal.routes.size).toBe(0);
});

it.each(['observation-failed','unconfirmed-sandbox'] as const)('keeps saved-agent cleanup scoped to %s', async kind => {
  const f=await fixture(undefined,'omp',false,{javascript:false,network:false,imageGeneration:true});
  const sandbox={root:f.root,imageGeneration:true};
  await f.store.mutate(state=>{state.peers[f.key]=f.saved(sandbox);});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox}});
  Object.assign(f.old,{observe:f.fresh.observe});
  const failure=new Error('saved observation denied');
  if(kind==='observation-failed')f.fresh.observe.mockRejectedValue(failure);
  else f.old.stop.mockRejectedValue(new Error('saved cleanup failed'));
  const work=f.internal.getOrCreate('c2c','peer');
  if(kind==='observation-failed'){
    await expect(work).rejects.toBe(failure);expect(f.old.stop).not.toHaveBeenCalled();
  }else{
    await expect(work).rejects.toThrow('Desktop agent 未确认当前 QQ 沙箱');expect(f.old.stop).toHaveBeenCalledOnce();
  }
  expect(f.create).not.toHaveBeenCalled();expect(f.fresh.stop).not.toHaveBeenCalled();
  expect(f.internal.routes.size).toBe(0);
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe(f.old.id);
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});
it('enabling the trusted host game retires a matching sandbox agent with polluted old context',async()=>{
  const f=await fixture(undefined,'omp',false,undefined,true);
  await f.store.mutate(state=>{state.peers[f.key]=f.saved({root:f.root});});
  f.old.refresh.mockResolvedValue({agent:{id:f.old.id,sandbox:{root:f.root}}});
  Object.assign(f.old,{observe:f.fresh.observe,send:async(_text:string,options:{messageId:string})=>emitReply(f,options.messageId,'{"memory":"","activeTasks":[]}')});
  const route=await f.internal.getOrCreate('c2c','peer');
  expect(f.old.stop).toHaveBeenCalledOnce();expect(route.agent.id).toBe('new-agent');
  expect(route.peer.protocolVersion).toBe(2);
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe(route.agent.id);
});
it('never permits the sandbox to cover host game data',async()=>{
  const f=await fixture(join(homedir(),'.omp','qqbot-data'));
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('宿主游戏数据目录重叠');
  expect(f.native.invoke).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it('never permits the sandbox to cover installed plugin code',async()=>{
  const f=await fixture(new URL('..',import.meta.url).pathname);
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('插件代码');
  expect(f.native.invoke).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});

it.each(['same', 'inside', 'cover', 'alias'] as const)('protects a registered engine from %s sandbox overlap while the game is disabled', async kind => {
  const directory=await mkdtemp(join(tmpdir(),'qqbot-engine-protection-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const engine=join(directory,'engine');await mkdir(engine);
  const alias=join(directory,'alias');await symlink(directory,alias,'dir');
  const sandbox=kind==='same'?engine:kind==='inside'?join(engine,'sandbox'):kind==='cover'?directory:join(alias,'engine','sandbox');
  const f=await fixture(sandbox,'omp',false,undefined,false,engine);
  await expect(f.gateway.start()).rejects.toThrow('独立游戏引擎目录');
  expect(f.native.invoke).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});

it('rejects an entry symlink into the sandbox before acquiring sandbox capabilities', async () => {
  const directory=await mkdtemp(join(tmpdir(),'qqbot-engine-entry-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const engine=join(directory,'engine');const sandbox=join(directory,'sandbox');
  await mkdir(engine);await mkdir(sandbox);await writeFile(join(sandbox,'engine.js'),'throw new Error("untrusted entry executed");');
  await symlink(join(sandbox,'engine.js'),join(engine,'engine.js'));
  const f=await fixture(sandbox,'omp',false,undefined,true,engine);
  await expect(f.gateway.start()).rejects.toThrow('入口不能解析到 QQ 沙箱');
  expect(f.native.invoke).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});

it('engine-directory changes immediately invalidate old delivery without changing account or chat state', async () => {
  const f=await fixture();const route=await f.internal.getOrCreate('c2c','peer');
  const before=(await f.store.read()).values;
  await f.store.mutate(state=>{state.config.game.engineDirectory=testEngineDirectory;});
  const send=vi.spyOn(f.internal.sender,'sendMarkdown');
  await f.internal.event(route,{event:{type:'turn_failed',error:'HOST_SECRET'}} as unknown as OmpAgentStream);
  expect(send).not.toHaveBeenCalled();
  await expect(f.internal.bot.apiClient.request('token','POST','/v2/users/peer/messages',{})).rejects.toThrow('沙箱配置');
  const after=(await f.store.read()).values;
  expect(after.config.appId).toBe(before.config.appId);expect(after.access).toEqual(before.access);
  expect(after.credentialVersions).toEqual(before.credentialVersions);expect(after.peers).toEqual(before.peers);
  expect(after.modelSelections).toEqual(before.modelSelections);expect(after.config.game.enabled).toBe(false);
});

it('enabled game startup resolves the default engine directory and reports when it is absent', async () => {
  const home=await realpath(await mkdtemp(join(tmpdir(),'qqbot-game-home-')));
  cleanups.push(()=>rm(home,{recursive:true,force:true}));isolatedHome.path=home;
  const missing=await fixture(undefined,'omp',false,undefined,true,'');
  await expect(missing.gateway.start()).rejects.toMatchObject({code:'ENOENT',path:join(home,'.omp','qqbot-games')});
});

it('starts the real external engine at the unchanged installation database path without QQ network I/O', async () => {
  const home=await mkdtemp(join(tmpdir(),'qqbot-game-home-'));
  cleanups.push(()=>rm(home,{recursive:true,force:true}));isolatedHome.path=home;
  const f=await fixture(undefined,'omp',false,undefined,true);
  vi.spyOn(f.internal.bot,'start').mockResolvedValue();
  await f.gateway.start();
  const inspected=await f.gateway.inspectGame({scope:'c2c',openid:'peer',userId:'peer',text:'我要修仙'});
  expect(inspected.enabled).toBe(true);expect(inspected.parsed).toEqual({text:'我要修仙'});
  expect(inspected.databasePath).toBe(join(home,'.omp','qqbot-data','installation-installation','xiuxian.sqlite'));
  expect(inspected.player).toBeNull();expect((await stat(inspected.databasePath)).isFile()).toBe(true);
});
