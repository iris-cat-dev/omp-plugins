import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, link, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { PluginServiceContext, PluginStorage, PluginNativeApi } from '@omp-desktop/plugin/server';
import type { OmpApi, OmpAgentHandle, OmpAgentStream, GeneratedImage } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, PeerSchema, peerKey, type Peer } from './state.ts';
import { SandboxFiles } from './sandbox-files.ts';
import type { ReplyTarget } from './types.ts';
import { cleanMedia } from './media.ts';
import type { AssistantReply } from './assistant-output.ts';
import { deflateSync } from 'node:zlib';
import { SceneImages, validateSceneImage } from './scene-images.ts';
import { QQImageGenerator } from './image-generation.ts';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import type { GameSceneImage } from './game-api.ts';
import { testEngine } from '../tests/game-fixture.ts';
import { DatabaseSync } from 'node:sqlite';

const sdkRoot=process.env.OMP_DESKTOP_TEST_SDK_ROOT;
if(!sdkRoot||!isAbsolute(sdkRoot)||!existsSync(join(sdkRoot,'package.json'))||!existsSync(join(sdkRoot,'dist','node','modules.json'))){
  throw new Error('QQ image delivery tests require a real built Desktop Node SDK: set OMP_DESKTOP_TEST_SDK_ROOT to its @oh-my-pi/pi-coding-agent package root (npm run build:omp-sdk:dev).');
}
// Resolve from the explicitly staged SDK, never the workspace's generic native addon.
const {SandboxFs:NativeSandboxFs}=createRequire(join(sdkRoot,'package.json'))('@oh-my-pi/pi-natives') as {SandboxFs:new(root:string,maxBytes:number)=>NativeFiles};
if(typeof NativeSandboxFs!=='function')throw new Error('OMP_DESKTOP_TEST_SDK_ROOT must contain a Desktop native addon exporting the real SandboxFs primitive; rebuild the staged Desktop SDK.');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const imagePath='.qqbot-media/generated/real.png';
const cleanups:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.restoreAllMocks();});
interface NativeFiles { read(path:string,maxBytes?:number):Buffer;write(path:string,bytes:Buffer,exclusive?:boolean):void;list(path:string):Array<{name:string;isDirectory:boolean;size:number;modifiedAt:number}>;mkdir(path:string):void;remove(path:string):void;close():void }
interface TestRoute {
  peer:Peer;agent:OmpAgentHandle;unsubscribe:null;buffer:null;
  turnId?:string;target?:ReplyTarget;localTarget?:ReplyTarget;enabledDelivery:boolean;
  textRows:Map<number,string>;files:Map<string,{name:string;mimeType?:string;generatedTurnId?:string}>;
  sceneImages:Map<string,{senderId:string;scene:GameSceneImage;controller:AbortController}>;
  toolRevisions:Map<string,string>;pending:Map<string,{target:ReplyTarget;senderId:string;owned:boolean;turnId:string;done:()=>void;fail:(error:unknown)=>void;output?:AssistantReply;silent?:boolean}>;chain:Promise<void>;lastSeq:number;
}
async function fixture(enabled=true,scope:'c2c'|'group'='c2c',gameEnabled=false) {
  const directory=await mkdtemp(join(tmpdir(),'qq-generated-image-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const root=await realpath(directory);
  const quotaRoot = await mkdtemp(join(tmpdir(), 'qq-chat-image-quota-'));
  cleanups.push(() => rm(quotaRoot, { recursive: true, force: true }));
  const databasePath = join(quotaRoot, 'private', 'quota.sqlite');
  await mkdir(join(root,'.qqbot-media/generated'),{recursive:true});
  await writeFile(join(root,imagePath),png);
  // Exercise the staged Desktop addon's real descriptor-bound primitive.
  const pinned=new NativeSandboxFs(root,1024*1024);
  let afterRead:(()=>Promise<void>)|undefined;
  const native={invoke:async(_operation:string,input:unknown)=>{
    const request=input as {action:string;path:string;maxBytes:number;contentBase64:string;exclusive:boolean};
    if(request.action==='open')return{handle:'real-native-pinned'};
    if(request.action==='close'){pinned.close();return{ok:true};}
    if(request.action==='read'){const bytes=pinned.read(request.path,request.maxBytes);await afterRead?.();return{contentBase64:bytes.toString('base64')};}
    if(request.action==='write'){pinned.write(request.path,Buffer.from(request.contentBase64,'base64'),request.exclusive);return{ok:true};}
    if(request.action==='mkdir'){pinned.mkdir(request.path);return{ok:true};}
    if(request.action==='list')return{entries:pinned.list(request.path)};
    if(request.action==='remove'){pinned.remove(request.path);return{ok:true};}
    throw new Error(`Unexpected sandbox operation: ${request.action}`);
  }} as PluginNativeApi;
  const files=await SandboxFiles.open(native,root,1024*1024);
  cleanups.push(()=>files.close());
  let values=StateSchema.parse({config:{appId:'app',sandboxPath:root,sandboxCapabilities:{imageGeneration:enabled},game:{enabled:gameEnabled},media:{maxMB:1}}});
  const store=new StateStore({get:async()=>({revision:0,values:structuredClone(values)}),patch:async(patch:unknown)=>{values=StateSchema.parse(patch);return{revision:0,values};}} as PluginStorage);
  const peer=PeerSchema.parse({appId:'app',scope,openid:'peer',hostId:'host',workspaceId:'workspace',agentId:'agent',cwd:root,sandbox:{root},preset:'default',template:values.config.presets[0],protocolPrompt:'QQ',lastDeliveredSequence:0});
  const target:ReplyTarget={scope,targetId:'peer',forceProactive:true};
  const generate = vi.fn<OmpApi['images']['generate']>(async () => ({ data: png.toString('base64'), mimeType: 'image/png' }));
  const ctx={signal:new AbortController().signal,installation:{id:'installation',generation:7},omp:{images:{generate}},native} as unknown as PluginServiceContext;
  const gateway=new Gateway(ctx,store,new Pairing(store),values.config,'fixture-secret',{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},vi.fn());
  cleanups.push(()=>gateway.dispose());
  const internal=gateway as unknown as {files:SandboxFiles;root:string;imageGeneration:QQImageGenerator;routes:Map<string,TestRoute>;event(route:TestRoute,stream:OmpAgentStream):Promise<void>;command(context:unknown,text:string):Promise<void>;deliverFile(route:TestRoute,path:string,type:'image',target:ReplyTarget):Promise<void>;bot:QQBot;sender:{sendMarkdown(target:ReplyTarget,text:string):Promise<unknown>}};
  const generator = new QQImageGenerator({ images: { generate } }, databasePath);
  internal.files=files;internal.root=root;internal.imageGeneration=generator;
  const route:TestRoute={peer,agent:{id:'agent'} as OmpAgentHandle,unsubscribe:null,buffer:null,enabledDelivery:false,localTarget:target,textRows:new Map(),files:new Map(),toolRevisions:new Map(),pending:new Map(),sceneImages:new Map(),chain:Promise.resolve(),lastSeq:0};
  internal.routes.set(peerKey('app',scope,'peer'),route);
  const send=vi.spyOn(internal.bot,'sendImage').mockResolvedValue({upload:{file_uuid:'uploaded',file_info:'qq-media',ttl:60},message:undefined});
  const markdown=vi.spyOn(internal.sender,'sendMarkdown').mockResolvedValue(undefined);
  const event=(event:unknown,seq=1,contentVersion=1)=>internal.event(route,{seq,contentVersion,event} as OmpAgentStream);
  const start=()=>event({type:'turn_started',turnId:'turn-current'},0);
  const complete=()=>event({type:'turn_completed',turnId:'turn-current'},3);
  const beginImage = async (senderId = 'peer', text = JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Draw a red pixel.', images: [] })) => {
    const pending = { target, senderId, owned: false, turnId: '', output: { text: '', messageCount: 0 }, done: vi.fn(() => { route.pending.delete('image-input'); }), fail: vi.fn() };
    route.pending.set('image-input', pending);
    await start();
    await event({ type: 'timeline', turnId: 'turn-current', item: { type: 'user_message', messageId: 'image-input', clientMessageId: 'image-input', text: 'Draw a picture.' } }, 1);
    await event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'image-response', text } }, 2);
    return pending;
  };
  const states = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare('SELECT state, COUNT(*) AS count FROM image_quota_reservations GROUP BY state ORDER BY state').all(); }
    finally { database.close(); }
  };
  return{root,files,store,gateway,internal,route,target,send,markdown,event,start,complete,beginImage,generate,generator,states,setAfterRead:(hook:()=>Promise<void>)=>{afterRead=hook;}};
}

