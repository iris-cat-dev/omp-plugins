'use strict';

const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 75_000;
const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const SUBMISSIONS = new Set(['submit_text', 'submit_image']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function bridgeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'NativeBridgeError';
  error.code = code;
  return error;
}

// JSON.parse alone accepts duplicate properties and numeric overflow. Both are
// protocol errors: accepting either would make response attribution ambiguous.
function parseFrame(text) {
  let offset = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(text[offset] ?? '\0')) offset += 1; };
  const invalid = () => { throw bridgeError('PROTOCOL_ERROR', '原生宿主返回无效 JSON'); };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return JSON.parse(text.slice(start, offset));
      if (char === '\\') offset += 1;
    }
    return invalid();
  }
  function value(depth) {
    if (depth > 32) return invalid();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{';
      const result = object ? {} : [];
      const keys = new Set();
      const end = object ? '}' : ']';
      offset += 1;
      whitespace();
      if (text[offset] === end) { offset += 1; return result; }
      for (;;) {
        whitespace();
        if (object) {
          if (text[offset] !== '"') return invalid();
          const key = string();
          if (keys.has(key)) return invalid();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ':') return invalid();
          Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        } else result.push(value(depth + 1));
        whitespace();
        const separator = text[offset++];
        if (separator === end) return result;
        if (separator !== ',') return invalid();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (!number) return invalid();
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result)) return invalid();
    return result;
  }
  const result = value(0);
  whitespace();
  if (offset !== text.length) invalid();
  return result;
}

