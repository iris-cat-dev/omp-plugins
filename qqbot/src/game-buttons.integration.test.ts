import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTick } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PluginServiceContext, PluginStorage, PluginNativeApi } from '@omp-desktop/plugin/server';
import type { OmpAgentCreateOptions, OmpAgentHandle, OmpAgentStream } from '@omp-desktop/client';
import type { InlineKeyboard, InteractionEvent, QQBot, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { ApiClient, ApiError } from '@tencent-connect/qqbot-nodejs/protocol';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey, type Peer } from './state.ts';
import type { Game, GameResult } from './game-api.ts';
import { testEngine, testEngineDirectory, type Player } from '../tests/game-fixture.ts';
import type { PeerQueue } from './queue.ts';
import { SandboxFiles } from './sandbox-files.ts';
import { validateSceneImage } from './scene-images.ts';
import { replyMention } from './transport/reply-target.ts';

interface NativeBody { markdown?: { content: string; force_verify_image_resource?: boolean }; keyboard?: InlineKeyboard; event_id?: string; msg_id?: string; code?: number; msg_type?: number; content?: string; file_type?: number; file_data?: string; srv_send_msg?: boolean; media?: { file_info: string }; file_name?: string; file_size?: number; content_type?: string; md5?: string; sha1?: string; upload_id?: string }
interface NativeRequest { method: string; path: string; body: NativeBody }
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const scene = { title: '灵泉与残阵', description: '灵狐指着泉边石阵说：“青纹遇水聚桥，红纹遇火噬人。”眼前目标是穿过残阵抵达灵泉，岸上旧桥已经折断，青红两道阵纹仍时明时暗。', clues: ['青纹遇水聚桥', '红纹遇火噬人'], choices: ['以水凝桥渡阵', '强用火烧红纹', '沿岸试探退路'] };
const successfulAction = { outcome: 'success', risk: 'safe', feedback: '你引水凝出灵桥，沿着青纹穿过残阵，泉边的灵狐终于放下戒备。' };
const riftDecision = { outcome: 'success', reason: '行动利用眼前线索避开了危险。', narrative: '你顺着石壁稳稳前行，灵狐绕过残阵，在前方停下脚步。' };
type MaterialStage = 'prepare' | 'put' | 'complete';
type SceneKind = 'rift' | 'adventure';
type SceneInvalidation = 'action' | 'exit' | 'access' | 'image-grant' | 'stop' | 'retired' | 'generation';

function displayedIntegers(text: string): number[] {
  return Array.from(text.matchAll(/\d[\d,]*/gu), match => Number(match[0].replaceAll(',', '')));
}

function expectCommands(keyboard: InlineKeyboard, commands: string[], senderId = 'player') {
  const buttons = keyboard.content.rows.flatMap(row => row.buttons);
  expect(buttons).toHaveLength(commands.length);
  for (const [index, button] of buttons.entries()) {
    expect(button.action).toMatchObject({ type: 1, permission: { type: 0, specify_user_ids: [senderId] } });
    expect(JSON.parse(button.action.data)).toMatchObject({ t: 'game', g: 9, a: 'choose', i: index });
    expect(button.action.unsupport_tips?.split('：').slice(1).join('：')).toBe(commands[index]);
  }
}

function png512() {
  const chunk = (kind: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(kind), bytes]);
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([size, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(512, 0); ihdr.writeUInt32BE(512, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(512 * (1 + 512 * 3), 0))), chunk('IEND', Buffer.alloc(0))]);
}

interface StagedSandboxFiles {
  read(path: string, maxBytes?: number): Buffer;
  write(path: string, bytes: Buffer, options?: { exclusive?: boolean }): void;
  list(path: string): Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>;
  mkdir(path: string): void; remove(path: string): void; close(): void;
}
interface ImageRegistry { registerProvider(name: string, config: Record<string, unknown>, source: string): void }
interface StagedSession {
  getToolByName(name: string): { execute(id: string, args: unknown, signal?: AbortSignal): Promise<{ details?: Record<string, unknown>; isError?: boolean }> } | undefined;
  dispose(): Promise<void>;
}
interface StagedSdk {
  Settings: { isolated(values: Record<string, unknown>): unknown };
  SessionManager: { inMemory(root: string): unknown };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: StagedSession }>;
  openSandboxFs(options: { root: string; maxBytes: number }): Promise<StagedSandboxFiles>;
}
let stagedSdk: Promise<StagedSdk> | undefined;

async function sandboxFixture(root: string, maxBytes: number) {
  const sdkRoot = process.env.OMP_DESKTOP_TEST_SDK_ROOT;
  if (!sdkRoot || !isAbsolute(sdkRoot) || !existsSync(join(sdkRoot, 'dist/node/modules.json'))) {
    throw new Error('Native rift image integration requires OMP_DESKTOP_TEST_SDK_ROOT pointing to the installed Desktop Node SDK.');
  }
  stagedSdk ??= import(/* @vite-ignore */ pathToFileURL(join(sdkRoot, 'dist/node/sdk.mjs')).href) as Promise<StagedSdk>;
  const sdk = await stagedSdk;
  const pinned = await sdk.openSandboxFs({ root, maxBytes });
  const native = { invoke: async (operation: string, input: unknown) => {
    if (operation !== 'files.sandbox') throw new Error(`Unexpected native operation: ${operation}`);
    const request = input as { action: string; path: string; contentBase64: string; maxBytes: number; exclusive: boolean };
    if (request.action === 'open') return { handle: 'staged-native-files' };
    if (request.action === 'close') { pinned.close(); return { ok: true }; }
    if (request.action === 'read') return { contentBase64: pinned.read(request.path, request.maxBytes).toString('base64') };
    if (request.action === 'write') { pinned.write(request.path, Buffer.from(request.contentBase64, 'base64'), { exclusive: request.exclusive }); return { ok: true }; }
    if (request.action === 'mkdir') { pinned.mkdir(request.path); return { ok: true }; }
    if (request.action === 'list') return { entries: pinned.list(request.path) };
    if (request.action === 'remove') { pinned.remove(request.path); return { ok: true }; }
    throw new Error(`Unexpected sandbox action: ${request.action}`);
  } } as PluginNativeApi;
  const files = await SandboxFiles.open(native, root, maxBytes);
  cleanups.push(() => files.close());
  return { sdk, native, files };
}

async function imageFixture(root: string) {
  const { sdk, native, files } = await sandboxFixture(root, 8 * 1024 * 1024);
  const png = png512(); validateSceneImage(png);
  const entered = Promise.withResolvers<void>();
  void entered.promise.catch(() => {});
  const providerRequests: Array<Record<string, unknown>> = [];
  let gate: Promise<void> | undefined;
  let failure = false;
  const uploads: Array<{ url: string; bytes: Buffer; headers: Headers }> = [];
  let uploadGate: (() => Promise<void>) | undefined;
  let uploadFailure = false;
  // Only the external image provider is replaced. generate_image, its metadata
  // and both descriptor-bound SandboxFs handles are the installed Desktop SDK.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/^https:\/\/qq-scene-upload\.fixture\/upload-\d+$/.test(url)) {
      const request = new Request(input, options);
      expect(request.method).toBe('PUT');
      expect(request.headers.get('content-type')).toBe('image/png');
      expect(request.headers.has('authorization')).toBe(false);
      const bytes = Buffer.from(await request.arrayBuffer());
      validateSceneImage(bytes); expect(bytes).toEqual(png);
      uploads.push({ url, bytes, headers: request.headers });
      await uploadGate?.(); request.signal.throwIfAborted();
      if (uploadFailure) return new Response(null, { status: 500 });
      return new Response(null, { status: 200, headers: { ETag: `"${createHash('md5').update(bytes).digest('hex')}"` } });
    }
    if (url !== 'http://native-image.fixture/v1/images/generations') throw new Error(`Unexpected image network request: ${url}`);
    providerRequests.push(JSON.parse(String(options?.body)));
    entered.resolve(); await gate;
    if (failure) return Response.json({ error: { message: 'fixture image provider failed' } }, { status: 400 });
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  });
  const agentDir = join(root, 'image-agent'); await mkdir(agentDir);
  const model = { id: 'fixture-chat', name: 'fixture chat', api: 'openai-completions', provider: 'fixture-chat', baseUrl: 'http://unused-chat.fixture/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, sandbox: { root, javascript: false, imageGeneration: true },
    model, sessionManager: sdk.SessionManager.inMemory(root), settings: sdk.Settings.isolated({ 'memory.backend': 'off' }),
    setupModelRegistry: async (registry: ImageRegistry) => registry.registerProvider('fixture-chat', { api: model.api, baseUrl: model.baseUrl, apiKey: 'fixture-chat-only', models: [model] }, '<test>'),
    sandboxImageSettings: async (registry: ImageRegistry) => {
      registry.registerProvider('fixture-image', { api: 'openai-images', baseUrl: 'http://native-image.fixture/v1', apiKey: 'fixture-image-only',
        models: [{ ...model, baseUrl: 'http://native-image.fixture/v1', id: 'gpt-image-1', name: 'fixture image', api: 'openai-images', provider: 'fixture-image', kind: 'image', input: ['text', 'image'], contextWindow: 0, maxTokens: 0 }] }, '<test>');
      return { prepare: (_id: string, params: Record<string, unknown>) => ({ ...params, model: 'fixture-image/gpt-image-1' }), dispose() {} };
    },
  });
  cleanups.push(() => session.dispose());
  const tool = session.getToolByName('generate_image');
  if (!tool) throw new Error('Installed Desktop SDK did not mount native generate_image');
  return { files, native, png, tool, providerRequests, entered, uploads,
    hold: (promise: Promise<void>) => { gate = promise; }, fail: () => { failure = true; },
    holdUpload: (hook: () => Promise<void>) => { uploadGate = hook; }, failUpload: () => { uploadFailure = true; } };
}

