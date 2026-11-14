'use strict';

const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const MAX_FRAME = 1024 * 1024;
const TIMEOUT = 75_000;
const CLOSE_TIMEOUT = 2_000;
const ACCOUNT = /^wxid_[A-Za-z0-9_-]{1,120}$/;
const TARGET = /^(?:wxid_[A-Za-z0-9_-]{1,120}|[0-9]{1,100}@chatroom)$/;
const BATCH = /^[a-f0-9]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const memberId = value => typeof value === 'string' && value.trim().length > 0 && value !== 'notify@all' &&
  Buffer.byteLength(value) <= 256 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const publicName = (value, id) => typeof value === 'string' && value.trim().length > 0 && value !== id && Buffer.byteLength(value) <= 4096;

function receiverError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'NativeReceiverError';
  error.code = code;
  return error;
}

// Reject duplicate keys, overflow and excessive nesting before using attribution.
function parseFrame(text) {
  let offset = 0;
  const bad = () => { throw receiverError('PROTOCOL_ERROR', '只读接收器返回无效 JSON。'); };
  const space = () => { while (/[\t\r\n ]/.test(text[offset] ?? '\0')) offset++; };
  function string() {
    const begin = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return JSON.parse(text.slice(begin, offset));
      if (char === '\\') offset++;
    }
    return bad();
  }
  function value(depth) {
    if (depth > 32) return bad();
    space();
    if (text[offset] === '"') return string();
    if (text[offset] === '{' || text[offset] === '[') {
      const isObject = text[offset++] === '{';
      const result = isObject ? {} : [];
      const keys = new Set();
      const end = isObject ? '}' : ']';
      space();
      if (text[offset] === end) { offset++; return result; }
      for (;;) {
        space();
        if (isObject) {
          if (text[offset] !== '"') return bad();
          const key = string();
          if (keys.has(key)) return bad();
          keys.add(key);
          space();
          if (text[offset++] !== ':') return bad();
          Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true });
        } else result.push(value(depth + 1));
        space();
        const separator = text[offset++];
        if (separator === end) return result;
        if (separator !== ',') return bad();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (!number) return bad();
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result)) return bad();
    return result;
  }
  const result = value(0);
  space();
  if (offset !== text.length) bad();
  return result;
}

function platformId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < (1n << 64n);
}