class NativeBridge {
  constructor({ pythonPath, accountId, stateDir, mediaRoot, engineDir, allowNative = false }) {
    for (const [name, value] of Object.entries({ pythonPath, stateDir, mediaRoot, engineDir })) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
        throw bridgeError('INVALID_CONFIGURATION', `${name} 必须是绝对路径`);
      }
    }
    if (typeof accountId !== 'string' || !/^wxid_[A-Za-z0-9_-]+$/.test(accountId)) {
      throw bridgeError('INVALID_CONFIGURATION', 'accountId 必须是稳定的 wxid_ 账号 ID');
    }
    if (typeof allowNative !== 'boolean') throw bridgeError('INVALID_CONFIGURATION', 'allowNative 必须是布尔值');
    this._options = Object.freeze({ pythonPath, accountId, stateDir, mediaRoot, engineDir, allowNative });
    this._state = 'new';
    this._pending = new Map();
    this._sequence = 0;
    this._instance = randomUUID();
    this._child = null;
    this._generation = null;
    this._startPromise = null;
    this._closePromise = null;
    this._shutdownPromise = null;
    this._failure = null;
    this._stderr = '';
  }

  start() {
    if (this._state === 'starting' || this._state === 'ready') return this._startPromise;
    if (this._state !== 'new') return Promise.reject(this._failure ?? bridgeError('BRIDGE_CLOSED', '此原生宿主实例已关闭，请显式创建新实例'));
    this._state = 'starting';
    this._startPromise = this._start();
    return this._startPromise;
  }

  async _start() {
    const options = this._options;
    const args = ['-B', path.join(PROJECT_ROOT, 'bridge', 'worker.py'),
      '--account-id', options.accountId, '--state-dir', options.stateDir,
      '--media-root', options.mediaRoot, '--engine-dir', options.engineDir];
    if (options.allowNative) args.push('--allow-native');
    const generation = {};
    this._generation = generation;
    try {
      const child = childProcess.spawn(options.pythonPath, args, {
        cwd: PROJECT_ROOT, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONPATH: '', PYTHONHOME: '' }
      });
      this._child = child;
      let pieces = [];
      let bytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      child.stdout.on('data', chunk => {
        if (this._generation !== generation) return;
        try {
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const end = newline < 0 ? chunk.length : newline;
            const piece = chunk.subarray(start, end);
            bytes += piece.length;
            if (bytes > MAX_FRAME_BYTES) throw bridgeError('PROTOCOL_ERROR', '原生宿主响应超过帧长度限制');
            pieces.push(piece);
            if (newline < 0) break;
            const frame = decoder.decode(Buffer.concat(pieces, bytes));
            pieces = [];
            bytes = 0;
            this._receive(parseFrame(frame));
            if (this._generation !== generation) return;
            start = newline + 1;
          }
        } catch (error) {
          this._fail(bridgeError('PROTOCOL_ERROR', '原生宿主协议解析失败', error));
        }
      });
      child.stderr.on('data', chunk => { this._stderr = (this._stderr + chunk.toString('utf8')).slice(-16_384); });
      child.stdout.on('end', () => {
        if (this._generation !== generation) return;
        this._fail(bridgeError(bytes ? 'PROTOCOL_ERROR' : 'WORKER_EOF', bytes ? '原生宿主在完整响应前关闭输出' : '原生宿主意外关闭输出'));
      });
      child.stdout.on('error', error => { if (this._generation === generation) this._fail(bridgeError('TRANSPORT_ERROR', '无法读取原生宿主响应', error)); });
      child.stdin.on('error', error => { if (this._generation === generation) this._fail(bridgeError('TRANSPORT_ERROR', '无法向原生宿主写入请求', error)); });
      child.stderr.on('error', error => { if (this._generation === generation) this._fail(bridgeError('TRANSPORT_ERROR', '原生宿主诊断管道失败', error)); });
      child.on('error', error => { if (this._generation === generation) this._fail(bridgeError('WORKER_ERROR', '原生宿主进程错误', error)); });
      child.once('exit', (code, signal) => {
        if (this._generation === generation) this._fail(bridgeError('WORKER_EXIT', `原生宿主退出（code=${code}, signal=${signal}）`));
      });
      this._exited = new Promise(resolve => child.once('close', (code, signal) => { this._didExit = true; resolve({ code, signal }); }));
      const status = await this._send('status', {}, START_TIMEOUT_MS);
      if (!isObject(status) || status.nativeAllowed !== options.allowNative || status.connected !== false ||
          !Number.isSafeInteger(status.unknownCount) || status.unknownCount < 0 ||
          !Number.isSafeInteger(status.preparedImages) || status.preparedImages < 0) {
        throw bridgeError('PROTOCOL_ERROR', '原生宿主未返回有效初始状态');
      }
      if (this._state !== 'starting') throw this._failure ?? bridgeError('BRIDGE_CLOSED', '原生宿主启动已取消');
      this._state = 'ready';
      return status;
    } catch (error) {
      this._fail(error.code ? error : bridgeError('WORKER_ERROR', '无法启动原生宿主', error));
      throw this._failure;
    }
  }

  request(method, params = {}) {
    if (this._state !== 'ready') {
      return Promise.reject(this._requestError(this._failure ?? bridgeError('BRIDGE_NOT_READY', '请先等待 start() 完成；已关闭实例不可重用'), method, params));
    }
    if (method === 'close') return this.close();
    return this._send(method, params, REQUEST_TIMEOUT_MS);
  }

  _send(method, params, timeout) {
    if (typeof method !== 'string' || !method || !isObject(params)) return Promise.reject(bridgeError('INVALID_REQUEST', 'method 必须是非空字符串，params 必须是对象'));
    const id = `${this._instance}:${++this._sequence}`;
    let frame;
    let requestParams;
    try {
      frame = JSON.stringify({ id, method, params }, (_key, value) => {
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) {
          throw new TypeError('请求仅接受有限 JSON 值');
        }
        return value;
      }) + '\n';
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new RangeError('请求超过帧长度限制');
      const encoded = parseFrame(frame);
      if (!isObject(encoded.params)) throw new TypeError('params 必须编码为 JSON 对象');
      requestParams = { requestId: encoded.params.requestId };
    } catch (error) { return Promise.reject(bridgeError('INVALID_REQUEST', '无法编码原生宿主请求', error)); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(bridgeError('REQUEST_TIMEOUT', `原生宿主 ${method} 请求超时`)), timeout);
      this._pending.set(id, { method, params: requestParams, resolve, reject, timer });
      try {
        this._child.stdin.write(frame, 'utf8', error => {
          if (error && this._pending.has(id)) this._fail(bridgeError('TRANSPORT_ERROR', '原生宿主请求写入失败', error));
        });
      } catch (error) { this._fail(bridgeError('TRANSPORT_ERROR', '原生宿主请求写入失败', error)); }
    });
  }

  _receive(response) {
    if (!isObject(response) || typeof response.id !== 'string' ||
        Object.keys(response).length !== 2 || (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) {
      throw bridgeError('PROTOCOL_ERROR', '原生宿主响应结构无效');
    }
    const pending = this._pending.get(response.id);
    if (!pending) throw bridgeError('PROTOCOL_ERROR', '原生宿主响应 ID 不属于待处理请求');
    if (Object.hasOwn(response, 'error')) {
      const error = response.error;
      if (!isObject(error) || typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' ||
          (Object.hasOwn(error, 'outcome') && !['unknown', 'not_submitted'].includes(error.outcome)) ||
          (Object.hasOwn(error, 'requestId') && typeof error.requestId !== 'string') ||
          Object.keys(error).some(key => !['code', 'message', 'outcome', 'requestId'].includes(key))) {
        throw bridgeError('PROTOCOL_ERROR', '原生宿主错误结构无效');
      }
      if (error.requestId !== undefined && error.requestId !== pending.params.requestId) throw bridgeError('PROTOCOL_ERROR', '原生宿主业务请求 ID 不匹配');
      this._settle(response.id);
      const rejected = bridgeError(error.code, error.message);
      if (error.outcome !== undefined) rejected.outcome = error.outcome;
      if (error.requestId !== undefined) rejected.requestId = error.requestId;
      pending.reject(rejected);
    } else {
      if (!isObject(response.result)) throw bridgeError('PROTOCOL_ERROR', '原生宿主 result 必须是对象');
      if (SUBMISSIONS.has(pending.method) &&
          (response.result.requestId !== pending.params.requestId || !['submitted', 'unknown'].includes(response.result.status) || typeof response.result.reviewed !== 'boolean')) {
        throw bridgeError('PROTOCOL_ERROR', '原生宿主提交结果不完整或不属于本次业务请求');
      }
      this._settle(response.id);
      if (pending.method === 'close') this._generation = null;
      pending.resolve(response.result);
    }
  }

  _settle(id) {
    clearTimeout(this._pending.get(id).timer);
    this._pending.delete(id);
  }

  _requestError(error, method, params) {
    const result = bridgeError(error.code, error.message, error);
    if (SUBMISSIONS.has(method)) {
      result.outcome = 'unknown';
      if (typeof params?.requestId === 'string') result.requestId = params.requestId;
    }
    return result;
  }

  _rejectPending(error) {
    for (const [id, pending] of this._pending) {
      this._settle(id);
      pending.reject(this._requestError(error, pending.method, pending.params));
    }
  }

  _fail(error) {
    if (this._state === 'closed' || this._state === 'failed') return;
    if (this._stderr) error.stderr = this._stderr;
    this._failure = error;
    this._state = 'failed';
    this._generation = null;
    this._rejectPending(error);
    this._shutdown().catch(() => {});
  }

  _shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    const child = this._child;
    if (!child) return Promise.resolve({ closed: true });
    this._shutdownPromise = new Promise((resolve, reject) => {
      let killTimer;
      let finalTimer;
      const finish = error => {
        clearTimeout(killTimer);
        clearTimeout(finalTimer);
        if (error) reject(error); else resolve({ closed: true });
      };
      this._exited.then(() => finish());
      if (this._didExit) return;
      killTimer = setTimeout(() => {
        // This ChildProcess is the only process we own. Never use PID discovery,
        // taskkill /T, or terminate the attached WeChat process.
        finalTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(bridgeError('CLOSE_TIMEOUT', '原生宿主未在限定时间内退出；未终止任何其他进程'));
        }, CLOSE_TIMEOUT_MS);
        try { child.kill(); } catch (error) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(bridgeError('CLOSE_TIMEOUT', '无法终止自有原生宿主进程', error));
        }
      }, CLOSE_TIMEOUT_MS);
      try { child.stdin.end(); } catch { child.stdin.destroy(); }
    });
    return this._shutdownPromise;
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._close();
    return this._closePromise;
  }

  async _close() {
    const wasReady = this._state === 'ready';
    const hadPending = this._pending.size > 0;
    this._state = 'closing';
    this._rejectPending(bridgeError('BRIDGE_CLOSED', '原生宿主实例正在关闭；未决提交不会自动重发'));
    let responseError;
    if (wasReady && !hadPending && this._generation) {
      try {
        const response = await this._send('close', {}, CLOSE_TIMEOUT_MS);
        if (response.closed !== true) responseError = bridgeError('PROTOCOL_ERROR', '原生宿主未确认关闭');
      } catch (error) { responseError = error; }
    }
    this._generation = null;
    try { await this._shutdown(); } finally { this._state = 'closed'; }
    if (responseError) throw responseError;
    return { closed: true };
  }
}

module.exports = { NativeBridge };
