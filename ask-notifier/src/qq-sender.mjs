import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REQUEST_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const INSPECT_STATES = new Set(['ready', 'not_logged_in', 'unsupported', 'multiple_accounts', 'not_installed', 'login_timeout', 'error']);
const SEND_STATES = new Set(['submitted', 'not_logged_in', 'unsupported', 'multiple_accounts', 'failed', 'unknown']);
const TARGETS = new Set(['phone', 'pad']);
const UNKNOWN = 'QQ 工作进程中断或超时，客户端提交结果未知，禁止重发；关闭提醒不等于撤回 QQ 工作。';
const inspection = (state, reason = null) => ({ state, reason, accountId: null, version: null });
const outcome = (state, reason = null, accountId = null) => ({ state, reason, accountId });
const MAX_LINE_BYTES = 65_536;

function runtimePath(packageRoot) {
  const explicit = process.env.OMP_QQ_NOTIFIER_PYTHON;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(explicit)) throw new Error('OMP_QQ_NOTIFIER_PYTHON 必须是已存在的独立 Python x64 的绝对路径。');
    return explicit;
  }
  for (const candidate of [path.join(packageRoot, 'runtime/python/python.exe'), path.join(packageRoot, '.runtime/python/Scripts/python.exe')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('QQ 提醒运行环境未准备；请重新准备包含 psutil 的完整提醒运行时。');
}

function validateResult(method, value) {
  if (method === 'finishBatch' && value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('QQ 工作进程回包不是对象。');
  if (method === 'close') {
    if (value.closed !== true) throw new Error('QQ 工作进程关闭回包无效。');
    return value;
  }
  if (method === 'beginLaunch' || method === 'claimLaunch') {
    const field = method === 'beginLaunch' ? 'mayLaunch' : 'owned';
    if (Object.keys(value).length !== 1 || typeof value[field] !== 'boolean') throw new Error('QQ 临时启动所有权回包无效。');
    return value;
  }
  if (method === 'installation') {
    if (!(value.executable === null || (typeof value.executable === 'string' && path.isAbsolute(value.executable)
        && path.basename(value.executable).toLowerCase() === 'qq.exe'))
        || !(value.reason === null || typeof value.reason === 'string')) throw new Error('QQ 安装入口回包无效。');
    return value;
  }
  if (method === 'query') {
    if (value.found === false && Object.keys(value).length === 1) return value;
    if (value.found !== true) throw new Error('QQ 提交记录回包无效。');
  }
  const isInspection = method === 'inspect' || method === 'finishBatch';
  if (method === 'finishBatch' && !['not_logged_in', 'error'].includes(value.state)) throw new Error('QQ 批次退出回包无效。');
  if (!(isInspection ? INSPECT_STATES : SEND_STATES).has(value.state)
      || !(value.reason === null || typeof value.reason === 'string')
      || !(value.accountId === null || (typeof value.accountId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.accountId)))) {
    throw new Error('QQ 工作进程状态回包无效。');
  }
  if (isInspection) {
    if (!(value.version === null || typeof value.version === 'string')
        || (value.state === 'ready' && value.accountId === null)) throw new Error('QQ 已登录身份回包无效。');
    return { state: value.state, reason: value.reason, accountId: value.accountId, version: value.version };
  }
  if (value.state === 'submitted' && value.accountId === null) throw new Error('QQ 提交回包缺少已核验身份。');
  return method === 'query' ? { found: true, ...outcome(value.state, value.reason, value.accountId) } : outcome(value.state, value.reason, value.accountId);
}

class WorkerFailure extends Error {
  constructor(message, mayHaveSubmitted = false, requestRejected = false) {
    super(message);
    this.mayHaveSubmitted = mayHaveSubmitted;
    this.requestRejected = requestRejected;
  }
}

export function createQQSender({ packageRoot, dataDirectory, signal }) {
  if (!path.isAbsolute(packageRoot) || !path.isAbsolute(dataDirectory)) throw new TypeError('packageRoot 和 dataDirectory 必须是绝对路径。');
  let worker = null;
  let closed = signal?.aborted ?? false;
  let sequence = 0;
  let queue = Promise.resolve();
  let closing;
  let login;
  let launchedQQ = null;
  let temporaryQQ = null;
  let sealed = false;
  const bindings = new Map();
  const owned = new Set();
  const uncertain = new Map();
  const loginAbort = new AbortController();
  const serial = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  function stopOwned(current, reason) {
    if (current.dead) return;
    current.dead = true;
    if (worker === current) worker = null;
    if (temporaryQQ?.worker === current) temporaryQQ = null;
    for (const pending of current.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WorkerFailure(reason, pending.method === 'send' && pending.written));
    }
    current.pending.clear();
    // Only this sender's Python bridge; QQ exits solely through its guarded native RPC.
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill();
  }

  function ensureWorker() {
    if (closed || signal?.aborted) throw new WorkerFailure('QQ 提醒发送器已关闭，本次未提交。');
    if (worker && !worker.dead) return worker;
    const entry = path.join(packageRoot, 'bridge/qq_worker.py');
    if (!existsSync(entry)) throw new WorkerFailure('插件缺少 bridge/qq_worker.py，请重新解压完整分发包。');
    const child = spawn(runtimePath(packageRoot), ['-I', '-B', '-u', entry, '--state-dir', path.join(dataDirectory, 'qq-sender')], {
      cwd: packageRoot, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const current = { child, pending: new Map(), buffer: '', dead: false, exited: null };
    owned.add(current);
    current.exited = new Promise((resolve) => child.once('close', () => { owned.delete(current); resolve(); }));
    worker = current;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (current.dead) return;
      current.buffer += chunk;
      while (true) {
        const newline = current.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = current.buffer.slice(0, newline);
        current.buffer = current.buffer.slice(newline + 1);
        try {
          if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('QQ 工作进程回包超长。');
          const envelope = JSON.parse(line);
          if (!envelope || typeof envelope !== 'object' || !Number.isSafeInteger(envelope.id)) throw new Error('QQ NDJSON 回包无效。');
          const pending = current.pending.get(envelope.id);
          if (!pending) throw new Error('QQ 工作进程返回非本次请求。');
          if (Object.hasOwn(envelope, 'error')) {
            if (Object.hasOwn(envelope, 'result') || !envelope.error || typeof envelope.error.message !== 'string') throw new Error('QQ 错误回包无效。');
            clearTimeout(pending.timer);
            current.pending.delete(envelope.id);
            const rejected = envelope.error.code === 'invalid_request';
            pending.reject(new WorkerFailure(envelope.error.message, !rejected && pending.method === 'send' && pending.written, rejected));
          } else {
            const value = validateResult(pending.method, envelope.result);
            clearTimeout(pending.timer);
            current.pending.delete(envelope.id);
            pending.resolve(value);
          }
        } catch (error) { stopOwned(current, error.message); return; }
      }
      if (Buffer.byteLength(current.buffer, 'utf8') > MAX_LINE_BYTES) stopOwned(current, 'QQ NDJSON 回包超长。');
    });
    // Do not forward Python diagnostics: an external error may contain private data.
    child.stderr.resume();
    child.stdin.on('error', () => stopOwned(current, 'QQ 工作进程管道中断。'));
    child.on('error', () => stopOwned(current, 'QQ 工作进程启动失败。'));
    child.on('close', () => stopOwned(current, 'QQ 工作进程已退出。'));
    return current;
  }

  function requestOn(current, method, params, timeout = method === 'send' ? 30_000 : method === 'inspect' ? 20_000 : 10_000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const pending = { method, resolve, reject, written: false, timer: null };
      pending.timer = setTimeout(() => stopOwned(current, 'QQ 工作进程响应超时。'), timeout);
      pending.timer.unref?.();
      current.pending.set(id, pending);
      try {
        pending.written = true;
        current.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', (error) => {
          if (error) stopOwned(current, 'QQ 工作进程写入失败。');
        });
      } catch { stopOwned(current, 'QQ 工作进程写入失败。'); }
    });
  }
  const request = (method, params) => requestOn(ensureWorker(), method, params);
  const platformSupported = () => process.platform === 'win32' && process.arch === 'x64';
  const inspect = () => serial(async () => {
    if (closed) return inspection('error', 'QQ 提醒发送器已关闭。');
    if (!platformSupported()) return inspection('unsupported', 'QQ 提醒仅支持 Windows x64 桌面版 QQ。');
    try { return await request('inspect', {}); }
    catch (error) { return inspection('error', error.message); }
  });

  const ensureLoggedIn = ({ signal: waitSignal, mayContinue } = {}) => {
    if (login) return login;
    const permitted = () => !closed && !signal?.aborted && !waitSignal?.aborted && !loginAbort.signal.aborted && (mayContinue?.() ?? true);
    const canceled = () => inspection('not_logged_in', '已停止等待 QQ 自动登录；QQ 保持打开，本次未发送。');
    login = (async () => {
      if (!permitted()) return canceled();
      const deadline = Date.now() + 60_000;
      let connection = await inspect();
      if (!permitted()) return canceled();
      if (connection.state !== 'not_logged_in') return connection;
      let installed;
      try { installed = await serial(() => request('installation', {})); }
      catch (error) { return inspection('error', error.message); }
      if (!permitted()) return canceled();
      if (!installed.executable) return inspection('not_installed', installed.reason || '未发现官方 QQ 安装入口。');
      if (!launchedQQ || launchedQQ.exitCode !== null || launchedQQ.signalCode !== null) {
        let launchWorker, decision;
        try {
          ({ current: launchWorker, decision } = await serial(async () => {
            const current = ensureWorker();
            return { current, decision: await requestOn(current, 'beginLaunch', {}) };
          }));
        } catch (error) { return inspection('error', error.message); }
        if (!permitted()) return canceled();
        if (decision.mayLaunch) {
          try {
            const environment = { ...process.env };
            // QQ is an Electron GUI, not an OMP Node worker.
            delete environment.ELECTRON_RUN_AS_NODE;
            await new Promise((resolve, reject) => {
              const child = spawn(installed.executable, [], { cwd: path.dirname(installed.executable), env: environment, detached: true, windowsHide: false, shell: false, stdio: 'ignore' });
              launchedQQ = child;
              child.once('error', reject);
              child.once('spawn', () => { child.unref(); resolve(); });
            });
            if (launchedQQ.exitCode === null && launchedQQ.signalCode === null && worker === launchWorker && !launchWorker.dead) {
              const claimed = await serial(() => requestOn(launchWorker, 'claimLaunch', { pid: launchedQQ.pid }));
              if (claimed.owned) temporaryQQ = { worker: launchWorker, submitted: false, unsafe: false };
            }
          } catch { return inspection('error', '无法启动或认领官方 QQ；未输入账号密码，本次不重试。'); }
        }
      }
      while (permitted() && Date.now() < deadline) {
        connection = await inspect();
        if (!permitted()) return canceled();
        if (connection.state === 'ready' || !['not_logged_in', 'unsupported'].includes(connection.state)) return connection;
        // unsupported is tolerated only while the just-started window is still initializing.
        await new Promise((resolve) => {
          const signals = [waitSignal, signal, loginAbort.signal].filter(Boolean);
          const finish = () => { clearTimeout(timer); for (const item of signals) item.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, Math.min(300, Math.max(0, deadline - Date.now())));
          for (const item of signals) item.addEventListener('abort', finish, { once: true });
          if (!permitted()) finish();
        });
      }
      return permitted() ? inspection('login_timeout', '等待 QQ 自动登录超过 60 秒；QQ 保持打开，本次未发送。') : canceled();
    })().finally(() => { login = null; });
    return login;
  };

  const send = (params) => serial(async () => {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 3
        || !Object.hasOwn(params, 'requestId') || !Object.hasOwn(params, 'target') || !Object.hasOwn(params, 'text')
        || typeof params.requestId !== 'string' || !REQUEST_ID.test(params.requestId)
        || !TARGETS.has(params.target)
        || typeof params.text !== 'string' || !params.text || params.text.includes('\0')
        || !params.text.isWellFormed() || Buffer.byteLength(params.text, 'utf8') > 4094) {
      return outcome('failed', '仅允许 requestId、target（phone/pad）和 1–4094 UTF-8 字节、无 NUL 的 text。');
    }
    params = { requestId: params.requestId, target: params.target, text: params.text };
    const bound = bindings.get(params.requestId);
    if (bound && (bound.target !== params.target || bound.text !== params.text)) {
      return outcome('failed', 'requestId 已绑定其他目标或内容，禁止重发。');
    }
    if (!bound) bindings.set(params.requestId, { target: params.target, text: params.text });
    if (uncertain.has(params.requestId)) return uncertain.get(params.requestId);
    if (closed || signal?.aborted) return outcome('failed', 'QQ 提醒发送器已关闭，本次未提交。');
    if (!platformSupported()) return outcome('unsupported', 'QQ 提醒仅支持 Windows x64 桌面版 QQ。');
    try {
      const saved = await request('query', params);
      if (saved.found) {
        const value = outcome(saved.state, saved.reason, saved.accountId);
        if (value.state === 'unknown') uncertain.set(params.requestId, value);
        return value;
      }
    } catch (error) {
      if (error.requestRejected) return outcome('failed', error.message);
      const value = outcome('unknown', `无法核对 QQ requestId 的持久化记录，禁止重发：${error.message}`);
      uncertain.set(params.requestId, value);
      sealed = true;
      return value;
    }
    if (sealed) return outcome('failed', 'QQ 存在未决提交，已停止后续发送；更换目标或 requestId 不能绕过。');
    if (closed || signal?.aborted) return outcome('failed', 'QQ 提醒发送器已关闭，本次未提交。');
    try {
      const value = await request('send', params);
      if (value.state === 'unknown') {
        sealed = true;
        uncertain.set(params.requestId, value);
      }
      if (temporaryQQ && value.state === 'submitted') temporaryQQ.submitted = true;
      return value;
    } catch (error) {
      const value = outcome(error.mayHaveSubmitted ? 'unknown' : 'failed', error.mayHaveSubmitted ? UNKNOWN : error.message);
      if (value.state === 'unknown') {
        sealed = true;
        uncertain.set(params.requestId, value);
      }
      return value;
    }
  }).then((value) => {
    if (temporaryQQ && value.state !== 'submitted') temporaryQQ.unsafe = true;
    return value;
  });

  const finishBatch = ({ mayClose } = {}) => serial(async () => {
    const temporary = temporaryQQ;
    if (!temporary || temporary.unsafe || !temporary.submitted || login || closed || signal?.aborted
        || worker !== temporary.worker || temporary.worker.dead) return null;
    try {
      // Keep the controller's queue/close check immediately beside the exit RPC.
      if (mayClose !== undefined && mayClose() !== true) return null;
      if (closed || signal?.aborted) return null;
      const value = await requestOn(temporary.worker, 'finishBatch', {}, 20_000);
      if (value?.state === 'not_logged_in') {
        temporaryQQ = null;
        launchedQQ = null;
        await requestOn(temporary.worker, 'close', {}, 1500).catch(() => {})
          .finally(() => stopOwned(temporary.worker, '临时 QQ 已正常退出，QQ 工作进程已释放。'));
        await temporary.worker.exited;
      } else if (value?.state === 'error') temporary.unsafe = true;
      return value;
    } catch (error) {
      temporary.unsafe = true;
      return inspection('error', `临时 QQ 正常退出未确认；未重试或强制终止：${error.message}`);
    }
  });

  const close = () => {
    if (closing) return closing;
    closed = true;
    loginAbort.abort();
    signal?.removeEventListener('abort', abort);
    const current = worker;
    const children = [...owned];
    let stopped = Promise.resolve();
    if (current) {
      if (current.pending.size) stopOwned(current, UNKNOWN);
      else stopped = requestOn(current, 'close', {}, 1500).catch(() => {}).finally(() => stopOwned(current, 'QQ 工作进程已关闭。'));
    }
    for (const child of children) if (child !== current) stopOwned(child, UNKNOWN);
    closing = Promise.all([queue.catch(() => {}), stopped, ...children.map((child) => child.exited)]).then(() => undefined);
    return closing;
  };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  return { inspect, ensureLoggedIn, send, finishBatch, close };
}