class NativeReceiver {
  constructor({ pythonPath, accountId, pid, createdAtMs, bindingPath, stateDir, allowedTargets, allowRead = false }) {
    for (const [key, value] of Object.entries({ pythonPath, bindingPath, stateDir })) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
        throw receiverError('INVALID_CONFIGURATION', `${key} 必须是绝对路径。`);
      }
    }
    if (typeof accountId !== 'string' || !ACCOUNT.test(accountId) ||
        !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 ||
        typeof allowRead !== 'boolean' || !Array.isArray(allowedTargets) || !allowedTargets.length || allowedTargets.length > 256 ||
        allowedTargets.some(value => typeof value !== 'string' || !TARGET.test(value) || value === accountId) ||
        new Set(allowedTargets).size !== allowedTargets.length) {
      throw receiverError('INVALID_CONFIGURATION', '接收器需要显式账号、PID、创建时间、允许会话与读取开关。');
    }
    this._options = Object.freeze({ pythonPath, accountId, pid, createdAtMs, bindingPath, stateDir, allowedTargets: Object.freeze([...allowedTargets]), allowRead });
    this._targets = new Set(allowedTargets);
    this._state = 'new';
    this._sequence = 0;
    this._instance = randomUUID();
    this._pending = new Map();
    this._child = this._generation = this._failure = null;
    this._startPromise = this._closePromise = this._shutdownPromise = null;
  }

  start() {
    if (this._state === 'starting' || this._state === 'ready') return this._startPromise;
    if (this._state !== 'new') return Promise.reject(this._failure ?? receiverError('RECEIVER_CLOSED', '接收器实例不可重用。'));
    if (!this._options.allowRead) return Promise.reject(receiverError('READ_DISABLED', '只读接收默认关闭，需要显式 allowRead:true。'));
    this._state = 'starting';
    this._startPromise = this._start();
    return this._startPromise;
  }

  async _start() {
    const options = this._options;
    const args = ['-B', path.join(ROOT, 'bridge', 'receiver.py'), '--account-id', options.accountId,
      '--pid', String(options.pid), '--created-at-ms', String(options.createdAtMs),
      '--binding-path', options.bindingPath, '--state-dir', options.stateDir, '--allow-read'];
    for (const target of options.allowedTargets) args.push('--allowed-target', target);
    const generation = {};
    this._generation = generation;
    try {
      const child = childProcess.spawn(options.pythonPath, args, {
        cwd: ROOT, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONPATH: '', PYTHONHOME: '' }
      });
      this._child = child;
      this._exited = new Promise(resolve => child.once('close', (code, signal) => { this._didExit = true; resolve({ code, signal }); }));
      let pieces = [], bytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      child.stdout.on('data', chunk => {
        if (this._generation !== generation) return;
        try {
          for (let begin = 0; begin < chunk.length;) {
            const newline = chunk.indexOf(10, begin);
            const end = newline < 0 ? chunk.length : newline;
            const piece = chunk.subarray(begin, end);
            bytes += piece.length;
            if (bytes > MAX_FRAME) throw receiverError('PROTOCOL_ERROR', '接收器响应超过帧边界。');
            pieces.push(piece);
            if (newline < 0) break;
            const frame = decoder.decode(Buffer.concat(pieces, bytes));
            pieces = []; bytes = 0;
            this._receive(parseFrame(frame));
            if (this._generation !== generation) return;
            begin = newline + 1;
          }
        } catch (error) { this._fail(receiverError('PROTOCOL_ERROR', '接收器响应无法完整核验。', error)); }
      });
      // Drain diagnostics but never attach raw database paths, keys or chat to errors.
      child.stderr.on('data', () => {});
      child.stdout.on('end', () => {
        if (this._generation === generation) this._fail(receiverError(bytes ? 'PROTOCOL_ERROR' : 'WORKER_EOF', '接收器在完成请求前关闭输出。'));
      });
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.on('error', error => { if (this._generation === generation) this._fail(receiverError('TRANSPORT_ERROR', '接收器管道失败。', error)); });
      }
      child.on('error', error => { if (this._generation === generation) this._fail(receiverError('WORKER_ERROR', '接收器进程失败。', error)); });
      child.once('exit', () => { if (this._generation === generation) this._fail(receiverError('WORKER_EXIT', '接收器意外退出。')); });
      const status = await this._send('start', {});
      if (this._state !== 'starting') throw this._failure ?? receiverError('RECEIVER_CLOSED', '接收器启动已取消。');
      this._state = 'ready';
      return status;
    } catch (error) {
      if (this._state !== 'closing' && this._state !== 'closed') this._fail(error.code ? error : receiverError('WORKER_ERROR', '无法启动接收器。', error));
      throw this._failure ?? error;
    }
  }

  _errors(errors) {
    return Array.isArray(errors) && errors.every(error =>
      object(error) && typeof error.code === 'string' && error.code.length > 0 && typeof error.message === 'string' &&
      (!Object.hasOwn(error, 'sessionId') || this._targets.has(error.sessionId)) &&
      Object.keys(error).every(key => ['sessionId', 'code', 'message'].includes(key)));
  }

  _validate(method, params, result) {
    const options = this._options;
    if (!object(result)) return false;
    if (method === 'start') {
      return exact(result, ['ready', 'readAllowed', 'accountId', 'pid', 'createdAtMs', 'errors', 'pendingBatchId']) &&
        result.ready === true && result.readAllowed === true && result.accountId === options.accountId &&
        result.pid === options.pid && result.createdAtMs === options.createdAtMs && this._errors(result.errors) &&
        (result.pendingBatchId === null || (typeof result.pendingBatchId === 'string' && BATCH.test(result.pendingBatchId)));
    }
    if (method === 'poll') {
      if (!exact(result, ['batchId', 'events', 'errors']) || !this._errors(result.errors) || !Array.isArray(result.events) ||
          !(result.batchId === null || (typeof result.batchId === 'string' && BATCH.test(result.batchId))) ||
          (result.batchId === null && result.events.length !== 0)) return false;
      const ids = new Set();
      return result.events.every(event => {
        if (!exact(event, ['accountId', 'scope', 'sessionId', 'senderId', 'senderName', 'messageId', 'createdAtMs', 'text', 'mentions']) ||
            event.accountId !== options.accountId || !this._targets.has(event.sessionId) ||
            event.scope !== (event.sessionId.endsWith('@chatroom') ? 'group' : 'private') ||
            !memberId(event.senderId) || event.senderId === options.accountId ||
            (event.scope === 'private' && event.senderId !== event.sessionId) || !publicName(event.senderName, event.senderId) ||
            !platformId(event.messageId) || !Number.isSafeInteger(event.createdAtMs) || event.createdAtMs < 0 ||
            typeof event.text !== 'string' || !event.text || event.text.includes('\0') || Buffer.byteLength(event.text) > 128 * 1024 ||
            !Array.isArray(event.mentions) || new Set(event.mentions).size !== event.mentions.length ||
            event.mentions.some(id => id !== 'notify@all' && !memberId(id))) return false;
        const key = JSON.stringify([event.sessionId, event.messageId]);
        if (ids.has(key)) return false;
        ids.add(key);
        return true;
      });
    }
    if (method === 'ack') return exact(result, ['acked', 'batchId']) && result.acked === true && result.batchId === params.batchId;
    if (method === 'members') {
      const seen = new Set();
      return exact(result, ['groupId', 'members']) && result.groupId === params.groupId && Array.isArray(result.members) &&
        result.members.length > 0 && result.members.every(member => {
          if (!exact(member, ['userId', 'name']) || !memberId(member.userId) ||
              seen.has(member.userId) || !publicName(member.name, member.userId)) return false;
          seen.add(member.userId);
          return true;
        }) && seen.has(options.accountId);
    }
    return method === 'close' && exact(result, ['closed']) && result.closed === true;
  }

  _receive(response) {
    if (!object(response) || typeof response.id !== 'string' || Object.keys(response).length !== 2 ||
        Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) throw receiverError('PROTOCOL_ERROR', '接收器响应归属无效。');
    const pending = this._pending.get(response.id);
    if (!pending) throw receiverError('PROTOCOL_ERROR', '接收器响应没有对应请求。');
    if (Object.hasOwn(response, 'error')) {
      if (!exact(response.error, ['code', 'message']) || typeof response.error.code !== 'string' || !response.error.code ||
          typeof response.error.message !== 'string') throw receiverError('PROTOCOL_ERROR', '接收器错误结构无效。');
      this._settle(response.id);
      pending.reject(receiverError(response.error.code, response.error.message));
      return;
    }
    if (!this._validate(pending.method, pending.params, response.result)) throw receiverError('PROTOCOL_ERROR', '接收器结果与绑定或本次请求不符。');
    this._settle(response.id);
    if (pending.method === 'close') this._generation = null;
    pending.resolve(response.result);
  }

  _settle(id) {
    clearTimeout(this._pending.get(id).timer);
    this._pending.delete(id);
  }

  _send(method, params, timeout = TIMEOUT) {
    const id = `${this._instance}:${++this._sequence}`;
    const frame = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = receiverError('REQUEST_TIMEOUT', `接收器 ${method} 请求超时；未确认游标保持原位。`);
        if (this._pending.has(id)) { this._settle(id); reject(error); }
        this._fail(error);
      }, timeout);
      this._pending.set(id, { method, params, resolve, reject, timer });
      try {
        this._child.stdin.write(frame, 'utf8', error => {
          if (error && this._pending.has(id)) this._fail(receiverError('TRANSPORT_ERROR', '无法写入接收器请求。', error));
        });
      } catch (error) { this._fail(receiverError('TRANSPORT_ERROR', '无法写入接收器请求。', error)); }
    });
  }

  _request(method, params) {
    if (this._state !== 'ready') return Promise.reject(this._failure ?? receiverError('RECEIVER_NOT_READY', '请先等待 start()，已关闭实例不可重用。'));
    return this._send(method, params);
  }

  poll() { return this._request('poll', {}); }

  ack(params = {}) {
    const batchId = object(params) ? params.batchId : null;
    if (!exact(params, ['batchId']) || typeof batchId !== 'string' || !BATCH.test(batchId)) return Promise.reject(receiverError('INVALID_BATCH', '需要准确的待确认批次 ID。'));
    return this._request('ack', { batchId });
  }

  members(params = {}) {
    const groupId = object(params) ? params.groupId : null;
    if (!exact(params, ['groupId']) || typeof groupId !== 'string' || !this._targets.has(groupId) || !groupId.endsWith('@chatroom')) {
      return Promise.reject(receiverError('TARGET_NOT_ALLOWED', '只能读取明确登记群的当前成员。'));
    }
    return this._request('members', { groupId });
  }

  _rejectPending(error) {
    for (const [id, pending] of this._pending) { this._settle(id); pending.reject(error); }
  }

  _fail(error) {
    if (['failed', 'closed', 'closing'].includes(this._state)) return;
    this._failure = error;
    this._state = 'failed';
    this._generation = null;
    this._rejectPending(error);
    this._shutdown().catch(() => {});
  }

  _shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    if (!this._child) return Promise.resolve({ closed: true });
    const child = this._child;
    this._shutdownPromise = new Promise((resolve, reject) => {
      let killTimer, finalTimer;
      const finish = error => {
        clearTimeout(killTimer); clearTimeout(finalTimer);
        if (error) reject(error); else resolve({ closed: true });
      };
      this._exited.then(() => finish());
      if (this._didExit) return;
      killTimer = setTimeout(() => {
        finalTimer = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          finish(receiverError('CLOSE_TIMEOUT', '自有接收进程未退出；未终止任何微信或其他进程。'));
        }, CLOSE_TIMEOUT);
        try { child.kill(); } catch (error) { finish(receiverError('CLOSE_TIMEOUT', '无法终止自有接收进程。', error)); }
      }, CLOSE_TIMEOUT);
      try { child.stdin.end(); } catch { child.stdin.destroy(); }
    });
    return this._shutdownPromise;
  }

  close() {
    if (!this._closePromise) this._closePromise = this._close();
    return this._closePromise;
  }

  async _close() {
    const graceful = this._state === 'ready' && this._pending.size === 0 && this._generation;
    this._state = 'closing';
    this._rejectPending(receiverError('RECEIVER_CLOSED', '接收器正在关闭；未确认批次保留。'));
    let responseError;
    if (graceful) {
      try { await this._send('close', {}, CLOSE_TIMEOUT); } catch (error) { responseError = error; }
    }
    this._generation = null;
    try { await this._shutdown(); } finally { this._state = 'closed'; }
    if (responseError) throw responseError;
    return { closed: true };
  }
}

module.exports = { NativeReceiver };