it.each(['c2c', 'group'] as const)('owned QQ image controls deliver real PNG bytes to the current %s target exactly once', async scope => {
  const f = await fixture(true, scope);
  const pending = await f.beginImage();
  await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'image-response', text: JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Draw a red pixel.', images: [] }) } }, 2, 2);
  expect(f.generate).not.toHaveBeenCalled();
  await f.complete(); await f.complete();
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope, targetId: 'peer' }), { buffer: png });
  expect(f.markdown).not.toHaveBeenCalled();
  expect(pending.output).toEqual({ text: '', messageCount: 0 });
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('game-enabled image controls are consumed without forwarding their JSON to QQ or the game bridge', async () => {
  const f = await fixture(true, 'group', true);
  const pending = await f.beginImage('player');
  await f.complete();
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope: f.target.scope, targetId: f.target.targetId }), { buffer: png });
  expect(f.markdown).not.toHaveBeenCalled();
  expect(pending.output).toEqual({ text: '', messageCount: 0 });
  expect(pending.done).toHaveBeenCalledOnce();
});

it('game-enabled ordinary text preserves exact streamed text without invoking image generation', async () => {
  const f = await fixture(true, 'group', true); await f.start();
  const fragments = ['这行换行', '是原文。\n', '下一行。'];
  for (let index = 0; index < fragments.length; index++) await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'text-reply', text: fragments[index] } }, index + 1);
  await f.complete();
  expect(f.markdown).toHaveBeenCalledExactlyOnceWith(f.target, fragments.join(''));
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