async function fixture(scope: 'group' | 'c2c' = 'group', textChunkLimit = 4500, maxQueue = 20, imageGeneration = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qqbot-game-buttons-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { createGame, openStore, data, encounters } = await testEngine(root);
  const databasePath = join(root, 'fixture.sqlite');
  const game = createGame({ databasePath, now: () => Date.parse('2026-11-14T01:00:00Z'), random: () => 0 });
  let values = StateSchema.parse({ config: { appId: 'app', sandboxPath: root, sandboxCapabilities: { imageGeneration }, game: { enabled: true, engineDirectory: testEngineDirectory }, streaming: false, autoCompactTokens: 0, textChunkLimit, maxQueue } });
  const store = new StateStore({ get: async () => ({ revision: 0, values: structuredClone(values) }), patch: async (patch: unknown) => { values = StateSchema.parse(patch); return { revision: 0, values }; } } as PluginStorage);
  const reviewResponses = [JSON.stringify(scene)];
  const reviewEntered = Promise.withResolvers<void>();
  void reviewEntered.promise.catch(() => {});
  let reviewGate: Promise<void> | undefined;
  let heldReviewEntered: PromiseWithResolvers<void> | undefined;
  const images = imageGeneration ? await imageFixture(root) : undefined;
  const mediaFiles = images ?? await sandboxFixture(root, values.config.media.maxMB * 1024 * 1024);
  const imageWork: Promise<unknown>[] = [];
  const imageChildren: Array<{ id: string; stop: Mock<() => Promise<void>>; archive: Mock<() => Promise<{ archivedAt: string }>>; unsubscribe: Mock<() => void> }> = [];
  const create = vi.fn(async (options: OmpAgentCreateOptions) => {
    if (options.config?.sandbox?.imageGeneration) {
      if (!images) throw new Error('Images disabled in this fixture');
      const id = `native-image-${imageChildren.length + 1}`;
      const turnId = `${id}-turn`;
      let receive: (stream: OmpAgentStream) => void = () => {};
      let metadata: Record<string, unknown> | undefined;
      const snapshot = { pendingPermissions: [], activeTurn: null, status: 'idle', sandbox: options.config.sandbox };
      const child = { id, stop: vi.fn(async () => {}), archive: vi.fn(async () => ({ archivedAt: '2026-11-14T01:00:00Z' })), unsubscribe: vi.fn(),
        observe: async (handler: typeof receive) => { receive = handler; return { snapshot, unsubscribe: child.unsubscribe, timeline: { entries: [], window: { maxSeq: 0 } } }; },
        run: (prompt: string, runOptions: { signal: AbortSignal }) => {
          const work = (async () => {
            receive({ seq: 1, event: { type: 'turn_started', turnId } } as OmpAgentStream);
            // The mocked LLM consumes the structured scene brief and emits a
            // tool call; the brief itself is not generate_image's arguments.
            const sceneBrief = JSON.parse(prompt.split('\n', 1)[0]!) as { title: string; description: string };
            const params = { subject: `仙侠秘境环境全景：${sceneBrief.title}。${sceneBrief.description}` };
            const result = await images.tool.execute(`${id}-generate`, params, runOptions.signal);
            if (result.isError || !result.details) throw new Error('Native image tool failed without metadata');
            metadata = result.details;
            receive({ seq: 2, event: { type: 'timeline', turnId, item: { type: 'tool_call', name: 'generate_image', callId: `${id}-generate`, status: 'completed', revision: 1, metadata } } } as OmpAgentStream);
            receive({ seq: 3, event: { type: 'turn_completed', turnId } } as OmpAgentStream);
            return { status: 'idle', error: null, final: snapshot };
          })();
          imageWork.push(work.catch(error => { images.entered.reject(error); })); return work;
        },
        timeline: { refetch: async () => ({ agentId: id, projection: 'canonical', entries: [{ seqStart: 2, seqEnd: 2, turnId, item: { type: 'tool_call', name: 'generate_image', callId: `${id}-generate`, status: 'completed', revision: 1, metadata } }], error: null, hasOlder: false, hasNewer: false, gap: false }) },
        respondToPermission: async () => {},
      };
      imageChildren.push(child); return child;
    }
    let text = '';
    const snapshot = { pendingPermissions: [], activeTurn: null, status: 'idle', sandbox: options.config?.sandbox };
    return { id: 'scene-review', observe: async () => ({ snapshot, unsubscribe: () => {}, timeline: {} }),
      run: async () => { reviewEntered.resolve(); heldReviewEntered?.resolve(); heldReviewEntered = undefined; await reviewGate; const response = reviewResponses.shift(); if (response === undefined) throw new Error('Review fixture exhausted'); text = response; return { status: 'idle', error: null, final: snapshot }; },
      timeline: { refetch: async () => ({ entries: [{ seqStart: 1, seqEnd: 1, item: { type: 'assistant_message', text, messageId: 'review-result' } }], error: null, hasOlder: false, hasNewer: false, gap: false }) },
      stop: async () => {}, archive: async () => ({ archivedAt: '2026-11-14T01:00:00Z' }), respondToPermission: async () => {} };
  });
  const ctx = { signal: new AbortController().signal, installation: { id: 'buttons-fixture', generation: 9 }, native: mediaFiles.native,
    omp: { hostId: 'host', agents: { create, ref: () => { throw new Error('Unexpected parent ref'); } } } } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn((message: string) => {
    const error = new Error(message);
    reviewEntered.reject(error); heldReviewEntered?.reject(error); heldReviewEntered = undefined;
    images?.entered.reject(error); imageDelivered.reject(error);
  }) };
  const requests: NativeRequest[] = [];
  let failMessage: Error | undefined;
  let failKeyboardOnly = false;
  let materialFailure: MaterialStage | undefined;
  const materialHooks = new Map<MaterialStage, () => Promise<void>>();
  const prepared = new Map<string, string>();
  const acked = Promise.withResolvers<void>();
  const imageDelivered = Promise.withResolvers<void>();
  const imageFailed = Promise.withResolvers<void>();
  void imageDelivered.promise.catch(() => {});
  // Install below Gateway before construction, so its route/config/access/ALS
  // guards still wrap every real SDK upload and final QQ message request.
  vi.spyOn(ApiClient.prototype, 'request').mockImplementation(async (_token, method, path, body) => {
    requests.push({ method, path, body: body as NativeBody });
    if (path.startsWith('/interactions/')) acked.resolve();
    if (/\/messages$/.test(path) && failMessage && (!failKeyboardOnly || (body as NativeBody).keyboard)) { const error = failMessage; failMessage = undefined; throw error; }
    if (path === '/v2/media-images/prepare') {
      if (!images) throw new Error('Unexpected scene material while images are disabled');
      const payload = body as NativeBody;
      expect(method).toBe('POST');
      expect(payload).toMatchObject({ file_size: images.png.length, content_type: 'image/png',
        md5: createHash('md5').update(images.png).digest('hex'), sha1: createHash('sha1').update(images.png).digest('hex') });
      expect(payload.file_name).toMatch(/\.png$/);
      await materialHooks.get('prepare')?.();
      if (materialFailure === 'prepare') throw new ApiError('fixture prepare failed', 503, path);
      const uploadId = `upload-${prepared.size + 1}`;
      prepared.set(uploadId, payload.md5!);
      return { upload_id: uploadId, presigned_url: `https://qq-scene-upload.fixture/${uploadId}`, expires_in: 60 } as never;
    }
    if (path === '/v2/media-images/complete') {
      const payload = body as NativeBody;
      expect(method).toBe('POST');
      expect(prepared.get(payload.upload_id!)).toBe(payload.md5);
      await materialHooks.get('complete')?.();
      if (materialFailure === 'complete') throw new ApiError('fixture complete failed', 503, path);
      return { image_id: `image-${payload.upload_id}`, url: `qqbot-media://image/v1/${payload.upload_id}`, ttl: 60,
        preview_url: `https://qq-scene-preview.fixture/${payload.upload_id}` } as never;
    }
    if (/\/files$/.test(path)) throw new Error('Scene image must use Markdown materials, not the independent /files endpoint');
    const markdown = (body as NativeBody)?.markdown?.content;
    if (markdown?.includes('qqbot-media://image/v1/')) imageDelivered.resolve();
    else if (markdown && game.getPlayers(peerKey('app', scope, scope === 'group' ? 'group' : 'player')).some(player => {
      const description = player.riftAdventure?.scene.description ?? player.adventure?.scene?.description;
      return description && markdown.includes(description);
    })) imageFailed.resolve();
    return { id: `reply-${requests.length}` } as never;
  });
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-only-secret', logger, vi.fn());
  cleanups.push(() => gateway.dispose());
  const peer: Peer = { appId: 'app', scope, openid: scope === 'group' ? 'group' : 'player', hostId: 'host', agentId: 'agent', workspaceId: 'workspace', cwd: root, sandbox: { root, ...(imageGeneration ? { imageGeneration: true } : {}) }, preset: 'default', template: values.config.presets[0]!, protocolPrompt: game.host.protocol.prompt, lastDeliveredSequence: 0 };
  const route = { peer, agent: {} as OmpAgentHandle, unsubscribe: null, buffer: null, textRows: new Map(), files: new Map(), toolRevisions: new Map(), chain: Promise.resolve(), pending: new Map(), lastSeq: 0, enabledDelivery: false, turnId: undefined as string | undefined, sceneImages: new Map<string, { controller: AbortController }>() };
  const internal = gateway as unknown as {
    bot: QQBot & { handleInboundMessage(message: Omit<QQBotInboundMessage, 'replyTarget'>): Promise<void>; emit(event: 'interaction', context: unknown, value: InteractionEvent): Promise<void> };
    game: Game | null; routes: Map<string, typeof route>; getOrCreate(): Promise<typeof route>;
    queue: PeerQueue;
    root: string; files: SandboxFiles | null; retireRoute(route: typeof route): void;
    event(route: typeof route, stream: OmpAgentStream): Promise<void>;
  };
  internal.game = game.host;
  internal.root = root; internal.files = mediaFiles.files;
  internal.routes.set(peerKey(peer.appId, peer.scope, peer.openid), route);
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  const sceneResults: Array<{ senderId: string; result: GameResult }> = [];
  const handleMessage = game.host.handleMessage.bind(game.host);
  game.host.handleMessage = async event => {
    const result = await handleMessage(event);
    if (result.sceneImage) sceneResults.push({ senderId: event.userId, result });
    return result;
  };
  const resolveReview = game.host.resolveReview.bind(game.host);
  game.host.resolveReview = event => {
    const result = resolveReview(event);
    if (result.sceneImage) sceneResults.push({ senderId: event.userId, result });
    return result;
  };
  const sceneResult = (player: Player, kind: SceneKind, senderId = 'player') => {
    const adventure = kind === 'rift' ? player.riftAdventure : player.adventure;
    if (!adventure?.scene) throw new Error('Expected a real current scene result');
    const currentScene = adventure.scene;
    const entry = sceneResults.findLast(observed => {
      const image = observed.result.sceneImage;
      return observed.senderId === senderId && image?.sceneId === currentScene.id && image.title === currentScene.title
        && image.description === currentScene.description
        && game.host.getSceneState(peerKey(peer.appId, peer.scope, peer.openid), senderId, image) !== 'obsolete';
    });
    if (!entry) throw new Error('Expected the actual engine result for this scene request');
    return entry.result;
  };
  let sequence = 0;
  const chatResponses: string[] = [];
  const agent = { id: 'agent', configuration: vi.fn(async () => ({ ...peer.template.config, cwd: root, sandbox: peer.sandbox })), refresh: vi.fn(async () => ({ agent: { id: 'agent', provider: 'omp', model: 'fixture', activeTurn: null } })), stop: vi.fn(async () => {}), send: vi.fn(async (text: string, options: { messageId: string }) => {
    const response = chatResponses.shift();
    if (response === undefined) throw new Error('Chat fixture exhausted');
    const turnId = options.messageId;
    route.chain = route.chain.then(async () => {
      for (const event of [
        { type: 'turn_started', turnId },
        { type: 'timeline', turnId, item: { type: 'user_message', text, clientMessageId: options.messageId } },
        { type: 'timeline', turnId, item: { type: 'assistant_message', text: response, messageId: `${turnId}-reply` } },
        { type: 'turn_completed', turnId },
      ]) await internal.event(route, { seq: ++sequence, event } as OmpAgentStream);
    }).catch(error => { for (const pending of route.pending.values()) pending.fail(error); });
  }) };
  route.agent = agent as unknown as OmpAgentHandle;
  vi.spyOn(internal.bot.tokenManager, 'getAccessToken').mockResolvedValue('fixture-token');
  const nativeSend = internal.bot.send.bind(internal.bot);
  let beforeSceneSend: (() => Promise<void>) | undefined;
  vi.spyOn(internal.bot, 'send').mockImplementation(async options => {
    const content = options.markdown?.content;
    if (content && game.getPlayers(peerKey('app', scope, peer.openid)).some(player => {
      const description = player.riftAdventure?.scene.description ?? player.adventure?.scene?.description;
      return description && content.includes(description);
    })) await beforeSceneSend?.();
    return nativeSend(options);
  });
  let messageIndex = 0;
  const send = (content: string, senderId = 'player', mentions: NonNullable<QQBotInboundMessage['mentions']> = []) => internal.bot.handleInboundMessage({
    kind: scope, rawEventType: scope === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    ...(scope === 'group' ? { groupOpenid: peer.openid } : {}),
    messageId: `message-${++messageIndex}`, timestamp: '2026-11-14T01:00:00Z', senderId, senderName: '同名', senderIsBot: false,
    content: scope === 'group' ? `<@app> ${content}` : content,
    mentions: scope === 'group' ? [{ id: 'app', is_you: true }, ...mentions] : [],
    raw: scope === 'group' ? { id: `message-${messageIndex}`, group_openid: peer.openid, author: { member_openid: senderId }, content, timestamp: '2026-11-14T01:00:00Z' } : { id: `message-${messageIndex}`, author: { user_openid: senderId }, content, timestamp: '2026-11-14T01:00:00Z' },
  } as Omit<QQBotInboundMessage, 'replyTarget'>);
  const messages = () => requests.filter(request => /\/messages$/.test(request.path));
  const choice = (command?: string) => {
    const buttons = messages().findLast(request => request.body.keyboard)?.body.keyboard!.content.rows.flatMap(row => row.buttons) ?? [];
    const current = game.getPlayer(peerKey(peer.appId, peer.scope, peer.openid), 'player');
    const sceneChoices = current?.adventure?.scene?.choices;
    const index = sceneChoices?.indexOf(scene.choices[0]) ?? -1;
    const sceneCommand = index >= 0 ? `历练 ${index + 1}` : undefined;
    const selectedCommand = command ?? sceneCommand;
    const selected = command
      ? buttons.find(button => button.action.unsupport_tips === `请发送：${command}`)
      : buttons.find(button => sceneCommand && button.action.unsupport_tips === `请发送：${sceneCommand}`) ?? buttons[0];
    if (!selected) throw new Error(`Native game choice not offered: ${selectedCommand ?? 'first command'}`);
    return selected.action.data;
  };
  const click = (raw: string, patch: Partial<InteractionEvent> = {}) => {
    const value: InteractionEvent = { id: `click-${++messageIndex}`, type: 11, scene: scope, chat_type: scope === 'group' ? 1 : 2, version: 1,
      ...(scope === 'group' ? { group_openid: peer.openid, group_member_openid: 'player' } : { user_openid: peer.openid }),
      data: { type: 11, resolved: { button_data: raw } }, ...patch };
    return internal.bot.emit('interaction', { bot: internal.bot, event: value, state: {}, receivedAt: Date.now() }, value);
  };
  const player = (senderId = 'player') => game.getPlayer(peerKey(peer.appId, peer.scope, peer.openid), senderId);
  const persistedPlayer = (senderId = 'player') => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT state FROM players WHERE group_id = ? AND user_id = ?')
        .get(peerKey(peer.appId, peer.scope, peer.openid), senderId) as { state: string } | undefined;
      return row ? JSON.parse(row.state) as Player : null;
    } finally { database.close(); }
  };
  const change = (update: (player: Player) => void, senderId = 'player') => { const current = player(senderId)!; update(current); const storage = openStore(databasePath); try { storage.save(peerKey(peer.appId, peer.scope, peer.openid), current); } finally { storage.close(); } };
  const seedBosses = () => {
    const storage = openStore(databasePath);
    try {
      const world = storage.getWorld(peerKey(peer.appId, peer.scope, peer.openid));
      const exp = data.realms[0]!.exp; const multipliers = encounters.boss.multipliers;
      const maxHp = Math.floor(exp * multipliers.hp);
      world.bosses = encounters.boss.names.slice(0, 2).map((name, i) => ({ name, realm: 0, hp: i ? maxHp : 1, maxHp,
        mp: Math.floor(exp * multipliers.mp), attack: Math.floor(exp * multipliers.attack), money: Math.floor(exp * multipliers.money) }));
      world.bossGeneratedAt = Date.parse('2026-11-14T01:00:00Z');
      storage.saveWorld(peerKey(peer.appId, peer.scope, peer.openid), world);
    } finally { storage.close(); }
  };
  const adventure = async () => { await send('我要修仙'); await send('历练'); };
  const rift = async () => { await send('我要修仙'); await send('秘境探索'); };
  const invalidateScene = async (kind: SceneKind, invalidation: SceneInvalidation) => {
    if (invalidation === 'action') {
      const current = player()!;
      reviewResponses.splice(0, reviewResponses.length, JSON.stringify(kind === 'rift' ? riftDecision : successfulAction));
      await send(kind === 'rift' ? `秘境行动 ${current.riftAdventure!.id} ${current.riftAdventure!.round} 1` : '历练 1');
    }
    if (invalidation === 'exit') await send(kind === 'rift' ? '秘境探索终止' : '取消历练');
    if (invalidation === 'access') await store.mutate(state => {
      if (scope === 'group') state.access.groupMode = 'disabled'; else state.access.c2cMode = 'disabled';
    });
    if (invalidation === 'image-grant') await store.mutate(state => { state.config.sandboxCapabilities.imageGeneration = false; });
    if (invalidation === 'stop') await send('/stop');
    if (invalidation === 'retired') internal.retireRoute(route);
    if (invalidation === 'generation') gateway.dispose();
  };
  const nativeImagesReady = async () => { await nextTick(); await Promise.all(imageWork); await nextTick(); };
  const drainImages = async () => {
    await nativeImagesReady();
    const deadline = performance.now() + 5000;
    while (route.sceneImages.size && performance.now() < deadline) await nextTick();
    if (route.sceneImages.size) throw new Error('Scene delivery did not finish after native image work');
    await nextTick();
  };
  return { gateway, internal, game, route, agent, store, logger, requests, messages, send, click, choice, player, persistedPlayer, change, seedBosses, adventure, rift, acked, chatResponses, reviewResponses, reviewEntered,
    images, imageChildren, create, drainImages, nativeImagesReady, sceneResult, imageDelivered, imageFailed, invalidateScene,
    holdMaterial: (stage: MaterialStage, hook: () => Promise<void>) => { if (stage === 'put') images!.holdUpload(hook); else materialHooks.set(stage, hook); },
    failMaterial: (stage: MaterialStage) => { if (stage === 'put') images!.failUpload(); else materialFailure = stage; },
    beforeSceneSend: (hook: () => Promise<void>) => { beforeSceneSend = hook; },
    holdReview: (gate: Promise<void>) => { reviewGate = gate; const entered = Promise.withResolvers<void>(); void entered.promise.catch(() => {}); heldReviewEntered = entered; return entered.promise; }, failNextMessage: (error: Error, keyboardOnly = false) => { failMessage = error; failKeyboardOnly = keyboardOnly; } };
}

