import { randomUUID } from 'node:crypto';

export class NativeTextError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NativeTextError';
    this.code = code;
    this.outcome = details.outcome ?? 'not_started';
    this.stage = details.stage ?? 'native-text';
    this.retryable = false;
    Object.assign(this, details);
  }
}

/** Guard the official transport without changing its body, credentials, headers or proxy. */
export function singleTextRequestFetch(nativeFetch) {
  let posts = 0;
  return {
    get posts() { return posts; },
    fetch(input, init) {
      const method = (init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET').toUpperCase();
      if (method === 'POST') {
        if (posts) throw new NativeTextError('TEXT_RETRY_BLOCKED', '推理已经提交，拒绝自动重试或切换模型', { outcome: 'unknown', requestPosts: posts });
        posts++;
      } else if (!['GET', 'HEAD'].includes(method)) throw new NativeTextError('TEXT_METHOD_BLOCKED', '推理请求方法未获准', { outcome: posts ? 'unknown' : 'not_started' });
      return nativeFetch(input, method === 'POST' ? { ...init, redirect: 'error' } : init);
    }
  };
}

function modelSelection(value) {
  if (typeof value !== 'string' || !value.startsWith('omp/') || !/^[^/\s]+\/[^\s]+$/u.test(value.slice(4))) throw new NativeTextError('MODEL_SELECTION_REQUIRED', '请选择一个明确可用的 OMP provider/model，不会选择目录第一项');
  return value;
}

/**
 * Trusted service injection, using the SAME installed SDK's modules.json entry for @oh-my-pi/pi-ai:
 * const text = createNativeTextBackend({ sdk, ai,
 *   getModelSelection: async ({cwd}) => trustedSavedOrUniqueDefaultModel(cwd) });
 * await text.inspect({cwd: peerRoot, model: explicitSelection}); // optional model wins over callback
 * await text.run({cwd, model, systemPrompt: FIXED_RULES, text: JSON.stringify(data), signal});
 * await text.close();
 *
 * Uses official ModelRegistry + AuthStorage only, then pi-ai.stream (NOT complete/completeSimple,
 * whose SDK wrapper retries empty/transient completions). No AgentSession, SessionManager,
 * extension/skill discovery, MCP, tool implementation, global memory, filesystem tool or transcript.
 * The only provider request receives tools:[] and program-bound data. Auth is resolved once using
 * the official getApiKey mechanism; credential values never leave this module or enter logs/results.
 * No providerSessionState is supplied; preferWebsockets:false and codexSseMaxAttempts:1 keep Codex
 * on one stateless SSE request. The fetch guard blocks any further inference POST before dispatch.
 */
export function createNativeTextBackend(options) { return new NativeTextBackend(options); }

export class NativeTextBackend {
  constructor({ sdk, ai, getModelSelection } = {}) {
    if (![sdk?.Settings?.isolated, sdk?.discoverAuthStorage, sdk?.ModelRegistry, ai?.stream].every(value => typeof value === 'function')) throw new NativeTextError('SDK_UNAVAILABLE', '缺少安装版官方模型目录、鉴权或 stream 接口');
    if (getModelSelection !== undefined && typeof getModelSelection !== 'function') throw new TypeError('模型选择必须来自可信服务');
    this.sdk = sdk;
    this.ai = ai;
    this.getModelSelection = getModelSelection;
    this.controller = new AbortController();
    this.pending = new Set();
    this.cleanupFailures = [];
    this.closing = null;
  }

  async selectedModel({ model, cwd }) {
    this.controller.signal.throwIfAborted();
    const selection = model ?? await this.getModelSelection?.({ cwd });
    this.controller.signal.throwIfAborted();
    return modelSelection(selection);
  }

  async privateContext(cwd) {
    const settings = this.sdk.Settings.isolated({});
    const authStorage = await this.sdk.discoverAuthStorage(undefined, { settings, cwd });
    try {
      this.controller.signal.throwIfAborted();
      const modelRegistry = new this.sdk.ModelRegistry(authStorage);
      await modelRegistry.refresh();
      return { authStorage, modelRegistry };
    } catch (error) { authStorage.close(); throw error; }
  }

  findModel(registry, selection) {
    const key = selection.slice(4);
    const slash = key.indexOf('/');
    return registry.find(key.slice(0, slash), key.slice(slash + 1));
  }

  inspect({ cwd, model } = {}) {
    return this.track((async () => {
      const selection = await this.selectedModel({ model, cwd });
      const context = await this.privateContext(cwd);
      try {
        this.controller.signal.throwIfAborted();
        const selected = this.findModel(context.modelRegistry, selection);
        // A Desktop-only runtime provider missing from this registry is NOT a vision verdict.
        if (!selected) return { model: selection, available: false, reason: 'model-not-in-private-registry', visionInput: null };
        return { model: selection, available: true, provider: selected.provider, modelId: selected.id, api: selected.api, visionInput: selected.input?.includes('image') === true };
      } finally { context.authStorage.close(); }
    })());
  }

  track(work) {
    this.pending.add(work);
    work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }

  run({ cwd, model, systemPrompt, text, images, signal, taskId, maxTokens = 1024 } = {}) {
    if (typeof systemPrompt !== 'string' || !systemPrompt || typeof text !== 'string') throw new TypeError('固定规则与请求文本必须分开提供');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new TypeError('输出上限无效');
    const local = new AbortController();
    const combined = AbortSignal.any([this.controller.signal, local.signal, ...(signal ? [signal] : [])]);
    const work = (async () => {
      let selection;
      let privateContext;
      try {
        combined.throwIfAborted();
        selection = await this.selectedModel({ model, cwd });
        privateContext = await this.privateContext(cwd);
      } catch (error) {
        if (error instanceof NativeTextError) throw error;
        throw new NativeTextError(combined.aborted ? 'CANCELED' : 'MODEL_SETUP_UNAVAILABLE', '原生模型初始化尚未提交推理请求', { outcome: 'not_started', taskId }, error);
      }
      const { authStorage, modelRegistry } = privateContext;
      const runId = randomUUID();
      const modelSessionId = `wechat-native:${runId}`;
      let selected;
      let dispatched = false;
      let guard;
      let failure;
      try {
        combined.throwIfAborted();
        selected = this.findModel(modelRegistry, selection);
        if (!selected) throw new NativeTextError('MODEL_UNAVAILABLE_PRIVATE_REGISTRY', '所选模型未出现在原生私有目录，不能冒称该模型不支持或自动换模型', { model: selection });
        if (images?.length && !selected.input?.includes('image')) throw new NativeTextError('MODEL_NO_IMAGE_INPUT', '所选模型的真实目录声明不支持图片输入', { model: selection });
        const content = [{ type: 'text', text }];
        for (const image of images ?? []) {
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || typeof image.data !== 'string' || !image.data || image.data.length > 28 * 1024 * 1024) throw new TypeError('图片输入无效或超限');
          content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
        }
        // Official one-shot resolution; do not pass a retrying credential resolver to the transport.
        const key = await modelRegistry.getApiKey(selected, modelSessionId, { signal: combined });
        if (typeof key !== 'string' || !key) throw new NativeTextError('MODEL_AUTH_UNAVAILABLE', '所选模型的官方鉴权当前不可用', { model: selection });
        combined.throwIfAborted();
        guard = singleTextRequestFetch(globalThis.fetch);
        dispatched = true;
        const stream = this.ai.stream(selected, { systemPrompt, messages: [{ role: 'user', content, timestamp: Date.now() }], tools: [] }, {
          apiKey: key, signal: combined, sessionId: modelSessionId, fetch: guard.fetch, maxTokens,
          preferWebsockets: false, codexSseMaxAttempts: 1
        });
        for await (const event of stream) {
          combined.throwIfAborted();
          if (event.type === 'toolcall_start') throw new NativeTextError('UNEXPECTED_TOOL', '无工具推理返回了工具请求，未执行任何工具', { outcome: 'unknown', taskId, runId, modelSessionId });
        }
        const response = await stream.result();
        combined.throwIfAborted();
        if (response.stopReason !== 'stop' || response.content.some(item => item.type === 'toolCall')) throw new NativeTextError('MODEL_OUTCOME_UNKNOWN', '模型未返回完整的无工具成功结果', { outcome: 'unknown', taskId, runId, modelSessionId });
        if (guard.posts !== 1) throw new NativeTextError('TEXT_SUBMISSION_UNCONFIRMED', '模型传输未形成唯一可核验的推理提交', { outcome: 'unknown', taskId, runId, modelSessionId, requestPosts: guard.posts });
        const resultText = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim();
        if (!resultText) throw new NativeTextError('EMPTY_OUTPUT', '模型没有可审核的回复文本', { outcome: 'unknown', taskId, runId, modelSessionId });
        return { text: resultText, source: 'omp-native-text', model: selection, runId, modelSessionId, requestPosts: guard.posts, outcome: 'completed', usage: { inputTokens: response.usage?.input, outputTokens: response.usage?.output, cacheReadTokens: response.usage?.cacheRead, cacheWriteTokens: response.usage?.cacheWrite } };
      } catch (error) {
        const submitted = (guard?.posts ?? 0) > 0;
        failure = error instanceof NativeTextError ? error : new NativeTextError(combined.aborted ? 'CANCELED' : 'MODEL_OUTCOME_UNKNOWN', submitted ? '原生模型提交结果待核对，不会自动重试' : '原生模型尚未提交', { outcome: submitted ? 'unknown' : 'not_started' }, error);
        Object.assign(failure, { outcome: submitted ? 'unknown' : 'not_started', stage: dispatched ? 'stream' : 'preflight', taskId, runId, modelSessionId, requestPosts: guard?.posts ?? 0 });
        local.abort();
        throw failure;
      } finally {
        local.abort();
        const cleanupErrors = [];
        try { if (selected) authStorage.sessions.release(selected.provider, modelSessionId); } catch (error) { cleanupErrors.push(error); }
        try { authStorage.close(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) {
          const cleanupFailure = new NativeTextError('NATIVE_TEXT_CLEANUP_FAILED', '自有原生文本资源未完整释放，需要核对', { outcome: (guard?.posts ?? 0) > 0 ? 'unknown' : 'not_started', stage: 'cleanup', taskId, runId, modelSessionId, requestPosts: guard?.posts ?? 0 }, new AggregateError([...(failure ? [failure] : []), ...cleanupErrors]));
          this.cleanupFailures.push(cleanupFailure);
          throw cleanupFailure;
        }
      }
    })();
    return this.track(work);
  }

  close() {
    return this.closing ??= (async () => {
      this.controller.abort();
      await Promise.allSettled([...this.pending]);
      if (this.cleanupFailures.length) throw new AggregateError(this.cleanupFailures, '原生文本资源关闭不完整');
    })();
  }
}