it.each(['action', 'member_query', 'review', 'rift_review'] as const)('game-enabled %s output remains protocol-only and never invokes image generation', async kind => {
  const f = await fixture(true, 'group', true);
  const output = kind === 'action' ? '{"type":"game_action","command":"我的状态"}' : kind === 'member_query' ? '{"type":"member_query","nickname":"同名"}' : kind === 'review' ? JSON.stringify({ scores: { experience: { value: 0, quote: '', factIds: [] }, problem: { value: 1, quote: '慢' }, reason: { value: 1, quote: '慢' }, change: { value: 2, quote: '慢' } }, feedback: '理解已通过。', followUp: null }) : JSON.stringify({ outcome: 'success', reason: '处理了当前威胁。', narrative: '穿过了灵雾。' });
  const pending = await f.beginImage('player', output); await f.complete();
  expect(pending.output).toEqual({ text: output, messageCount: 1 });
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.markdown).not.toHaveBeenCalled();
});

it.each(['disabled', 'missing-sender', 'extra-identity', 'multiple-messages'] as const)('rejects %s image controls before calling the host API', async kind => {
  const f = await fixture(kind !== 'disabled');
  const text = JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Draw.', images: [], ...(kind === 'extra-identity' ? { senderId: 'attacker' } : {}) });
  await f.beginImage(kind === 'missing-sender' ? '' : 'peer', text);
  if (kind === 'multiple-messages') await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'second-response', text } }, 3);
  await f.complete();
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

it('ignores image controls from a Desktop turn without a QQ delivery target', async () => {
  const f = await fixture();
  f.route.localTarget = undefined;
  await f.start();
  await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'external-reply', text: JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Draw.', images: [] }) } }, 2);
  await f.complete();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.markdown).not.toHaveBeenCalled();
});