it.each(['group', 'c2c'] as const)('real %s inbound choices produce native buttons and a click settles the original player once', async scope => {
  const f = await fixture(scope);
  await f.adventure();
  const keyboard = f.messages().at(-1)!.body.keyboard!;
  for (const button of keyboard.content.rows[0]!.buttons) {
    expect(button.action).toMatchObject({ type: 1, permission: { type: 0, specify_user_ids: ['player'] } });
    expect(JSON.parse(button.action.data)).toMatchObject({ t: 'game', g: 9, a: 'choose' });
  }
  const before = structuredClone(f.player())!;
  const command = f.choice();
  const handle = vi.spyOn(f.game, 'handleMessage');
  f.reviewResponses.push(JSON.stringify(successfulAction));
  await f.click(command);
  const after = f.player()!;
  expect(after.adventure).toMatchObject({ status: 'settled' });
  expect(after.storyThread!.beats.at(-1)!.action).toBe(scene.choices[0]);
  expect(after.exp - before.exp).toBe(before.adventure!.options[0]!.expGain);
  expect(after.money - before.money).toBe(before.adventure!.options[0]!.moneyGain);
  const reply = f.messages().at(-1)!;
  expect(reply.body.event_id).toMatch(/^INTERACTION_CREATE:click-/);
  expect(reply.body.msg_id).toBeUndefined();
  expect(reply.path).toBe(scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages');
  expect(reply.body.markdown!.content.startsWith('<qqbot-at-user id="player" />\n')).toBe(scope === 'group');
  const ack = f.requests.findIndex(request => request.path.startsWith('/interactions/'));
  expect(ack).toBeGreaterThanOrEqual(0);
  expect(ack).toBeLessThan(f.requests.indexOf(reply));
  const settled = structuredClone(after);
  await f.click(command);
  expect(handle).toHaveBeenCalledOnce();
  expect(f.player()).toEqual(settled);
  expect(f.requests.at(-1)!.body.code).toBe(3);
});

it('a changed shared world invalidates an old boss button without silently attacking the next boss', async () => {
  const f = await fixture();
  await f.send('我要修仙', 'other'); await f.send('我要修仙');
  f.seedBosses(); await f.send('邪魔查询');
  const raw = f.choice(); const before = structuredClone(f.player());
  await f.send('讨伐邪魔 1', 'other');
  expect(f.player('other')!.journey.at(-1)).toMatchObject({ type: 'boss', killed: true });
  await f.click(raw);
  expect(f.player()).toEqual(before);
});

it('fresh adventure buttons work after stopping a completed chat turn without reviving old buttons', async () => {
  const f = await fixture();
  f.chatResponses.push('道友安好。');
  await f.send('你好');
  await f.adventure();
  const old = f.choice();
  await f.send('/stop');
  await f.send('历练');
  const fresh = f.choice();
  const before = structuredClone(f.player())!;
  await f.click(old);
  expect(f.player()).toEqual(before);
  f.reviewResponses.push(JSON.stringify(successfulAction));
  await f.click(fresh);
  const after = f.player()!;
  expect(after.adventure).toMatchObject({ status: 'settled' });
  expect(after.storyThread!.beats.at(-1)!.action).toBe(scene.choices[0]);
  expect(after.exp - before.exp).toBe(before.adventure!.options[0]!.expGain);
  expect(after.money - before.money).toBe(before.adventure!.options[0]!.moneyGain);
});

it.each(['other-player', 'other-group', 'wrong-scope', 'expired', 'new-turn', 'new-scene', 'new-round', 'new-generation', 'revoked', 'busy', 'stopped'] as const)('invalid %s buttons never execute or change player resources', async invalid => {
  const f = await fixture();
  await f.adventure();
  let raw = f.choice();
  let patch: Partial<InteractionEvent> = {};
  if (invalid === 'other-player') patch = { group_member_openid: 'other' };
  if (invalid === 'other-group') patch = { group_openid: 'other-group' };
  if (invalid === 'wrong-scope') patch = { scene: 'c2c', user_openid: 'player' };
  if (invalid === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  if (invalid === 'new-turn') f.route.turnId = 'replacement-turn';
  if (invalid === 'new-scene') f.change(player => { player.adventure!.scene!.id = 'replacement-scene'; player.adventure!.revision++; });
  if (invalid === 'new-round') f.change(player => { player.adventure!.revision++; });
  if (invalid === 'new-generation') raw = JSON.stringify({ ...JSON.parse(raw), g: 8 });
  if (invalid === 'revoked') await f.store.mutate(state => { state.access.groupMode = 'disabled'; });
  if (invalid === 'busy') f.agent.refresh.mockResolvedValueOnce({ agent: { id: 'agent', provider: 'omp', model: 'fixture', activeTurn: { turnId: 'desktop' } as never } });
  if (invalid === 'stopped') await f.send('/stop');
  const before = structuredClone(f.player());
  const handle = vi.spyOn(f.game, 'handleMessage');
  const resolve = vi.spyOn(f.game.host, 'resolveReview');
  await f.click(raw, patch);
  expect(handle).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(f.player()).toEqual(before);
  expect(f.player('other')).toBeNull();
});

it('acks promptly while an earlier group message owns the queue, then settles in the same serial queue', async () => {
  const f = await fixture();
  await f.adventure();
  const raw = f.choice();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.game.handleMessage.bind(f.game);
  const handle = vi.spyOn(f.game, 'handleMessage').mockImplementationOnce(async input => { entered.resolve(); await release.promise; return original(input); });
  const earlier = f.send('状态', 'other');
  await entered.promise;
  const before = structuredClone(f.player());
  f.reviewResponses.push(JSON.stringify(successfulAction));
  const clicked = f.click(raw);
  try {
    await f.acked.promise;
    expect(handle).toHaveBeenCalledOnce();
    expect(f.player()).toEqual(before);
    release.resolve();
    await Promise.all([earlier, clicked]);
    expect(f.player()!.adventure!.status).toBe('settled');
  } finally { release.resolve(); await Promise.allSettled([earlier, clicked]); }
});

it('long game output attaches exactly one keyboard, counts each mention, and keeps text inputs working', async () => {
  const f = await fixture('group', 200);
  await f.send('我要修仙');
  const start = f.messages().length;
  await f.send('历练');
  const parts = f.messages().slice(start);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.filter(part => part.body.keyboard)).toHaveLength(1);
  expect(parts.at(-1)!.body.keyboard).toBeDefined();
  for (const part of parts) {
    expect(part.body.markdown!.content.length).toBeLessThanOrEqual(200);
    expect(part.body.markdown!.content).toMatch(/^<qqbot-at-user id="player" \/>\n/);
  }
  const raw = f.choice();
  const selected = String(f.player()!.adventure!.scene!.choices!.indexOf(scene.choices[0]) + 1);
  f.reviewResponses.push(JSON.stringify(successfulAction));
  await f.send(selected);
  expect(f.player()!.adventure).toMatchObject({ status: 'settled', selectedOption: selected });
  const handle = vi.spyOn(f.game, 'handleMessage');
  await f.click(raw);
  expect(handle).not.toHaveBeenCalled();
  f.chatResponses.push('你好，今天山风很柔和。');
  const before = structuredClone(f.player());
  await f.send('今晚吃什么？');
  expect(f.agent.send).toHaveBeenCalledOnce();
  expect(f.player()).toEqual(before);
});

it.each([304037, 11253, 304025, 0])('replays only an explicitly rejected keyboard, never generic permission, safety or network errors (%i)', async code => {
  const f = await fixture();
  await f.send('我要修仙');
  const beforeRequests = f.requests.length;
  f.failNextMessage(new ApiError('QQ fixture rejection', code === 0 ? 0 : 403, '/v2/groups/group/messages', code));
  // Display an awaiting scene directly via the real command, so the failure is the keyboard send.
  const groupId = peerKey('app', 'group', 'group');
  const started = f.game.handleCommand({ groupId, userId: 'player', text: '历练' });
  f.game.resolveReview({ groupId, userId: 'player', kind: 'adventure', requestId: started.reviewRequest!.requestId, revision: started.reviewRequest!.revision, review: scene });
  await f.send('历练');
  const attempts = f.requests.slice(beforeRequests).filter(request => /\/messages$/.test(request.path));
  expect(attempts.length).toBe(code === 304037 ? 2 : 1);
  expect(attempts[0]!.body.keyboard).toBeDefined();
  if (code === 304037) expect(attempts[1]!.body.keyboard).toBeUndefined();
  const before = structuredClone(f.player());
  await f.click(attempts[0]!.body.keyboard!.content.rows[0]!.buttons[0]!.action.data);
  expect(f.player()).toEqual(before);
  await f.send('状态', 'other');
  expect(f.player('other')).toBeNull();
});

it('native inventory menus keep item identities and rejected keyboards expose usable commands', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  f.change(player => { player.inventory = { '10000001': 1, '10010001': 1 }; });
  await f.send('我的背包');
  const native = f.messages().at(-1)!;
  const nativeButtons = native.body.keyboard!.content.rows.flatMap(row => row.buttons);
  for (const id of ['10000001', '10010001']) {
    const button = nativeButtons.find(entry => entry.action.unsupport_tips === `请发送：物品信息 ${id}`);
    expect(button).toBeDefined();
    expect(JSON.parse(button!.action.data)).toMatchObject({ t: 'game', g: 9, a: 'choose', i: nativeButtons.indexOf(button!) });
    const before = structuredClone(f.player());
    await f.click(f.choice(`物品信息 ${id}`));
    expect(f.player()).toEqual(before);
    await f.send('我的背包');
  }
  const start = f.requests.length;
  f.failNextMessage(new ApiError('QQ keyboard rejected', 403, '/v2/groups/group/messages', 304037));
  await f.send('我的背包');
  const attempts = f.requests.slice(start).filter(request => /\/messages$/.test(request.path));
  expect(attempts[0]!.body.keyboard).toBeDefined();
  expect(attempts[1]!.body.keyboard).toBeUndefined();
  expect(attempts[1]!.body.markdown!.content).toContain('物品信息 10000001');
  expect(attempts[1]!.body.markdown!.content).toContain('物品信息 10010001');
  const before = structuredClone(f.player());
  await f.send('物品信息 10000001');
  expect(f.player()).toEqual(before);
});

it('long rejected keyboard sends only its undelivered chunk and complete bounded text commands', async () => {
  const f = await fixture('group', 200);
  await f.send('我要修仙');
  f.change(player => { player.inventory = { '1101': 1, '7001': 1, '6001': 1, '10000001': 1, '10010001': 1 }; });
  const start = f.requests.length;
  f.failNextMessage(new ApiError('QQ keyboard rejected', 403, '/v2/groups/group/messages', 304037), true);
  await f.send('我的背包');
  const attempts = f.requests.slice(start).filter(request => /\/messages$/.test(request.path));
  const rejected = attempts.findIndex(request => request.body.keyboard);
  expect(rejected).toBeGreaterThan(0);
  const delivered = attempts.slice(0, rejected);
  const fallback = attempts.slice(rejected + 1);
  expect(fallback.every(request => !request.body.keyboard)).toBe(true);
  const fallbackBodies = fallback.map(request => request.body.markdown!.content);
  for (const request of delivered) expect(fallbackBodies).not.toContain(request.body.markdown!.content);
  for (const request of [...delivered, ...fallback]) {
    expect(request.body.markdown!.content.length).toBeLessThanOrEqual(200);
    expect(request.body.markdown!.content).toMatch(/^<qqbot-at-user id="player" \/>\n/u);
  }
  const commands = fallbackBodies.join('\n');
  for (const id of ['1101', '7001', '6001', '10000001', '10010001']) expect(commands).toContain(`物品信息 ${id}`);
  const before = structuredClone(f.player());
  await f.click(attempts[rejected]!.body.keyboard!.content.rows[0]!.buttons[0]!.action.data);
  expect(f.player()).toEqual(before);
});

it('a failed interaction send releases the queue without replaying a settled action', async () => {
  const f = await fixture();
  await f.adventure();
  const raw = f.choice();
  f.reviewResponses.push(JSON.stringify(successfulAction));
  f.failNextMessage(new ApiError('network failed', 0, '/v2/groups/group/messages'));
  await f.click(raw);
  expect(f.player()!.adventure!.status).toBe('settled');
  const settled = structuredClone(f.player());
  await f.click(raw);
  expect(f.player()).toEqual(settled);
  await f.send('我要修仙', 'other');
  expect(f.player('other')).not.toBeNull();
});

it('clicking an engine navigation choice acks before the blocked dynamic review and delivers its scene', async () => {
  const f = await fixture();
  const handle = vi.spyOn(f.game, 'handleMessage');
  await f.send('我要修仙');
  const result = await handle.mock.results[0]!.value;
  const index = result.choices!.findIndex(choice => choice.command === '历练');
  expect(index).toBeGreaterThanOrEqual(0);
  const buttons = f.messages().at(-1)!.body.keyboard!.content.rows.flatMap(row => row.buttons);
  const raw = buttons.find(button => JSON.parse(button.action.data).i === index)!.action.data;
  const release = Promise.withResolvers<void>();
  f.holdReview(release.promise);
  const before = structuredClone(f.player())!;
  const work = f.click(raw);
  try {
    await f.reviewEntered.promise;
    expect(f.requests.some(request => request.path.startsWith('/interactions/') && request.body.code === 0)).toBe(true);
    expect(f.player()!.adventure!.status).toBe('generating');
    expect(f.player()!.money).toBe(before.money);
    release.resolve();
    await work;
    expect(f.player()!.adventure).toMatchObject({ status: 'awaiting', scene: { title: scene.title, description: scene.description, clues: scene.clues } });
    expect(new Set(f.player()!.adventure!.scene!.choices)).toEqual(new Set(scene.choices));
    expect(f.messages().at(-1)!.body.keyboard!.content.rows[0]!.buttons).toHaveLength(2);
    expect(f.messages().at(-1)!.body.event_id).toMatch(/^INTERACTION_CREATE:click-/);
  } finally { release.resolve(); await work; }
});

it('free text in the awaiting scene still runs dynamic judgment and invalidates its earlier buttons', async () => {
  const f = await fixture();
  await f.adventure();
  const raw = f.choice();
  const action = '以水点亮青纹，再沿凝成的灵桥穿过残阵。';
  f.chatResponses.push(JSON.stringify({ type: 'game_answer', answer: action }));
  f.reviewResponses.push(JSON.stringify(successfulAction));
  const before = structuredClone(f.player())!;
  await f.send(action);
  expect(f.player()!.adventure!.status).toBe('settled');
  expect(f.player()!.exp).toBeGreaterThan(before.exp);
  expect(f.player()!.storyThread!.beats.at(-1)!.action).toBe(action);
  const settled = structuredClone(f.player());
  const handle = vi.spyOn(f.game, 'handleMessage');
  await f.click(raw);
  expect(handle).not.toHaveBeenCalled();
  expect(f.player()).toEqual(settled);
});

it('queue admission failure consumes the rejected click without blocking the next player', async () => {
  const f = await fixture('group', 4500, 1);
  await f.adventure();
  const raw = f.choice();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.game.handleMessage.bind(f.game);
  vi.spyOn(f.game, 'handleMessage').mockImplementationOnce(async input => { entered.resolve(); await release.promise; return original(input); });
  const first = f.send('状态', 'other');
  await entered.promise;
  const admitted = Promise.withResolvers<void>();
  const enqueue = f.internal.queue.enqueue.bind(f.internal.queue);
  vi.spyOn(f.internal.queue, 'enqueue').mockImplementation((key, run) => { const work = enqueue(key, run); admitted.resolve(); return work; });
  const second = f.send('状态', 'third');
  await admitted.promise;
  const clicked = f.click(raw);
  const before = structuredClone(f.player());
  try {
    await clicked;
    expect(f.player()).toEqual(before);
    release.resolve();
    await Promise.all([first, second]);
    await f.click(raw);
    expect(f.player()).toEqual(before);
    await f.send('我要修仙', 'next-player');
    expect(f.player('next-player')).not.toBeNull();
  } finally { release.resolve(); await Promise.allSettled([first, second, clicked]); }
});

it.each([
  { text: '打劫', mention: { member_openid: 'friend' } },
  { text: '打劫', mention: { id: 'friend' } },
  { text: '抢劫<@friend>', mention: {} },
  { text: '打劫 <@alias>', mention: { member_openid: 'friend', id: 'alias' } },
])('robbery resolves the current group target from $text / $mention', async ({ text, mention }) => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  await f.send('我要修仙', 'private-id');
  const before = [f.player(), f.player('friend'), f.player('private-id')].map(player => structuredClone(player)!);
  await f.send(text, 'player', [mention, { user_openid: 'private-id' }, { member_openid: 'all', scope: 'all' }, { member_openid: 'bot', bot: true }]);
  expect(f.player()!.money).toBe(before[0]!.money + Math.floor(before[1]!.money * 0.1));
  expect(f.player('friend')!.money).toBe(before[1]!.money - Math.floor(before[1]!.money * 0.1));
  expect(f.player('friend')!.hp).toBeGreaterThanOrEqual(1);
  expect(f.player('private-id')).toEqual(before[2]);
});

it('missing robbery targets list saved group players, then settle only the chosen identity once', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'old-player', nickname: '故友', text: '我要修仙' });
  f.game.handleCommand({ groupId: peerKey('app', 'group', 'foreign'), userId: 'foreign', nickname: '外群修士', text: '我要修仙' });
  const before = f.game.getPlayers(groupId);
  await f.send('抢劫@Iris');
  expect(f.game.getPlayers(groupId)).toEqual(before);
  const offered = f.messages().at(-1)!.body;
  const savedTarget = before.find(player => player.userId === 'old-player')!;
  expect(offered.markdown!.content).toContain(savedTarget.name);
  expect(offered.markdown!.content).not.toContain(f.game.getPlayer(peerKey('app', 'group', 'foreign'), 'foreign')!.name);
  const chosen = f.choice(`打劫 <@${savedTarget.userId}>`);
  await f.click(chosen, { group_member_openid: 'friend' });
  await f.click(chosen, { group_openid: 'foreign' });
  expect(f.game.getPlayers(groupId)).toEqual(before);
  await f.click(chosen);
  expect(f.player()!.money).toBe(22000);
  expect(f.player('old-player')!.money).toBe(18000);
  expect(f.player('friend')).toEqual(before.find(player => player.userId === 'friend'));
  const settled = f.game.getPlayers(groupId);
  await f.click(chosen);
  expect(f.game.getPlayers(groupId)).toEqual(settled);
});

it('private-only and multiple group mentions require selection instead of guessing a robbery target', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  await f.send('我要修仙', 'private-id');
  const groupId = peerKey('app', 'group', 'group');
  const before = f.game.getPlayers(groupId);
  await f.send('打劫', 'player', [{ user_openid: 'private-id' }]);
  expect(f.game.getPlayers(groupId)).toEqual(before);
  expect(f.messages().at(-1)!.body.keyboard).toBeDefined();
  await f.send('打劫', 'player', [{ id: 'friend' }, { member_openid: 'private-id' }]);
  expect(f.game.getPlayers(groupId)).toEqual(before);
  expect(f.messages().at(-1)!.body.keyboard).toBeDefined();
});

it('changed target assets invalidate a robbery selection while unrelated group players do not', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  await f.send('打劫');
  const stale = f.choice();
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'friend', text: '修仙签到' });
  const before = f.game.getPlayers(groupId);
  await f.click(stale);
  expect(f.game.getPlayers(groupId)).toEqual(before);
  await f.send('打劫');
  const fresh = f.choice();
  f.game.handleCommand({ groupId: peerKey('app', 'group', 'foreign'), userId: 'unrelated', text: '我要修仙' });
  const money = f.player('friend')!.money;
  await f.click(fresh);
  expect(f.player()!.money).toBe(20000 + Math.floor(money * 0.1));
  expect(f.player('friend')!.money).toBe(money - Math.floor(money * 0.1));
});

it('rejected robbery keyboards provide a text command bound to the same group player', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  f.failNextMessage(new ApiError('QQ keyboard rejected', 403, '/v2/groups/group/messages', 304037), true);
  await f.send('打劫');
  const fallback = f.messages().at(-1)!.body;
  expect(fallback.keyboard).toBeUndefined();
  expect(fallback.markdown!.content).toContain('打劫 <@friend>');
  expect(f.player()!.money).toBe(20000);
  await f.send('打劫 <@friend>');
  expect(f.player()!.money).toBe(22000);
  expect(f.player('friend')!.money).toBe(18000);
});

it('explicit missing-group and self robbery targets remain rejected without selecting someone else', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'friend');
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId: peerKey('app', 'group', 'foreign'), userId: 'foreign', text: '我要修仙' });
  const before = f.game.getPlayers(groupId);
  for (const target of ['foreign', 'player']) {
    await f.send(`打劫 <@${target}>`);
    expect(f.game.getPlayers(groupId)).toEqual(before);
    expect(f.messages().at(-1)!.body.keyboard).toBeUndefined();
  }
});