it('native SDK tool metadata is not an alternate QQ generation or delivery authority', async () => {
  const f = await fixture(); await f.start();
  await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'tool_call', callId: 'legacy-image', name: 'generate_image', status: 'completed', metadata: { generatedImagesSource: 'omp-sandbox-image', generatedImages: [{ path: imagePath, mimeType: 'image/png' }] } } });
  await f.complete();
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

it('an image reference above the QQ media bound is rejected before any host generation or upload', async () => {
  const f = await fixture();
  const path = '.qqbot-media/reference-too-large.png';
  await writeFile(join(f.root, path), Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
  await f.beginImage('peer', JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Edit the pixel.', images: [path] }));
  await f.complete();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it.each(['outside', 'symlink', 'hardlink', 'unsupported'] as const)('rejects %s image references before a paid generation', async kind => {
  const f = await fixture(); let path = imagePath;
  if (kind === 'outside') path = join(f.root, imagePath);
  if (kind === 'symlink') { path = '.qqbot-media/generated/link.png'; await symlink(join(f.root, imagePath), join(f.root, path)); }
  if (kind === 'hardlink') { path = '.qqbot-media/generated/hard.png'; await link(join(f.root, imagePath), join(f.root, path)); }
  if (kind === 'unsupported') { path = '.qqbot-media/generated/text.txt'; await f.files.write(path, Buffer.from('not an image')); }
  await f.beginImage('peer', JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Edit.', images: [path] })); await f.complete();
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

it.each(['grant', 'access', 'generation', 'turn'] as const)('revoking %s during the pinned read blocks QQ image delivery', async change => {
  const f = await fixture(); await f.start();
  f.route.files.set(imagePath, { name: 'pixel.png', mimeType: 'image/png', generatedTurnId: 'turn-current' });
  f.setAfterRead(async () => {
    if (change === 'grant') await f.store.mutate(state => { state.config.sandboxCapabilities.imageGeneration = false; });
    if (change === 'access') await f.store.mutate(state => { state.access.c2cMode = 'disabled'; });
    if (change === 'generation') f.internal.routes.delete(peerKey('app', 'c2c', 'peer'));
    if (change === 'turn') f.route.turnId = 'turn-next';
  });
  await expect(f.internal.deliverFile(f.route, imagePath, 'image', f.target)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
});

it('target mismatch is refused and failed QQ upload never refunds a successfully generated image', async () => {
  const f = await fixture(); await f.start();
  f.route.files.set(imagePath, { name: 'pixel.png', mimeType: 'image/png', generatedTurnId: 'turn-current' });
  await expect(f.internal.deliverFile(f.route, imagePath, 'image', { scope: 'c2c', targetId: 'another-peer' })).rejects.toThrow('授权或回合');
  await f.beginImage(); f.send.mockRejectedValue(new Error('QQ upload failed')); await f.complete();
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.markdown).toHaveBeenCalledWith(f.target, expect.stringContaining('文件未投递'));
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('quota exhaustion sends one explicit daily-limit notice and never makes the eleventh API call', async () => {
  const f = await fixture();
  for (let index = 0; index < 10; index++) await f.generator.generate(f.route.peer, 'peer', { prompt: 'Draw.', images: [] }, new AbortController().signal);
  await f.beginImage(); await f.complete(); await f.complete();
  expect(f.generate).toHaveBeenCalledTimes(10); expect(f.send).not.toHaveBeenCalled();
  expect(f.markdown).toHaveBeenCalledExactlyOnceWith(f.target, expect.stringMatching(/10.*北京时间/));
});

it.each(['turn_canceled', 'turn_failed'] as const)('%s never executes an unconsumed image control', async type => {
  const f = await fixture(); await f.beginImage();
  await f.event({ type, turnId: 'turn-current', error: 'turn failed' }, 3);
  expect(f.generate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

it('a late control from the previous turn cannot generate or deliver in the next turn', async () => {
  const f = await fixture(); await f.beginImage(); await f.complete();
  await f.event({ type: 'turn_started', turnId: 'turn-next' }, 4);
  await f.event({ type: 'timeline', turnId: 'turn-current', item: { type: 'assistant_message', messageId: 'late', text: JSON.stringify({ type: 'qqbot_generate_image', prompt: 'Late image.', images: [] }) } }, 5);
  await f.event({ type: 'turn_completed', turnId: 'turn-next' }, 6);
  expect(f.generate).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
});

it.each(['stop', 'turn_canceled'] as const)('%s during a pinned generated-file read blocks the QQ upload boundary', async reason => {
  const f = await fixture(); await f.start();
  f.route.agent = { id: 'agent', stop: vi.fn(async () => {}) } as unknown as OmpAgentHandle;
  f.route.files.set(imagePath, { name: 'pixel.png', mimeType: 'image/png', generatedTurnId: 'turn-current' });
  f.setAfterRead(async () => {
    if (reason === 'stop') await f.internal.command({ replyTarget: f.target, message: { senderId: 'peer' } }, '/stop');
    else await f.event({ type: 'turn_canceled', turnId: 'turn-current' }, 3);
  });
  await expect(f.internal.deliverFile(f.route, imagePath, 'image', f.target)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
});

it('stopping a pending ordinary image request aborts the API and keeps its uncertain reservation', async () => {
  const f = await fixture(); await f.beginImage();
  const started = Promise.withResolvers<void>();
  f.generate.mockImplementationOnce(async (_input, options) => {
    const result = Promise.withResolvers<GeneratedImage>();
    options!.signal!.addEventListener('abort', () => result.reject(options!.signal!.reason), { once: true });
    started.resolve();
    return result.promise;
  });
  f.route.agent = { id: 'agent', stop: vi.fn(async () => {}) } as unknown as OmpAgentHandle;
  const completed = f.complete();
  await started.promise;
  await f.internal.command({ replyTarget: f.target, message: { senderId: 'peer' } }, '/stop');
  await completed;
  expect(f.generate).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  expect(f.states()).toEqual([{ state: 'pending', count: 1 }]);
});

it('applies media TTL only to exclusive generated UUID image filenames and leaves other sandbox files intact',async()=>{
  const f=await fixture();
  const expired='.qqbot-media/generated/11111111-1111-4111-8111-111111111111.png';
  const fresh='.qqbot-media/generated/22222222-2222-4222-8222-222222222222.webp';
  const unrelated='.qqbot-media/generated/33333333-3333-4333-8333-333333333333.txt';
  const nested='.qqbot-media/generated/44444444-4444-4444-8444-444444444444.png';
  await writeFile(join(f.root,expired),png);await writeFile(join(f.root,fresh),png);await writeFile(join(f.root,unrelated),'keep');await mkdir(join(f.root,nested));
  const old=new Date(Date.now()-48*3600000);
  await utimes(join(f.root,expired),old,old);await utimes(join(f.root,imagePath),old,old);await utimes(join(f.root,unrelated),old,old);
  await cleanMedia(f.files,0);expect(await f.files.read(expired)).toEqual(png);
  await cleanMedia(f.files,24);
  await expect(stat(join(f.root,expired))).rejects.toMatchObject({code:'ENOENT'});
  expect(await f.files.read(fresh)).toEqual(png);expect(await f.files.read(imagePath)).toEqual(png);
  expect((await f.files.read(unrelated)).toString()).toBe('keep');expect((await stat(join(f.root,nested))).isDirectory()).toBe(true);
});

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
const riftHeader = Buffer.alloc(13);
riftHeader.writeUInt32BE(512); riftHeader.writeUInt32BE(512, 4); riftHeader[8] = 8; riftHeader[9] = 2;
const riftPng = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', riftHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(512 * (1 + 512 * 3)))), pngChunk('IEND', Buffer.alloc(0))]);

async function sceneFixture(mode: 'automatic' | 'waiting' = 'automatic', sandboxEnabled = true) {
  const base = await fixture();
  if (!sandboxEnabled) { await base.store.mutate(state => { state.config.sandboxEnabled = false; }); base.route.peer.sandbox = undefined; }
  const quotaRoot = await mkdtemp(join(tmpdir(), 'qq-scene-quota-'));
  cleanups.push(() => rm(quotaRoot, { recursive: true, force: true }));
  const databasePath = join(quotaRoot, 'private', 'quota.sqlite');
  const started = Promise.withResolvers<void>();
  const pending: Array<{ completion: { promise: Promise<GeneratedImage>; resolve: (image: GeneratedImage) => void; reject: (reason?: unknown) => void }; signal: AbortSignal }> = [];
  const generate = vi.fn<OmpApi['images']['generate']>(async (_input, options) => {
    const signal = options!.signal!;
    started.resolve();
    if (mode === 'automatic') return { data: riftPng.toString('base64'), mimeType: 'image/png' };
    const completion = Promise.withResolvers<GeneratedImage>();
    pending.push({ completion, signal });
    const abort = () => completion.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await completion.promise; } finally { signal.removeEventListener('abort', abort); }
  });
  const generator = new QQImageGenerator({ images: { generate } }, databasePath);
  cleanups.push(() => generator.dispose());
  base.internal.imageGeneration = generator;
  const images = new SceneImages(base.root, base.files, base.store, generator);
  const { createGame } = await testEngine(base.root);
  const game = createGame({ databasePath: join(base.root, 'image-game.sqlite'), random: () => 0 });
  cleanups.push(() => game.close());
  const event = { groupId: 'scene-images', userId: 'player', text: '我要修仙' };
  await game.host.handleMessage(event);
  const result = await game.host.handleMessage({ ...event, text: '秘境探索' });
  if (!result.sceneImage) throw new Error('Real external engine did not supply a scene image request');
  const request = { scene: result.sceneImage, peer: base.route.peer, senderId: 'player' };
  const get = (signal = new AbortController().signal, service = images) => service.get({ ...request, signal });
  const states = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare('SELECT state, COUNT(*) AS count FROM image_quota_reservations GROUP BY state ORDER BY state').all(); }
    finally { database.close(); }
  };
  return { ...base, images, generator, request, get, generate, pending, states, started: started.promise };
}

it('scene images validate real PNG pixels, publish a UUID path, reuse cache across instances and redraw after TTL', async () => {
  const f = await sceneFixture();
  expect(await f.get()).toEqual(riftPng);
  const original = Object.values((await f.store.read()).values.sceneImages)[0]!;
  expect(original).toMatch(/^\.qqbot-media\/generated\/[0-9a-f-]{36}\.png$/);
  expect(await f.files.read(original)).toEqual(riftPng);
  const restored = new SceneImages(f.root, f.files, f.store, f.generator);
  expect(await f.get(undefined, restored)).toEqual(riftPng);
  expect(f.generate).toHaveBeenCalledOnce();
  const old = new Date(Date.now() - 48 * 3_600_000); await utimes(join(f.root, original), old, old);
  await cleanMedia(f.files, 24);
  expect(await f.get(undefined, restored)).toEqual(riftPng);
  expect(f.generate).toHaveBeenCalledTimes(2);
  const replacement = Object.values((await f.store.read()).values.sceneImages)[0]!;
  expect(replacement).not.toBe(original);
  expect(await f.files.read(replacement)).toEqual(riftPng);
  expect(f.states()).toEqual([{ state: 'succeeded', count: 2 }]);
});

it('scene revisions and non-sandbox QQ callers reuse the real cache without opening an SDK image child', async () => {
  const f = await sceneFixture('automatic', false);
  const signal = new AbortController().signal;
  expect(await f.images.get({ ...f.request, scene: { ...f.request.scene, token: 'new-scene-revision' }, signal })).toEqual(riftPng);
  expect(await f.get()).toEqual(riftPng);
  expect(f.generate).toHaveBeenCalledOnce();
  const submitted = f.generate.mock.calls[0]![0];
  expect(submitted.prompt).toContain(f.request.scene.image.system);
  expect(submitted.prompt).toContain(f.request.scene.image.prompt);
  expect(submitted.prompt).toContain('512 × 512');
  expect(submitted.images).toEqual([]);
});

it.each(['title', 'description'] as const)('scene cache redraws changed visible %s and still reuses the unchanged scene', async field => {
  const f = await sceneFixture();
  expect(await f.get()).toEqual(riftPng);
  const changed = { ...f.request.scene, [field]: field === 'title' ? '石门前庭' : '青石地面上立着铜门，门面刻着六道锁纹。' };
  changed.image = { ...changed.image, prompt: changed.image.prompt.replace(JSON.stringify({ title: f.request.scene.title, description: f.request.scene.description }), JSON.stringify({ title: changed.title, description: changed.description })) };
  expect(await f.images.get({ ...f.request, scene: changed, signal: new AbortController().signal })).toEqual(riftPng);
  expect(Object.values((await f.store.read()).values.sceneImages)).toHaveLength(2);
  expect(await f.get()).toEqual(riftPng);
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('ordinary chat and scenes share ten calls, while a cached scene remains free at quota exhaustion', async () => {
  const f = await sceneFixture();
  expect(await f.get()).toEqual(riftPng);
  for (let index = 0; index < 9; index++) {
    await f.beginImage('player', JSON.stringify({ type: 'qqbot_generate_image', prompt: `ordinary image ${index}`, images: [] }));
    await f.complete();
  }
  expect(await f.get()).toEqual(riftPng);
  const changed = { ...f.request.scene, image: { ...f.request.scene.image, prompt: 'A different uncached scene.' } };
  await expect(f.images.get({ ...f.request, scene: changed, signal: new AbortController().signal })).rejects.toThrow('QQ_IMAGE_QUOTA_EXHAUSTED');
  expect(f.generate).toHaveBeenCalledTimes(10);
  expect(f.send).toHaveBeenCalledTimes(9);
  expect(Object.values((await f.store.read()).values.sceneImages)).toHaveLength(1);
});

it.each(['mime', 'dimensions', 'checksum', 'pixels'] as const)('a successful API image with invalid scene %s is not cached and is never refunded', async kind => {
  const f = await sceneFixture();
  let bytes = Buffer.from(riftPng);
  if (kind === 'dimensions') bytes = png;
  if (kind === 'checksum') bytes[bytes.length - 1]! ^= 1;
  if (kind === 'pixels') bytes = riftPng.subarray(0, 33);
  f.generate.mockResolvedValueOnce({ data: bytes.toString('base64'), mimeType: kind === 'mime' ? 'image/jpeg' : 'image/png' });
  await expect(f.get()).rejects.toThrow();
  expect((await f.store.read()).values.sceneImages).toEqual({});
  expect((await f.files.list('.qqbot-media/generated')).map(file => file.name)).toEqual(['real.png']);
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('publication failure after the host returns an image keeps quota consumed and leaves the scene uncached', async () => {
  const f = await sceneFixture();
  vi.spyOn(f.files, 'write').mockRejectedValueOnce(new Error('exclusive publication failed'));
  await expect(f.get()).rejects.toThrow('publication failed');
  expect((await f.store.read()).values.sceneImages).toEqual({});
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it.each(['corrupt', 'empty', 'symlink', 'hardlink', 'directory'] as const)('scene image %s cache entries fail visibly instead of silently redrawing', async kind => {
  const f = await sceneFixture(); await f.get();
  const path = Object.values((await f.store.read()).values.sceneImages)[0]!; await f.files.remove(path);
  if (kind === 'corrupt') await f.files.write(path, riftPng.subarray(0, 40));
  else if (kind === 'empty') await f.files.write(path, Buffer.alloc(0));
  else if (kind === 'symlink') await symlink(join(f.root, imagePath), join(f.root, path));
  else if (kind === 'hardlink') await link(join(f.root, imagePath), join(f.root, path));
  else await mkdir(join(f.root, path));
  await expect(f.get()).rejects.toThrow(); expect(f.generate).toHaveBeenCalledOnce();
});

it('canceling one concurrent scene waiter does not cancel the shared API call or reject the remaining waiter', async () => {
  const f = await sceneFixture('waiting'); const first = new AbortController();
  const one = f.get(first.signal), two = f.get(); const rejected = expect(one).rejects.toThrow('one waiter left');
  await f.started; first.abort(new Error('one waiter left')); await rejected;
  expect(f.pending[0]!.signal.aborted).toBe(false);
  f.pending[0]!.completion.resolve({ data: riftPng.toString('base64'), mimeType: 'image/png' });
  expect(await two).toEqual(riftPng); expect(f.generate).toHaveBeenCalledOnce();
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('canceling the last scene waiter aborts the API, preserves pending usage and leaves no cached image', async () => {
  const f = await sceneFixture('waiting'); const controller = new AbortController();
  const work = f.get(controller.signal); const rejected = expect(work).rejects.toThrow('route retired');
  await f.started; controller.abort(new Error('route retired')); await rejected;
  await nextImmediate();
  expect(f.pending[0]!.signal.aborted).toBe(true);
  expect((await f.store.read()).values.sceneImages).toEqual({});
  expect(f.states()).toEqual([{ state: 'pending', count: 1 }]);
});

it('a late successful API output after scene cancellation is charged but never published or cached', async () => {
  const f = await sceneFixture(); const controller = new AbortController();
  const completion = Promise.withResolvers<GeneratedImage>(); const started = Promise.withResolvers<void>();
  f.generate.mockImplementationOnce(async () => { started.resolve(); return completion.promise; });
  const work = f.get(controller.signal); const rejected = expect(work).rejects.toThrow('route retired');
  await started.promise; controller.abort(new Error('route retired')); await rejected;
  completion.resolve({ data: riftPng.toString('base64'), mimeType: 'image/png' });
  await nextImmediate();
  expect((await f.store.read()).values.sceneImages).toEqual({});
  expect((await f.files.list('.qqbot-media/generated')).map(file => file.name)).toEqual(['real.png']);
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('rift image validation rejects forged dimensions, corrupt PNG checksums and missing compressed pixels', () => {
  expect(() => validateSceneImage(riftPng, { width: 512, height: 512 })).not.toThrow();
  expect(() => validateSceneImage(riftPng, { width: 256, height: 512 })).toThrow();
  const narrowHeader = Buffer.from(riftHeader); narrowHeader.writeUInt32BE(7); narrowHeader.writeUInt32BE(3, 4);
  const narrow = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', narrowHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(3 * (1 + 7 * 3)))), pngChunk('IEND', Buffer.alloc(0))]);
  expect(() => validateSceneImage(narrow, { width: 7, height: 3 })).not.toThrow();
  const interlacedHeader = Buffer.from(riftHeader); interlacedHeader.writeUInt32BE(1); interlacedHeader.writeUInt32BE(1, 4); interlacedHeader[12] = 1;
  const interlaced = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', interlacedHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(4))), pngChunk('IEND', Buffer.alloc(0))]);
  expect(() => validateSceneImage(interlaced, { width: 1, height: 1 })).not.toThrow();
  const forged = Buffer.from(png); forged.writeUInt32BE(512, 16); forged.writeUInt32BE(512, 20);
  const damaged = Buffer.from(riftPng); damaged[damaged.length - 1]! ^= 1;
  for (const bytes of [forged, damaged, riftPng.subarray(0, 33)]) expect(() => validateSceneImage(bytes)).toThrow();
});

it('scene API timeout rejects the waiter, leaves no cache and retains uncertain pending usage', async () => {
  const f = await sceneFixture('waiting'); vi.useFakeTimers();
  try {
    const work = f.get(); const rejected = expect(work).rejects.toMatchObject({ name: 'TimeoutError' });
    await f.started;
    await vi.advanceTimersByTimeAsync(180_000); await rejected;
    expect(f.pending[0]!.signal.aborted).toBe(true);
    expect((await f.store.read()).values.sceneImages).toEqual({});
    expect(f.states()).toEqual([{ state: 'pending', count: 1 }]);
  } finally { vi.useRealTimers(); }
});