it.each(['group', 'c2c'] as const)('real %s inventory, dismantle menu and confirmation buttons atomically settle equipment once', async scope => {
  const f = await fixture(scope);
  await f.send('我要修仙');
  f.change(player => { player.inventory = { '7001': 2, '7002': 1, '6001': 1, '1101': 3 }; player.equipment.weapon = null; player.equipment.armor = null; });
  const initial = structuredClone(f.player())!;
  expect(initial.pendingDismantle).toBeNull();
  await f.send('我的背包');
  await f.click(f.choice('装备分解'));
  expect(f.player()).toEqual(initial);
  await f.click(f.choice('装备分解 7001 1'));
  const preview = structuredClone(f.player())!;
  const pending = preview.pendingDismantle!;
  expect(pending).toMatchObject({ itemId: '7001', count: 1, moneyGain: 800, expiresAt: Date.parse('2026-11-14T01:05:00Z') });
  expect(preview.inventory).toEqual(initial.inventory);
  expect(preview.money).toBe(initial.money);
  expect(preview.equipment).toEqual(initial.equipment);
  expect(f.persistedPlayer()).toEqual(preview);
  const confirmation = f.choice(`确认分解 ${pending.id}`);
  expect(f.choice(`取消分解 ${pending.id}`)).toBeDefined();
  const button = f.messages().at(-1)!.body.keyboard!.content.rows.flatMap(row => row.buttons)
    .find(choice => choice.action.unsupport_tips === `请发送：确认分解 ${pending.id}`)!;
  expect(button.action.permission).toEqual({ type: 0, specify_user_ids: ['player'] });
  const handle = vi.spyOn(f.game, 'handleMessage');
  await f.click(confirmation);
  const settled = structuredClone(f.player())!;
  expect(settled.inventory).toEqual({ ...initial.inventory, '7001': 1 });
  expect(settled.money).toBe(initial.money + 800);
  expect(settled.equipment).toEqual(initial.equipment);
  expect(settled.pendingDismantle).toBeNull();
  expect(settled.journey.at(-1)).toMatchObject({ type: 'dismantle', itemId: '7001', itemName: '精铁符剑', count: 1, moneyGain: 800 });
  expect(f.persistedPlayer()).toEqual(settled);
  const reply = f.messages().at(-1)!;
  expect(reply.path).toBe(scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages');
  expect(reply.body.event_id).toMatch(/^INTERACTION_CREATE:click-/);
  expect(reply.body.msg_id).toBeUndefined();
  await f.click(confirmation);
  expect(handle).toHaveBeenCalledOnce();
  expect(f.requests.at(-1)!.body.code).toBe(3);
  expect(f.player()).toEqual(settled);
  await f.send(`确认分解 ${pending.id}`);
  expect(f.player()).toEqual(settled);
  expect(f.persistedPlayer()).toEqual(settled);
  expect(f.agent.send).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each(['group', 'c2c'] as const)('real %s equipment information exposes preview and cancellation preserves every asset', async scope => {
  const f = await fixture(scope);
  await f.send('我要修仙');
  f.change(player => { player.inventory = { '6001': 3, '7001': 1, '1101': 2 }; player.equipment.weapon = null; player.equipment.armor = null; });
  const initial = structuredClone(f.player())!;
  await f.send('我的背包');
  await f.click(f.choice('物品信息 6001'));
  await f.click(f.choice('装备分解 6001 1'));
  const pending = f.player()!.pendingDismantle!;
  expect(pending).toMatchObject({ itemId: '6001', count: 1, moneyGain: 600 });
  const cancel = f.choice(`取消分解 ${pending.id}`);
  await f.click(cancel);
  expect(f.player()).toEqual(initial);
  expect(f.persistedPlayer()).toEqual(initial);
  await f.click(cancel);
  expect(f.player()).toEqual(initial);
  expect(f.requests.at(-1)!.body.code).toBe(3);
  await f.send('分解 修士道袍 2');
  expect(f.player()!.pendingDismantle).toMatchObject({ itemId: '6001', count: 2, moneyGain: 1200 });
  expect(f.player()!.inventory).toEqual(initial.inventory);
  expect(f.player()!.money).toBe(initial.money);
  await f.send('取消分解');
  expect(f.player()).toEqual(initial);
  expect(f.persistedPlayer()).toEqual(initial);
  expect(f.agent.send).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['other-player', 'other-group', 'wrong-scope', 'replaced-preview', 'changed-equipment', 'changed-stock', 'expired-preview'] as const).map(invalid => ({ scope, invalid })),
))('invalid $scope $invalid dismantle confirmations never settle any player', async ({ scope, invalid }) => {
  const f = await fixture(scope);
  await f.send('我要修仙');
  const groupId = peerKey('app', scope, f.route.peer.openid);
  f.game.handleCommand({ groupId, userId: 'other', nickname: '同名', text: '我要修仙' });
  f.change(player => { player.inventory = { '7001': 3, '6001': 2 }; player.equipment.weapon = null; player.equipment.armor = null; });
  const foreignGroupId = peerKey('app', 'group', 'foreign');
  f.game.handleCommand({ groupId: foreignGroupId, userId: 'player', nickname: '同名', text: '我要修仙' });
  await f.send('装备分解 7001 2');
  const pending = structuredClone(f.player()!.pendingDismantle)!;
  const raw = f.choice(`确认分解 ${pending.id}`);
  let patch: Partial<InteractionEvent> = {};
  if (invalid === 'other-player') patch = scope === 'group' ? { group_member_openid: 'other' } : { user_openid: 'other' };
  if (invalid === 'other-group') patch = { scene: 'group', chat_type: 1, group_openid: 'foreign', group_member_openid: 'player', user_openid: undefined };
  if (invalid === 'wrong-scope') patch = scope === 'group'
    ? { scene: 'c2c', chat_type: 2, group_openid: undefined, group_member_openid: undefined, user_openid: 'player' }
    : { scene: 'group', chat_type: 1, group_openid: 'player', group_member_openid: 'player', user_openid: undefined };
  if (invalid === 'replaced-preview') {
    await f.send('装备分解 6001 1');
    expect(f.player()!.pendingDismantle!.id).not.toBe(pending.id);
  }
  if (invalid === 'changed-equipment') f.change(player => { player.equipment.weapon = '7001'; });
  if (invalid === 'changed-stock') f.change(player => { player.inventory['7001'] = 1; });
  if (invalid === 'expired-preview') f.change(player => { player.pendingDismantle!.expiresAt = Date.parse('2026-11-14T00:59:59Z'); });
  const before = structuredClone(f.game.getPlayers(groupId));
  const foreignBefore = structuredClone(f.game.getPlayers(foreignGroupId));
  await f.click(raw, patch);
  expect(f.game.getPlayers(groupId)).toEqual(before);
  expect(f.game.getPlayers(foreignGroupId)).toEqual(foreignBefore);
  expect(f.persistedPlayer()).toEqual(before.find(player => player.userId === 'player'));
  if (invalid === 'other-player' || invalid === 'other-group' || invalid === 'wrong-scope' || invalid === 'replaced-preview') expect(f.requests.at(-1)!.body.code).toBe(3);
  if (invalid === 'replaced-preview' || invalid === 'changed-equipment' || invalid === 'changed-stock' || invalid === 'expired-preview') {
    await f.send(`确认分解 ${pending.id}`);
    expect(f.game.getPlayers(groupId)).toEqual(before);
    expect(f.persistedPlayer()).toEqual(before.find(player => player.userId === 'player'));
  }
  expect(f.agent.send).not.toHaveBeenCalled();
});

it.each(['group', 'c2c'] as const)('rejected %s dismantle keyboards preserve equipment and text confirmation remains usable', async scope => {
  const f = await fixture(scope, 350);
  await f.send('我要修仙');
  f.change(player => { player.inventory = { '7001': 2, '6001': 1 }; player.equipment.weapon = null; player.equipment.armor = null; });
  const initial = structuredClone(f.player())!;
  const path = scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages';
  for (const command of ['我的背包', '装备分解', '装备分解 7001 2']) {
    const start = f.messages().length;
    f.failNextMessage(new ApiError('QQ keyboard rejected', 403, path, 304037), true);
    await f.send(command);
    const attempts = f.messages().slice(start);
    const rejected = attempts.findIndex(request => request.body.keyboard);
    expect(rejected).toBeGreaterThanOrEqual(0);
    const fallback = attempts.slice(rejected + 1).find(request => !request.body.keyboard);
    expect(fallback).toBeDefined();
    expect(fallback!.path).toBe(path);
    expect(f.player()!.inventory).toEqual(initial.inventory);
    expect(f.player()!.money).toBe(initial.money);
  }
  const pending = f.player()!.pendingDismantle!;
  expect(pending).toMatchObject({ itemId: '7001', count: 2, moneyGain: 1600 });
  const rejectedIndex = f.messages().findLastIndex(request => request.body.keyboard);
  const fallback = f.messages().slice(rejectedIndex + 1).map(request => request.body.markdown!.content).join('\n');
  const confirmation = `确认分解 ${pending.id}`;
  expect(fallback).toContain(confirmation);
  expect(fallback).toContain(`取消分解 ${pending.id}`);
  const rejected = f.messages().findLast(request => request.body.keyboard)!;
  const raw = rejected.body.keyboard!.content.rows.flatMap(row => row.buttons)
    .find(button => button.action.unsupport_tips === `请发送：确认分解 ${pending.id}`)!.action.data;
  const preview = structuredClone(f.player());
  await f.click(raw);
  expect(f.player()).toEqual(preview);
  await f.send(confirmation);
  const settled = structuredClone(f.player())!;
  expect(settled.inventory).toEqual({ '6001': 1 });
  expect(settled.money).toBe(initial.money + 1600);
  expect(settled.equipment).toEqual(initial.equipment);
  expect(settled.pendingDismantle).toBeNull();
  expect(f.persistedPlayer()).toEqual(settled);
  await f.send('确认分解');
  expect(f.player()).toEqual(settled);
  expect(f.agent.send).not.toHaveBeenCalled();
});

it.each(['group', 'c2c'] as const)('existing %s v5 sessions get real dismantle context but continuation cannot confirm for the player', async scope => {
  const f = await fixture(scope);
  const legacyProtocol = '[qqbot-host-game-v5，插件可信规则]\n修仙游戏只由插件宿主固定引擎执行。玩家身份只认当前QQ输入。';
  f.route.peer.protocolPrompt = legacyProtocol;
  const originalAgent = f.route.agent;
  await f.send('我要修仙');
  const groupId = peerKey('app', scope, f.route.peer.openid);
  f.game.handleCommand({ groupId, userId: 'other', nickname: '同名', text: '我要修仙' });
  f.change(player => { player.inventory = { '7001': 2, '6001': 1 }; player.equipment.weapon = null; player.equipment.armor = null; });
  const initial = structuredClone(f.player())!;
  const otherBefore = structuredClone(f.player('other'));
  const handle = vi.spyOn(f.game, 'handleMessage');
  f.chatResponses.push(JSON.stringify({ type: 'game_action', command: '装备分解 7001 2', continue: true }),
    JSON.stringify({ type: 'game_action', command: '确认分解' }));
  await f.send('我想分解两件精铁符剑，请先让我看看能返还多少灵石');
  expect(handle.mock.calls.map(call => call[0].text)).toEqual(['装备分解 7001 2']);
  const pending = f.player()!.pendingDismantle!;
  expect(pending).toMatchObject({ itemId: '7001', count: 2, moneyGain: 1600 });
  const context = JSON.parse(f.agent.send.mock.calls.at(-1)![0].split('[当前玩家游戏上下文]\n')[1]!.split('\n\n')[0]!);
  expect(context.binding).toEqual({ groupId, userId: 'player' });
  expect(context.player.inventory).toEqual(initial.inventory);
  expect(context.player.equipment).toEqual(initial.equipment);
  expect(context.player.pendingDismantle).toEqual(pending);
  expect(context.dismantleCommands).toContain(`确认分解 ${pending.id}`);
  expect(context.dismantleCommands).toContain(`取消分解 ${pending.id}`);
  expect(f.player()!.inventory).toEqual(initial.inventory);
  expect(f.player()!.money).toBe(initial.money);
  expect(f.player('other')).toEqual(otherBefore);
  f.chatResponses.push(JSON.stringify({ type: 'game_answer', answer: `确认分解 ${pending.id}` }));
  await f.send('灵石余额足够吗？我只想了解，不要动我的背包');
  expect(handle).toHaveBeenCalledOnce();
  expect(f.player()!.pendingDismantle).toEqual(pending);
  expect(f.player()!.inventory).toEqual(initial.inventory);
  expect(f.player()!.money).toBe(initial.money);
  await f.send('确认分解');
  expect(f.player()!.inventory).toEqual({ '6001': 1 });
  expect(f.player()!.money).toBe(initial.money + 1600);
  expect(f.player()!.pendingDismantle).toBeNull();
  expect(f.persistedPlayer()).toEqual(f.player());
  f.chatResponses.push('这次分解已返还灵石。');
  const settled = structuredClone(f.player());
  await f.send('刚才分解实际返还了多少？');
  const settledContext = JSON.parse(f.agent.send.mock.calls.at(-1)![0].split('[当前玩家游戏上下文]\n')[1]!.split('\n\n')[0]!);
  expect(settledContext.recentFacts.at(-1)).toMatchObject({ type: 'dismantle', itemId: '7001', count: 2, moneyGain: 1600 });
  expect(f.player()).toEqual(settled);
  expect(f.player('other')).toEqual(otherBefore);
  expect(f.route.agent).toBe(originalAgent);
  expect(f.route.peer.protocolPrompt).toBe(legacyProtocol);
  expect(f.create).not.toHaveBeenCalled();
});

it.each(['group', 'c2c'] as const)('real %s pet menus adopt once, deploy and grow only the current player', async scope => {
  const f = await fixture(scope);
  await f.send('灵宠商店');
  expect(f.player()).toBeNull();
  expect(f.messages().at(-1)!.body.keyboard).toBeDefined();
  expect(f.messages().at(-1)!.body.markdown!.content).toContain('青灵狐');
  await f.send('我要修仙');
  const initial = structuredClone(f.player())!;
  expect(initial.pets).toEqual({ activeId: null, owned: {} });
  await f.send('灵宠');
  expect(f.player()).toEqual(initial);
  await f.click(f.choice('灵宠商店'));
  expect(f.player()).toEqual(initial);
  const shop = f.messages().at(-1)!;
  expect(shop.path).toBe(scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages');
  const groupId = peerKey('app', scope, f.route.peer.openid);
  for (const { id, name, cost } of f.game.getGuidance!(groupId, 'player')!.pets.catalog) {
    expect(shop.body.markdown!.content).toContain(name);
    expect(displayedIntegers(shop.body.markdown!.content)).toContain(cost);
    const offered = shop.body.keyboard!.content.rows.flatMap(row => row.buttons)
      .find(button => button.action.unsupport_tips === `请发送：领养灵宠 ${id}`)!;
    expect(offered.action.permission).toEqual({ type: 0, specify_user_ids: ['player'] });
  }
  const adopt = f.choice('领养灵宠 qingling');
  await f.click(adopt);
  expect(f.player()!.money).toBe(initial.money - 5000);
  expect(f.player()!.pets).toEqual({ activeId: null, owned: { qingling: { exp: 0 } } });
  expect(displayedIntegers(f.messages().at(-1)!.body.markdown!.content)).toContain(f.player()!.money);
  expect(f.messages().at(-1)!.body.event_id).toMatch(/^INTERACTION_CREATE:click-/);
  const adopted = structuredClone(f.player());
  await f.click(adopt);
  expect(f.player()).toEqual(adopted);
  expect(f.requests.at(-1)!.body.code).toBe(3);

  await f.send('我的灵宠');
  await f.click(f.choice('灵宠出战 qingling'));
  expect(f.player()!.money).toBe(initial.money - 5000);
  expect(f.player()!.pets.activeId).toBe('qingling');
  expect(f.game.getGuidance!(groupId, 'player')!.pets.active).toMatchObject({ id: 'qingling', name: '青灵狐', level: 1, attackRate: 0.05, attackMin: 1 });
  await f.send('灵宠信息 青灵狐');
  const feed = f.choice('喂养灵宠 qingling 1');
  await f.click(feed);
  expect(f.player()!.money).toBe(initial.money - 5500);
  expect(f.player()!.pets).toEqual({ activeId: 'qingling', owned: { qingling: { exp: 100 } } });
  expect(f.game.getGuidance!(groupId, 'player')!.pets.active).toMatchObject({ level: 2, attackRate: 0.1, attackMin: 2 });
  const feedingAmounts = displayedIntegers(f.messages().at(-1)!.body.markdown!.content);
  expect(feedingAmounts).toContain(f.player()!.money);
  expect(feedingAmounts).toContain(f.player()!.pets.owned.qingling!.exp);
  expect(feedingAmounts).toContain(f.game.getGuidance!(groupId, 'player')!.pets.active!.level);
  const grown = structuredClone(f.player());
  await f.click(feed);
  expect(f.player()).toEqual(grown);
  await f.send('灵宠休息');
  expect(f.player()!.money).toBe(initial.money - 5500);
  expect(f.player()!.pets).toEqual({ activeId: null, owned: { qingling: { exp: 100 } } });
  expect(f.game.getGuidance!(groupId, 'player')!.pets.active).toBeNull();
});

it.each((['adopt', 'deploy', 'feed'] as const).flatMap(action =>
  (['other-player', 'other-group', 'expired', 'replaced-menu', 'changed-pets'] as const).map(invalid => ({ action, invalid })),
))('invalid $invalid pet $action buttons preserve every real player', async ({ action, invalid }) => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'other');
  await f.send('领养灵宠 玄甲龟', 'other');
  const groupId = peerKey('app', 'group', 'group');
  const foreignGroupId = peerKey('app', 'group', 'foreign');
  f.game.handleCommand({ groupId: foreignGroupId, userId: 'player', nickname: '同名', text: '我要修仙' });
  f.game.handleCommand({ groupId: foreignGroupId, userId: 'player', text: '领养灵宠 云翎鹤' });
  if (action !== 'adopt') await f.send('领养灵宠 青灵狐');
  const menuCommand = action === 'adopt' ? '灵宠商店' : '灵宠信息 青灵狐';
  await f.send(menuCommand);
  const command = action === 'adopt' ? '领养灵宠 qingling' : action === 'deploy' ? '灵宠出战 qingling' : '喂养灵宠 qingling 1';
  const raw = f.choice(command);
  let patch: Partial<InteractionEvent> = {};
  if (invalid === 'other-player') patch = { group_member_openid: 'other' };
  if (invalid === 'other-group') patch = { group_openid: 'foreign' };
  if (invalid === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  if (invalid === 'replaced-menu') await f.send(menuCommand);
  if (invalid === 'changed-pets') {
    const money = f.player()!.money;
    f.game.handleCommand({ groupId, userId: 'player', text: '领养灵宠 云翎鹤' });
    expect(f.player()!.money).toBe(money - 6000);
    expect(f.player()!.pets.owned.yunling).toEqual({ exp: 0 });
  }
  const before = structuredClone(f.game.getPlayers(groupId));
  const foreignBefore = structuredClone(f.game.getPlayers(foreignGroupId));
  await f.click(raw, patch);
  expect(f.game.getPlayers(groupId)).toEqual(before);
  expect(f.game.getPlayers(foreignGroupId)).toEqual(foreignBefore);
  expect(f.requests.at(-1)!.body.code).toBe(invalid === 'changed-pets' ? 0 : 3);
});

it.each(['group', 'c2c'] as const)('rejected %s pet keyboards leave assets untouched and text commands perform the same actions', async scope => {
  const f = await fixture(scope);
  await f.send('我要修仙');
  const initial = structuredClone(f.player())!;
  const path = scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages';
  f.failNextMessage(new ApiError('QQ keyboard rejected', 403, path, 304037), true);
  const start = f.messages().length;
  await f.send('灵宠商店');
  const attempts = f.messages().slice(start);
  const rejected = attempts.find(request => request.body.keyboard)!;
  const fallback = attempts.at(-1)!.body;
  expect(fallback.keyboard).toBeUndefined();
  expect(fallback.markdown!.content).toContain('领养灵宠 qingling');
  expect(f.player()).toEqual(initial);
  const raw = rejected.body.keyboard!.content.rows.flatMap(row => row.buttons)
    .find(button => button.action.unsupport_tips === '请发送：领养灵宠 qingling')!.action.data;
  await f.click(raw);
  expect(f.player()).toEqual(initial);
  await f.send('领养灵宠 qingling');
  expect(f.player()!.money).toBe(initial.money - 5000);
  expect(f.player()!.pets).toEqual({ activeId: null, owned: { qingling: { exp: 0 } } });

  f.failNextMessage(new ApiError('QQ keyboard rejected', 403, path, 304037), true);
  await f.send('灵宠信息 qingling');
  const petFallback = f.messages().at(-1)!.body;
  expect(petFallback.keyboard).toBeUndefined();
  expect(petFallback.markdown!.content).toContain('灵宠出战 qingling');
  expect(petFallback.markdown!.content).toContain('喂养灵宠 qingling 1');
  await f.send('灵宠出战 青灵狐');
  await f.send('喂养灵宠 青灵狐 3');
  expect(f.player()!.money).toBe(initial.money - 6500);
  expect(f.player()!.pets).toEqual({ activeId: 'qingling', owned: { qingling: { exp: 300 } } });
  const groupId = peerKey('app', scope, f.route.peer.openid);
  expect(f.game.getGuidance!(groupId, 'player')!.pets.active).toMatchObject({ id: 'qingling', level: 3, attackMin: 3 });
});

it('an existing v5 session consumes real dynamic pet context and free language acts only for the original QQ identity', async () => {
  const f = await fixture();
  const legacyProtocol = '[qqbot-host-game-v5，插件可信规则]\n修仙游戏只由插件宿主固定引擎执行。玩家身份只认当前QQ输入。';
  f.route.peer.protocolPrompt = legacyProtocol;
  const originalAgent = f.route.agent;
  await f.send('我要修仙');
  await f.send('我要修仙', 'other');
  await f.send('领养灵宠 玄甲龟', 'other');
  await f.send('灵宠出战 玄甲龟', 'other');
  const otherBefore = structuredClone(f.player('other'));
  const initial = structuredClone(f.player())!;
  const latestContext = () => {
    const input = f.agent.send.mock.calls.at(-1)![0];
    const json = input.split('[当前玩家游戏上下文]\n')[1]!.split('\n\n')[0]!;
    return JSON.parse(json);
  };
  f.chatResponses.push(JSON.stringify({ type: 'game_action', command: '领养灵宠 qingling' }));
  await f.send('我想带一只青灵狐回家，请现在为我领养');
  const adoptionContext = latestContext();
  expect(adoptionContext.binding).toEqual({ groupId: peerKey('app', 'group', 'group'), userId: 'player' });
  expect(adoptionContext.player.pets).toEqual({ activeId: null, owned: {} });
  expect(adoptionContext.guidance.pets).toMatchObject({ active: null, feedCost: 500, feedExp: 100, maxLevel: 10 });
  expect(f.player()!.money).toBe(initial.money - 5000);
  expect(f.player()!.pets).toEqual({ activeId: null, owned: { qingling: { exp: 0 } } });

  f.chatResponses.push(JSON.stringify({ type: 'game_action', command: '灵宠出战 qingling' }));
  await f.send('我想让青灵狐现在与我并肩作战');
  expect(latestContext().player.pets).toEqual({ activeId: null, owned: { qingling: { exp: 0 } } });
  expect(f.player()!.pets.activeId).toBe('qingling');
  f.chatResponses.push(JSON.stringify({ type: 'game_action', command: '喂养灵宠 qingling 3' }));
  await f.send('给我的青灵狐喂三份口粮');
  expect(latestContext().guidance.pets.active).toMatchObject({ id: 'qingling', level: 1 });
  expect(f.player()!.money).toBe(initial.money - 6500);
  expect(f.player()!.pets).toEqual({ activeId: 'qingling', owned: { qingling: { exp: 300 } } });
  const grown = structuredClone(f.player());
  f.chatResponses.push('愿道友仙途顺遂。');
  await f.send('现在我的伙伴成长到哪一步？');
  expect(latestContext().guidance.pets.active).toMatchObject({ id: 'qingling', name: '青灵狐', level: 3, attackMin: 3 });
  expect(f.player()).toEqual(grown);
  expect(f.player('other')).toEqual(otherBefore);
  f.chatResponses.push('愿道友仙途顺遂。');
  await f.send('现在我的伙伴成长到哪一步？', 'other');
  expect(latestContext().binding.userId).toBe('other');
  expect(latestContext().player.pets).toEqual(otherBefore!.pets);
  expect(latestContext().guidance.pets.active).toMatchObject({ id: 'xuanjia', name: '玄甲龟', level: 1, defenseRate: 0.02 });
  expect(f.player()).toEqual(grown);
  expect(f.player('other')).toEqual(otherBefore);
  expect(f.route.agent).toBe(originalAgent);
  expect(f.route.peer.protocolPrompt).toBe(legacyProtocol);
});

it.each(['group', 'c2c'] as const)('real %s rift buttons judge the same adventure, advance three scenes and settle without image permission', async scope => {
  const f = await fixture(scope);
  await f.rift();
  f.game.handleCommand({ groupId: peerKey('app', scope, f.route.peer.openid), userId: 'other', text: '我要修仙' });
  const otherBefore = structuredClone(f.player('other'));
  const first = structuredClone(f.player())!;
  const adventure = first.riftAdventure!;
  expectCommands(f.messages().at(-1)!.body.keyboard!, [
    ...adventure.scene.choices!.map((_, index) => `秘境行动 ${adventure.id} ${adventure.round} ${index + 1}`),
    '秘境帮助', '秘境探索终止',
  ]);
  await f.click(f.choice('秘境帮助'));
  expect(f.player()).toEqual(first);
  await f.send('深入探索');
  const command = `秘境行动 ${adventure.id} 0 1`;
  const oldButton = f.choice(command);
  const handle = vi.spyOn(f.game, 'handleMessage');
  const resolve = vi.spyOn(f.game.host, 'resolveReview');
  await f.click(oldButton, scope === 'group' ? { group_member_openid: 'other' } : { user_openid: 'other' });
  expect(f.player()).toEqual(first); expect(f.player('other')).toEqual(otherBefore);
  expect(handle).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(riftDecision));
  await f.click(oldButton);
  expect(handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    groupId: peerKey('app', scope, f.route.peer.openid), userId: 'player', text: command,
  }));
  expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    groupId: peerKey('app', scope, f.route.peer.openid), userId: 'player', kind: 'rift', requestId: adventure.id, revision: 1, review: riftDecision,
  }));
  expect(f.player()!.riftAdventure).toMatchObject({ id: adventure.id, status: 'awaiting', round: 1, score: 2 });
  expect(f.player()!.riftAdventure!.history[0]).toMatchObject({ sceneId: adventure.scene.id, action: adventure.scene.choices![0] });
  expect(f.player()!.riftAdventure!.scene.id).not.toBe(adventure.scene.id);
  expect(f.messages().at(-1)!.body.event_id).toMatch(/^INTERACTION_CREATE:click-/);
  const advanced = structuredClone(f.player());
  await f.click(oldButton);
  expect(f.player()).toEqual(advanced); expect(resolve).toHaveBeenCalledOnce();
  for (let round = 1; round < 3; round++) {
    f.reviewResponses.push(JSON.stringify(riftDecision));
    if (round === 1) await f.send('1');
    else await f.click(f.choice(`秘境行动 ${adventure.id} ${round} 1`));
  }
  expect(f.player()!.riftAdventure).toMatchObject({ id: adventure.id, status: 'settled', score: 6 });
  expect(f.player()!.riftAdventure!.history).toHaveLength(3);
  expect(f.player()!.activity).toBeNull();
  expect(f.player()!.inventory).not.toEqual(first.inventory);
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(f.player('other')).toEqual(otherBefore);
  expect(f.agent.send).not.toHaveBeenCalled();
  expect(f.imageChildren).toHaveLength(0);
  expect(f.requests.some(request => /\/files$/.test(request.path) || request.body.msg_type === 7)).toBe(false);
});

function sceneView(player: Player, kind: SceneKind) {
  const adventure = kind === 'rift' ? player.riftAdventure : player.adventure;
  if (!adventure?.scene) throw new Error('Expected a real current scene');
  const actions = adventure.scene.choices ?? [];
  const commands = kind === 'rift'
    ? [...actions.map((_, index) => `秘境行动 ${adventure.id} ${player.riftAdventure!.round} ${index + 1}`), '秘境帮助', '秘境探索终止']
    : [...actions.map((_, index) => `历练 ${index + 1}`), '历练', '取消历练'];
  return { sceneId: adventure.scene.id, title: adventure.scene.title, description: adventure.scene.description, actions, commands };
}

const imageMarkdown = /!\[[^\]]*\]\(qqbot-media:\/\/image\/v1\/[^)\s]+\)/u;
const sceneMessages = (messages: NativeRequest[], description: string) => messages.filter(request => request.body.markdown?.content.includes(description));
const mixedMessages = (messages: NativeRequest[]) => messages.filter(request => request.body.markdown?.content.includes('qqbot-media://image/v1/'));

function expectSceneMessage(request: NativeRequest, source: GameResult, player: Player, kind: SceneKind, scope: 'group' | 'c2c',
  withImage: boolean, senderId = 'player', showActions = true) {
  const view = sceneView(player, kind);
  const mention = replyMention({ scope, targetId: scope === 'group' ? 'group' : 'player', mentionUserId: senderId });
  expect(request.path).toBe(scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages');
  expect(request.body.msg_type).toBe(2);
  const content = request.body.markdown!.content;
  expect(content.startsWith(mention)).toBe(true);
  expect(content).toContain(view.title);
  expect(content).toContain(view.description);
  expect(content.indexOf(view.title)).toBeLessThan(content.indexOf(view.description));
  expect(content.indexOf(view.description)).toBe(content.lastIndexOf(view.description));
  expect(source.sceneImage).toMatchObject({ sceneId: view.sceneId, title: view.title, description: view.description });
  const descriptionOffset = source.message.indexOf(view.description);
  const pictureInMessage = imageMarkdown.exec(content);
  const original = withImage
    ? `${source.message.slice(0, descriptionOffset).trimEnd()}\n\n${pictureInMessage?.[0]}\n\n${source.message.slice(descriptionOffset)}`
    : source.message;
  expect(content).toBe(mention + original);
  const picture = imageMarkdown.exec(content);
  if (withImage) {
    expect(picture).not.toBeNull();
    expect(picture![0]).toContain(`#${source.sceneImage!.image.width}px #${source.sceneImage!.image.height}px`);
    expect(content.indexOf(view.title)).toBeLessThan(picture!.index);
    expect(picture!.index).toBeLessThan(content.indexOf(view.description));
    expect(request.body.markdown!.force_verify_image_resource).toBe(true);
  } else {
    expect(picture).toBeNull();
  }
  if (showActions) {
    expectCommands(request.body.keyboard!, view.commands, senderId);
  } else expect(request.body.keyboard).toBeUndefined();
}

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).map(kind => ({ scope, kind })),
))('real $scope $kind waits for native PNG and delivers the complete scene as one mixed Markdown message', async ({ scope, kind }) => {
  const f = await fixture(scope, scope === 'group' ? 200 : 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  try {
    await f.send('我要修仙');
    await f.send(kind === 'rift' ? '秘境探索' : '历练'); await f.images!.entered.promise;
    const before = structuredClone(f.player())!;
    const view = sceneView(before, kind);
    expect(sceneMessages(f.messages(), view.description)).toHaveLength(0);
    expect(mixedMessages(f.messages())).toHaveLength(0);
    expect(f.messages().flatMap(request => request.body.keyboard?.content.rows.flatMap(row => row.buttons) ?? [])
      .filter(button => view.commands.slice(0, view.actions.length).some(command => button.action.unsupport_tips === `请发送：${command}`))).toEqual([]);
    release.resolve(); await f.imageDelivered.promise; await f.drainImages();
    const displayed = sceneMessages(f.messages(), view.description);
    expect(displayed).toHaveLength(1);
    expectSceneMessage(displayed[0]!, f.sceneResult(before, kind), before, kind, scope, true);
    expect(f.messages().some(request => request.body.msg_type === 7)).toBe(false);
    const prepare = f.requests.find(request => request.path === '/v2/media-images/prepare')!;
    const complete = f.requests.find(request => request.path === '/v2/media-images/complete')!;
    expect(f.requests.indexOf(prepare)).toBeLessThan(f.requests.indexOf(complete));
    expect(f.requests.indexOf(complete)).toBeLessThan(f.requests.indexOf(displayed[0]!));
    expect(f.images!.uploads).toHaveLength(1);
    const cached = Object.values((await f.store.read()).values.sceneImages);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatch(/^\.qqbot-media\/generated\/[\da-f-]{36}\.png$/);
    expect(await f.images!.files.read(cached[0]!)).toEqual(f.images!.uploads[0]!.bytes);
    expect(f.player()).toEqual(before);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['exit', 'action', 'access', 'image-grant', 'stop', 'retired', 'generation'] as const).flatMap(change =>
    (['success', 'failure'] as const).map(outcome => ({ scope, change, outcome }))),
))('late native $scope rift $outcome sends no stale scene after $change', async ({ scope, change, outcome }) => {
  const f = await fixture(scope, 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  if (outcome === 'failure') f.images!.fail();
  try {
    await f.rift(); await f.images!.entered.promise;
    const previous = structuredClone(f.player())!;
    const oldView = sceneView(previous, 'rift');
    await f.invalidateScene('rift', change);
    const afterChange = f.persistedPlayer();
    release.resolve(); await f.drainImages();
    expect(sceneMessages(f.messages(), oldView.description)).toHaveLength(0);
    if (change === 'action') {
      const current = f.player()!;
      expect(current.riftAdventure).toMatchObject({ id: previous.riftAdventure!.id, round: 1, score: 2, status: 'awaiting' });
      const displayed = sceneMessages(f.messages(), current.riftAdventure!.scene.description);
      expect(displayed).toHaveLength(1);
      expectSceneMessage(displayed[0]!, f.sceneResult(current, 'rift'), current, 'rift', scope, outcome === 'success');
    } else {
      expect(mixedMessages(f.messages())).toHaveLength(0);
      expect(f.requests.some(request => request.path === '/v2/media-images/prepare')).toBe(false);
    }
    expect(f.persistedPlayer()).toEqual(afterChange);
    expect(f.messages().some(request => request.body.msg_type === 7)).toBe(false);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each(['adventure-id', 'round', 'scene-id', 'title', 'description'] as const)('full rift scene identity rejects late mixed output after changed %s', async changed => {
  const f = await fixture('group', 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  try {
    await f.rift(); await f.images!.entered.promise;
    const oldView = sceneView(f.player()!, 'rift');
    f.change(player => {
      const adventure = player.riftAdventure!;
      if (changed === 'adventure-id') adventure.id = 'different-adventure';
      if (changed === 'round') adventure.round++;
      if (changed === 'scene-id') adventure.scene.id = 'different-scene';
      if (changed === 'title') adventure.scene.title = '变化后的石门';
      if (changed === 'description') adventure.scene.description = '石门后的雾气已经散去，路旁阵纹不再发光。';
    });
    const before = structuredClone(f.player());
    release.resolve(); await f.drainImages();
    expect(sceneMessages(f.messages(), oldView.description)).toHaveLength(0);
    expect(f.requests.some(request => request.path === '/v2/media-images/prepare')).toBe(false);
    expect(f.player()).toEqual(before);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).flatMap(kind =>
    (['provider', 'prepare', 'put', 'complete'] as const).map(failure => ({ scope, kind, failure }))),
))('$scope $kind $failure failure delivers only the original full text with usable actions', async ({ scope, kind, failure }) => {
  const f = await fixture(scope, 4500, 20, true);
  if (failure === 'provider') f.images!.fail(); else f.failMaterial(failure);
  await f.send('我要修仙');
  await f.send(kind === 'rift' ? '秘境探索' : '历练'); await f.imageFailed.promise; await f.drainImages();
  const before = structuredClone(f.player())!;
  const view = sceneView(before, kind);
  const displayed = sceneMessages(f.messages(), view.description);
  expect(displayed).toHaveLength(1);
  expectSceneMessage(displayed[0]!, f.sceneResult(before, kind), before, kind, scope, false);
  expect(mixedMessages(f.messages())).toHaveLength(0);
  expect(f.messages().some(request => request.body.msg_type === 7)).toBe(false);
  expect(kind === 'rift' ? before.riftAdventure!.status : before.adventure!.status).toBe('awaiting');
  f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(kind === 'rift' ? riftDecision : successfulAction));
  const selectedCommand = kind === 'rift'
    ? `秘境行动 ${before.riftAdventure!.id} 0 1`
    : `历练 ${before.adventure!.scene!.choices!.indexOf(scene.choices[0]) + 1}`;
  const selected = f.sceneResult(before, kind).choices!.find(choice => choice.command === selectedCommand);
  expect(selected).toBeDefined();
  await f.click(f.choice(selected!.command));
  await f.drainImages();
  const after = f.player()!;
  if (kind === 'rift') {
    expect(after.riftAdventure).toMatchObject({ id: before.riftAdventure!.id, round: 1, score: 2, status: 'awaiting' });
    expect(after.riftAdventure!.history).toHaveLength(1);
    expect(after.riftAdventure!.history[0]!.action).toBe(selected!.label);
  } else {
    expect(after.adventure!.status).toBe('settled');
    expect(after.storyThread!.beats.at(-1)!.action).toBe(selected!.label);
    const reward = before.adventure!.options.find(option => option.id === (successfulAction.risk === 'safe' ? '1' : '2'))!;
    expect(after.exp - before.exp).toBe(reward.expGain);
    expect(after.money - before.money).toBe(reward.moneyGain);
  }
  expect(f.agent.send).not.toHaveBeenCalled();
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['prepare', 'put', 'complete'] as const).flatMap(stage =>
    (['success', 'failure'] as const).map(outcome => ({ scope, stage, outcome }))),
))('$scope rift advancement rejects stale $stage $outcome at the material consumer boundary', async ({ scope, stage, outcome }) => {
  const f = await fixture(scope, 4500, 20, true);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let held = false;
  f.holdMaterial(stage, async () => { if (!held) { held = true; entered.resolve(); await release.promise; } });
  if (outcome === 'failure') f.failMaterial(stage);
  try {
    await f.rift(); await entered.promise;
    const previous = structuredClone(f.player())!;
    await f.invalidateScene('rift', 'action');
    const afterChange = f.persistedPlayer();
    release.resolve(); await f.drainImages();
    expect(sceneMessages(f.messages(), previous.riftAdventure!.scene.description)).toHaveLength(0);
    const current = f.player()!;
    const displayed = sceneMessages(f.messages(), current.riftAdventure!.scene.description);
    expect(displayed).toHaveLength(1);
    expectSceneMessage(displayed[0]!, f.sceneResult(current, 'rift'), current, 'rift', scope, outcome === 'success');
    expect(f.persistedPlayer()).toEqual(afterChange);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).flatMap(kind =>
    (['action', 'exit', 'access', 'image-grant', 'stop', 'retired', 'generation'] as const).flatMap(change =>
      (['mixed', 'fallback'] as const).map(output => ({ scope, kind, change, output })))),
))('$scope $kind rejects stale $output after $change at the final real QQ HTTP boundary', async ({ scope, kind, change, output }) => {
  const f = await fixture(scope, 4500, 20, true);
  if (output === 'fallback') f.images!.fail();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let held = false;
  f.beforeSceneSend(async () => { if (!held) { held = true; entered.resolve(); await release.promise; } });
  try {
    await f[kind](); await entered.promise;
    const previous = structuredClone(f.player())!;
    const view = sceneView(previous, kind);
    expect(sceneMessages(f.messages(), view.description)).toHaveLength(0);
    await f.invalidateScene(kind, change);
    const afterChange = f.persistedPlayer();
    release.resolve(); await f.drainImages();
    expect(sceneMessages(f.messages(), view.description)).toHaveLength(0);
    if (change === 'action' && kind === 'rift') {
      const current = f.player()!;
      const displayed = sceneMessages(f.messages(), current.riftAdventure!.scene.description);
      expect(displayed).toHaveLength(1);
      expectSceneMessage(displayed[0]!, f.sceneResult(current, kind), current, kind, scope, output === 'mixed');
    } else expect(mixedMessages(f.messages())).toHaveLength(0);
    expect(f.persistedPlayer()).toEqual(afterChange);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).map(kind => ({ scope, kind })),
))('$scope $kind queries and parent turns keep one in-flight message, and explicit resume reuses PNG and material', async ({ scope, kind }) => {
  const f = await fixture(scope, 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  try {
    await f[kind](); await f.images!.entered.promise;
    const before = structuredClone(f.player())!;
    const source = f.sceneResult(before, kind);
    const view = sceneView(before, kind);
    if (scope === 'group') {
      await f.send('状态', 'other');
      f.chatResponses.push('你好。'); await f.send('你好', 'other');
    }
    await f.send('状态');
    await f.send(kind === 'rift' ? '深入探索' : '历练');
    await f.internal.event(f.route, { seq: 100, event: { type: 'turn_started', turnId: 'unrelated-turn' } } as OmpAgentStream);
    await f.internal.event(f.route, { seq: 101, event: { type: 'turn_canceled', turnId: 'unrelated-turn' } } as OmpAgentStream);
    expect(sceneMessages(f.messages(), view.description)).toHaveLength(0);
    release.resolve(); await f.imageDelivered.promise; await f.drainImages();
    expect(f.player()).toEqual(before);
    const first = sceneMessages(f.messages(), view.description);
    expect(first).toHaveLength(1); expectSceneMessage(first[0]!, source, before, kind, scope, true);
    const cached = structuredClone((await f.store.read()).values.sceneImages);
    await f.send(kind === 'rift' ? '深入探索' : '历练'); await f.drainImages();
    const displayed = sceneMessages(f.messages(), view.description);
    expect(displayed).toHaveLength(2); expectSceneMessage(displayed[1]!, f.sceneResult(before, kind), before, kind, scope, true);
    expect(imageMarkdown.exec(displayed[1]!.body.markdown!.content)?.[0]).toBe(imageMarkdown.exec(first[0]!.body.markdown!.content)?.[0]);
    expect(f.images!.providerRequests).toHaveLength(1);
    expect(f.images!.uploads).toHaveLength(1);
    expect(f.requests.filter(request => request.path === '/v2/media-images/prepare')).toHaveLength(1);
    expect(f.requests.filter(request => request.path === '/v2/media-images/complete')).toHaveLength(1);
    expect((await f.store.read()).values.sceneImages).toEqual(cached);
    for (const path of Object.values(cached)) expect(await f.images!.files.read(path)).toEqual(f.images!.png);
    expect(f.player()).toEqual(before);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).flatMap(kind =>
    (['mixed', 'fallback'] as const).map(output => ({ scope, kind, output }))),
))('in-flight $scope $kind $output preserves the judging scene without old executable choices or early settlement', async ({ scope, kind, output }) => {
  const f = await fixture(scope, 4500, 20, true);
  const imageRelease = Promise.withResolvers<void>(); f.images!.hold(imageRelease.promise);
  if (output === 'fallback') f.images!.fail();
  const reviewRelease = Promise.withResolvers<void>();
  let acting: Promise<void> | undefined;
  try {
    await f[kind](); await f.images!.entered.promise;
    const before = structuredClone(f.player())!;
    const view = sceneView(before, kind);
    const judgingEntered = f.holdReview(reviewRelease.promise);
    f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(kind === 'rift' ? riftDecision : successfulAction));
    acting = f.send(kind === 'rift' ? `秘境行动 ${before.riftAdventure!.id} 0 1` : '历练 1');
    await judgingEntered;
    const judging = structuredClone(f.player())!;
    expect(kind === 'rift' ? judging.riftAdventure!.status : judging.adventure!.status).toBe('judging');
    imageRelease.resolve(); await f.drainImages();
    const displayed = sceneMessages(f.messages(), view.description);
    expect(displayed).toHaveLength(1);
    expectSceneMessage(displayed[0]!, f.sceneResult(before, kind), before, kind, scope, output === 'mixed', 'player', false);
    expect(f.player()).toEqual(judging);
    expect(f.persistedPlayer()).toEqual(judging);
    expect(judging.exp).toBe(before.exp); expect(judging.money).toBe(before.money);
    if (kind === 'rift') expect(judging.riftAdventure!.history).toEqual(before.riftAdventure!.history);
    reviewRelease.resolve(); await acting; await f.drainImages();
    expect(kind === 'rift' ? f.player()!.riftAdventure!.round : f.player()!.adventure!.status).toBe(kind === 'rift' ? 1 : 'settled');
  } finally { imageRelease.resolve(); reviewRelease.resolve(); await acting; await f.drainImages(); }
}, 30000);

it.each(['both-live', 'first-exits'] as const)('two group players with the same PNG keep independent mixed delivery when %s', async mode => {
  const f = await fixture('group', 4500, 20, true);
  const uploading = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let held = false;
  f.holdMaterial('put', async () => { if (!held) { held = true; uploading.resolve(); await release.promise; } });
  try {
    await f.rift(); await uploading.promise;
    await f.send('我要修仙', 'other'); await f.send('秘境探索', 'other');
    await f.send('状态'); await f.send('状态', 'other');
    await f.nativeImagesReady();
    const before = [structuredClone(f.player()), structuredClone(f.player('other'))];
    const oldView = sceneView(before[0]!, 'rift');
    const assets = Object.values((await f.store.read()).values.sceneImages);
    if (mode === 'first-exits') await f.invalidateScene('rift', 'exit');
    const afterChange = [structuredClone(f.player()), structuredClone(f.player('other'))];
    release.resolve(); await f.drainImages();
    const pictures = mixedMessages(f.messages());
    expect(pictures).toHaveLength(mode === 'first-exits' ? 1 : 2);
    for (const senderId of mode === 'first-exits' ? ['other'] : ['player', 'other']) {
      const mention = replyMention({ scope: 'group', targetId: 'group', mentionUserId: senderId });
      const displayed = pictures.filter(request => request.body.markdown!.content.startsWith(mention));
      expect(displayed).toHaveLength(1);
      expectSceneMessage(displayed[0]!, f.sceneResult(f.player(senderId)!, 'rift', senderId), f.player(senderId)!, 'rift', 'group', true, senderId);
    }
    if (mode === 'first-exits') {
      const mention = replyMention({ scope: 'group', targetId: 'group', mentionUserId: 'player' });
      expect(sceneMessages(f.messages(), oldView.description).filter(request => request.body.markdown!.content.startsWith(mention))).toHaveLength(0);
      expect(f.player('other')).toEqual(before[1]);
    }
    for (const path of assets) expect(await f.images!.files.read(path)).toEqual(f.images!.png);
    expect([f.player(), f.player('other')]).toEqual(afterChange);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['action', 'exit'] as const).flatMap(action =>
    (['success', 'failure'] as const).map(outcome => ({ scope, action, outcome }))),
))('ordinary $scope adventure $action discards late native $outcome without changing settlement', async ({ scope, action, outcome }) => {
  const f = await fixture(scope, 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  if (outcome === 'failure') f.images!.fail();
  try {
    await f.adventure(); await f.images!.entered.promise;
    const previous = structuredClone(f.player())!;
    await f.invalidateScene('adventure', action);
    const settled = structuredClone(f.player());
    release.resolve(); await f.drainImages();
    expect(sceneMessages(f.messages(), sceneView(previous, 'adventure').description)).toHaveLength(0);
    expect(mixedMessages(f.messages())).toHaveLength(0);
    expect(f.requests.some(request => request.path === '/v2/media-images/prepare')).toBe(false);
    expect(f.player()).toEqual(settled);
    await f.send('历练结果'); await f.send('状态'); await f.drainImages();
    expect(mixedMessages(f.messages())).toHaveLength(0);
    expect(f.player()).toEqual(settled);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it('resumed ordinary adventure displays a mixed scene, while cultivation and judging never request another image', async () => {
  const f = await fixture('group', 4500, 20, true);
  await f.send('我要修仙');
  const groupId = peerKey('app', 'group', 'group');
  const started = f.game.handleCommand({ groupId, userId: 'player', text: '历练' });
  f.game.resolveReview({ groupId, userId: 'player', kind: 'adventure', requestId: started.reviewRequest!.requestId, revision: started.reviewRequest!.revision, review: scene });
  f.change(player => { player.adventure!.source = 'cultivation'; });
  await f.send('修炼事件'); await f.send('状态'); await f.drainImages();
  expect(f.images!.providerRequests).toHaveLength(0);
  expect(mixedMessages(f.messages())).toHaveLength(0);
  f.change(player => { player.adventure!.source = 'adventure'; });
  await f.send('历练'); await f.imageDelivered.promise; await f.drainImages();
  expect(mixedMessages(f.messages())).toHaveLength(1);
  expectSceneMessage(mixedMessages(f.messages())[0]!, f.sceneResult(f.player()!, 'adventure'), f.player()!, 'adventure', 'group', true);
  const release = Promise.withResolvers<void>(); const entered = f.holdReview(release.promise);
  f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(successfulAction));
  let acting: Promise<void> | undefined;
  try {
    acting = f.click(f.choice()); await entered;
    expect(f.player()!.adventure!.status).toBe('judging');
    expect(f.images!.providerRequests).toHaveLength(1);
    release.resolve(); await acting; await f.drainImages();
    expect(f.player()!.adventure!.status).toBe('settled');
    expect(f.images!.providerRequests).toHaveLength(1);
  } finally { release.resolve(); await acting; }
}, 30000);

it.each(['revision', 'id', 'scene-id', 'title', 'description', 'source', 'status'] as const)('ordinary adventure rejects changed %s at the final QQ HTTP boundary after material completion', async changed => {
  const f = await fixture('group', 4500, 20, true);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  f.beforeSceneSend(async () => { entered.resolve(); await release.promise; });
  try {
    await f.adventure(); await entered.promise;
    const oldView = sceneView(f.player()!, 'adventure');
    f.change(player => {
      const adventure = player.adventure!;
      if (changed === 'revision') adventure.revision++;
      if (changed === 'id') adventure.id = 'replacement-adventure';
      if (changed === 'scene-id') adventure.scene!.id = 'replacement-scene';
      if (changed === 'title') adventure.scene!.title = '变化后的石门';
      if (changed === 'description') adventure.scene!.description = '雾气已散去，阵纹不再发光。';
      if (changed === 'source') adventure.source = 'cultivation';
      if (changed === 'status') adventure.status = 'settled';
    });
    const before = structuredClone(f.player());
    release.resolve(); await f.drainImages();
    expect(f.images!.uploads).toHaveLength(1);
    expect(f.requests.some(request => request.path === '/v2/media-images/complete')).toBe(true);
    expect(sceneMessages(f.messages(), oldView.description)).toHaveLength(0);
    expect(mixedMessages(f.messages())).toHaveLength(0);
    expect(f.player()).toEqual(before);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it.each(['group', 'c2c'] as const)('unknown acceptance of the final %s mixed Markdown never sends a second text fallback', async scope => {
  const f = await fixture(scope, 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  try {
    await f.rift(); await f.images!.entered.promise;
    const before = structuredClone(f.player())!;
    f.failNextMessage(new ApiError('fixture connection lost after sending', 0, scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages'));
    release.resolve(); await f.drainImages();
    const attempted = sceneMessages(f.messages(), before.riftAdventure!.scene.description);
    expect(attempted).toHaveLength(1);
    expectSceneMessage(attempted[0]!, f.sceneResult(before, 'rift'), before, 'rift', scope, true);
    expect(f.player()).toEqual(before);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);


it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).map(kind => ({ scope, kind })),
))('image-disabled $scope $kind still delivers the original scene and real buttons immediately', async ({ scope, kind }) => {
  const f = await fixture(scope);
  await f[kind]();
  const player = f.player()!;
  const displayed = sceneMessages(f.messages(), sceneView(player, kind).description);
  expect(displayed).toHaveLength(1);
  expectSceneMessage(displayed[0]!, f.sceneResult(player, kind), player, kind, scope, false);
  expect(f.requests.some(request => request.path.startsWith('/v2/media-images/') || /\/files$/.test(request.path) || request.body.msg_type === 7)).toBe(false);
});

it.each((['group', 'c2c'] as const).flatMap(scope =>
  (['rift', 'adventure'] as const).flatMap(kind =>
    (['mixed', 'fallback'] as const).map(output => ({ scope, kind, output }))),
))('$scope $kind $output entering judgment after assembly reaches QQ HTTP without stale executable buttons', async ({ scope, kind, output }) => {
  const f = await fixture(scope, 4500, 20, true);
  if (output === 'fallback') f.images!.fail();
  const sending = Promise.withResolvers<void>(); const sendRelease = Promise.withResolvers<void>();
  const reviewRelease = Promise.withResolvers<void>();
  let held = false; let acting: Promise<void> | undefined;
  f.beforeSceneSend(async () => { if (!held) { held = true; sending.resolve(); await sendRelease.promise; } });
  try {
    await f[kind](); await sending.promise;
    const before = structuredClone(f.player())!;
    const view = sceneView(before, kind);
    const entered = f.holdReview(reviewRelease.promise);
    f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(kind === 'rift' ? riftDecision : successfulAction));
    acting = f.send(kind === 'rift' ? `秘境行动 ${before.riftAdventure!.id} 0 1` : '历练 1');
    await entered;
    const judging = structuredClone(f.player())!;
    expect(kind === 'rift' ? judging.riftAdventure!.status : judging.adventure!.status).toBe('judging');
    sendRelease.resolve(); await f.drainImages();
    const displayed = sceneMessages(f.messages(), view.description);
    expect(displayed).toHaveLength(1);
    expectSceneMessage(displayed[0]!, f.sceneResult(before, kind), before, kind, scope, output === 'mixed', 'player', false);
    expect(f.player()).toEqual(judging); expect(f.persistedPlayer()).toEqual(judging);
    reviewRelease.resolve(); await acting; await f.drainImages();
    expect(kind === 'rift' ? f.player()!.riftAdventure!.round : f.player()!.adventure!.status).toBe(kind === 'rift' ? 1 : 'settled');
  } finally { sendRelease.resolve(); reviewRelease.resolve(); await acting; await f.drainImages(); }
}, 30000);

it.each([
  { scope: 'group', code: 304010 }, { scope: 'c2c', code: 304010 }, { scope: 'group', code: 40034004 },
] as const)('explicit image-resource rejection $code in $scope falls back once to the complete original scene and usable actions', async ({ scope, code }) => {
  const f = await fixture(scope, 4500, 20, true);
  const release = Promise.withResolvers<void>(); f.images!.hold(release.promise);
  try {
    await f.rift(); await f.images!.entered.promise;
    const before = structuredClone(f.player())!;
    f.failNextMessage(new ApiError('fixture image resource rejected', 400, scope === 'group' ? '/v2/groups/group/messages' : '/v2/users/player/messages', code));
    release.resolve(); await f.drainImages();
    const attempted = mixedMessages(f.messages());
    expect(attempted).toHaveLength(1);
    expectSceneMessage(attempted[0]!, f.sceneResult(before, 'rift'), before, 'rift', scope, true);
    const displayed = sceneMessages(f.messages(), before.riftAdventure!.scene.description)
      .filter(request => !request.body.markdown!.content.includes('qqbot-media://image/v1/'));
    expect(displayed).toHaveLength(1);
    expectSceneMessage(displayed[0]!, f.sceneResult(before, 'rift'), before, 'rift', scope, false);
    expect(f.player()).toEqual(before);
    f.reviewResponses.splice(0, f.reviewResponses.length, JSON.stringify(riftDecision));
    await f.click(f.choice(`秘境行动 ${before.riftAdventure!.id} 0 1`)); await f.drainImages();
    expect(f.player()!.riftAdventure).toMatchObject({ id: before.riftAdventure!.id, round: 1, score: 2, status: 'awaiting' });
    expect(f.player()!.riftAdventure!.history).toHaveLength(1);
  } finally { release.resolve(); await f.drainImages(); }
}, 30000);

it('group pagination buttons stay clickable across another member chat turn and shared world change', async () => {
  const f = await fixture();
  await f.send('我要修仙');
  await f.send('我要修仙', 'other');
  f.change(player => { player.money = 1_000_000; });

  // 1) Multi-page menu keyboard (`修仙商店` > 10 items -> `a: 'page'`) survives another player chatting
  await f.send('修仙商店');
  const shopKeyboard = f.messages().at(-1)!.body.keyboard!;
  const nextShopButton = shopKeyboard.content.rows.flatMap(row => row.buttons)
    .find(button => JSON.parse(button.action.data).a === 'page')!;
  expect(nextShopButton).toBeDefined();
  f.chatResponses.push('道友你好。');
  await f.send('你好呀', 'other');
  await f.click(nextShopButton.action.data);
  const page2 = f.messages().at(-1)!;
  expect(page2.body.markdown!.content).toContain('第2/');
  expect(page2.body.keyboard).toBeDefined();
  // Clicking a purchase button on page 2 succeeds when player state is unchanged
  const page2Buy = page2.body.keyboard!.content.rows[0]!.buttons[0]!.action.data;
  const beforeMoney = f.player()!.money;
  await f.click(page2Buy);
  expect(f.player()!.money).toBeLessThan(beforeMoney);

  // 2) Market `下一页` (`command: '坊市查询 2'`) survives another player chatting & modifying shared world
  await f.send('坊市查询');
  const marketNext = f.choice('坊市查询 2');
  f.chatResponses.push('天气真好。');
  await f.send('今天天气不错', 'other');
  await f.send('修仙签到', 'other');
  await f.click(marketNext);
  expect(f.messages().at(-1)!.body.markdown!.content).toContain('2/');
  expect(f.messages().at(-1)!.body.keyboard).toBeDefined();
});

it('sect leader can promote a disciple via stripped-mention rank picker and via nickname through gateway', async () => {
  const f = await fixture();
  await f.send('我要修仙', 'leader');
  await f.send('我要修仙', 'disciple');
  f.change(player => {
    player.name = 'mirror';
    player.realm = 27;
    player.exp = 9_999_999;
    player.money = 10_000_000;
  }, 'leader');
  f.change(player => { player.name = 'Cassandra'; }, 'disciple');
  await f.send('创建宗门 合欢宗', 'leader');
  await f.send('加入宗门 合欢宗', 'disciple');

  // Stripped mention: leader sends `宗门职务变更 3` -> gets subordinate button -> clicks -> promoted
  await f.send('宗门职务变更 3', 'leader');
  const promoteBtn = f.choice('宗门职位变更 <@disciple> 3');
  await f.click(promoteBtn, { group_member_openid: 'leader' });
  expect(f.player('disciple')!.sectPosition).toBe(3);

  // Direct text with nickname + rank name without native mention
  await f.send('宗门任职 Cassandra 亲传', 'leader');
  expect(f.player('disciple')!.sectPosition).toBe(2);
});
