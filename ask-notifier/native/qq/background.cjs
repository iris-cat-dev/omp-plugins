'use strict';

const MAX_FRAME = 65536;
const PHONE_UID = 'u_Wcc5rknRRqRO8y5gxMD6sA';
const PAD_UID = 'u_l7jpPIZxQo0mzJwoEt-SKw';
const DEVICE_UIDS = Object.freeze({ phone: PHONE_UID, pad: PAD_UID });
const REGISTRY = Symbol.for('omp.qq.ask.background.1');

// QQ 9.9.37-54395: major.node ChatType.kDataline = 8. In wrapper.node,
// NeedFilterDatalineTopInfo compares PHONE_UID at RVA 0x15AA243 and PAD_UID
// at 0x15AA2AA; the matching branches log "filter phone" (0x15AA275) and
// "filter pad" (0x15AA2DC). The existing online-device readback independently
// reports these built-in devUid values for clientType 2 and 9 respectively.
// These account-independent routes do not require nickname/contact lookup.
module.exports = function start(config) {
  try {
    return connect(config);
  } catch {
    // A failed optional bridge must never escape into QQ's application boundary.
    return { started: false, reason: 'backend_start_failed' };
  }
};

function connect(config) {
  const net = require('node:net');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { TextDecoder } = require('node:util');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (!config || !Number.isSafeInteger(config.hostPid) || config.hostPid < 1 ||
      typeof config.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(config.nonce) ||
      config.pipeName !== `\\\\.\\pipe\\OMP.QQ.Ask.${config.hostPid}.${config.nonce}`) {
    return { started: false, reason: 'invalid_bootstrap_config' };
  }
  // This function closes over this generation's original Windows host HANDLE.
  // Never replace it with a PID lookup or a later global generation's callback.
  const hostAlive = config.hostAlive;
  const hostIsAlive = () => {
    try { return typeof hostAlive === 'function' && hostAlive() === true; }
    catch { return false; }
  };

  let registry = globalThis[REGISTRY];
  if (!registry) {
    registry = { active: null, requests: new Map() };
    Object.defineProperty(globalThis, REGISTRY, { value: registry });
  }
  // Cut over atomically on the JS thread. Retain all request outcomes, including
  // unknown outcomes from the sealed connection, for QQ's entire process life.
  if (registry.active) registry.active.seal('connection_superseded');
  const socket = new net.Socket();
  const connection = {
    sealed: false, connected: false, exiting: false, boundAccountId: null, submissionUncertain: false,
    seal(reason) {
      if (connection.sealed) return;
      connection.sealed = true;
      connection.connected = false;
      pending = Buffer.alloc(0);
      for (const entry of registry.requests.values()) {
        if (entry.owner === connection && !entry.settled) {
          settle(entry, entry.entered ? 'unknown' : 'failed', reason);
        }
      }
      if (registry.active === connection) registry.active = null;
      socket.destroy();
    },
  };
  registry.active = connection;
  let pending = Buffer.alloc(0);
  const wireIds = new Set();
  const packageEntry = Object.entries(require.cache).find(([filename]) =>
    /[\\/]resources[\\/]app[\\/]package\.json$/i.test(filename));
  const version = typeof packageEntry?.[1].exports.version === 'string' ? packageEntry[1].exports.version : null;
  let wrapper = null;
  let login = null;
  let initializationReason = null;
  if (process.type !== 'browser') initializationReason = 'qq_main_process_required';
  else if (!packageEntry) initializationReason = 'qq_package_unavailable';
  else if (typeof hostAlive !== 'function') initializationReason = 'native_host_guard_missing';
  else {
    try {
      // Load bindings into QQ itself, never into the OMP/Node host. The existing
      // image is already loaded by QQ. No engine/session creation or login occurs.
      wrapper = process.mainModule.require(path.join(path.dirname(packageEntry[0]), 'wrapper.node'));
      if (typeof wrapper.NodeIKernelLoginService?.get !== 'function' ||
          typeof wrapper.NodeIQQNTWrapperSession?.getNTWrapperSession !== 'function') {
        initializationReason = 'native_bindings_unavailable';
      } else {
        login = wrapper.NodeIKernelLoginService.get();
        if (!login || typeof login.getLoginList !== 'function' || typeof login.getMsfStatus !== 'function') {
          initializationReason = 'native_login_interface_unavailable';
        }
      }
    } catch {
      initializationReason = 'native_bindings_unavailable';
    }
  }

  function transportIsOpen() {
    return registry.active === connection && !connection.sealed && connection.connected &&
      !socket.destroyed && !socket.readableEnded && !socket.writableEnded;
  }

  function live() {
    return transportIsOpen() && hostIsAlive();
  }

  function result(state, reason, accountId = null) {
    return { state, reason, accountId };
  }

  function timeout(promise, milliseconds) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native_timeout')), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }

  function accountDirectory(session, uin) {
    // Current-version readback: getAccountPath(1) is synchronous and ends in
    // <selfUin>/nt_qq/nt_db. Validate the account-bearing tail, not an arbitrary
    // occurrence of the UIN elsewhere in the user's chosen data-root path.
    const directory = session.getAccountPath(1);
    if (typeof directory !== 'string' || !directory) return null;
    const parts = directory.split(/[\\/]/).filter(Boolean);
    const tail = parts.slice(-3);
    if (tail.length !== 3 || tail[0] !== uin || tail[1].toLowerCase() !== 'nt_qq' || tail[2].toLowerCase() !== 'nt_db') return null;
    return path.win32.normalize(directory).replace(/[\\/]+$/, '').toLowerCase();
  }

  function bindingIsCurrent(current) {
    return accountDirectory(current.session, current.uin) === current.directory;
  }

  async function identity() {
    if (initializationReason) return result('unsupported', initializationReason);
    const response = await timeout(Promise.resolve(login.getLoginList()), 3000);
    if (!response || response.result !== 0 || !Array.isArray(response.LocalLoginInfoList) ||
        response.LocalLoginInfoList.some((entry) => !entry || typeof entry.isUserLogin !== 'boolean')) {
      return result('unsupported', 'native_login_state_invalid');
    }
    // getLoginList also contains saved accounts. Only isUserLogin denotes a
    // currently signed-in identity; saved/automatic-login flags are not evidence.
    const active = new Map();
    for (const entry of response.LocalLoginInfoList) {
      if (!entry.isUserLogin) continue;
      if (typeof entry.uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(entry.uid) ||
          typeof entry.uin !== 'string' || !/^[1-9][0-9]*$/.test(entry.uin)) {
        return result('unsupported', 'native_account_identity_invalid');
      }
      if (active.has(entry.uid) && active.get(entry.uid) !== entry.uin) {
        return result('unsupported', 'native_account_identity_inconsistent');
      }
      active.set(entry.uid, entry.uin);
    }
    if (active.size === 0) return result('not_logged_in', 'qq_not_logged_in');
    if (active.size !== 1) return result('multiple_accounts', 'multiple_logged_in_accounts');
    const accountId = active.keys().next().value;
    if (login.getMsfStatus() !== 1) return result('not_logged_in', 'qq_connection_not_ready', accountId);
    // Local-version disassembly: this accessor contains registry.contains(id)
    // and weak_ptr.lock only. A missing ID returns null; it never creates a session.
    const session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    if (!session) return result('unsupported', 'existing_native_session_unavailable', accountId);
    if (typeof session.getAccountPath !== 'function' || typeof session.getMsgService !== 'function') {
      return result('unsupported', 'native_session_interface_unavailable', accountId);
    }
    const uin = active.get(accountId);
    const directory = accountDirectory(session, uin);
    if (!directory) return result('unsupported', 'native_session_account_binding_unproven', accountId);
    const service = session.getMsgService();
    if (!service || typeof service.sendMsg !== 'function') {
      return result('unsupported', 'native_message_service_unavailable', accountId);
    }
    return { ...result('ready', null, accountId), session, service, uin, directory };
  }

  async function inspect() {
    try {
      if (initializationReason) return { ...result('unsupported', initializationReason), version };
      if (!live()) return { ...result('error', 'connection_sealed'), version };
      const current = await identity();
      if (!live()) return { ...result('error', 'connection_sealed'), version };
      if (current.state === 'ready') {
        if (!bindingIsCurrent(current)) return { ...result('unsupported', 'native_session_account_changed', current.accountId), version };
        if (connection.boundAccountId && connection.boundAccountId !== current.accountId) {
          return { ...result('unsupported', 'connection_account_changed', current.accountId), version };
        }
        connection.boundAccountId = current.accountId;
      }
      return { ...result(current.state, current.reason, current.accountId), version };
    } catch {
      return { ...result('error', 'native_inspection_failed'), version };
    }
  }

  function settle(entry, state, reason) {
    if (entry.settled) return;
    entry.settled = true;
    entry.result = result(state, reason, entry.accountId);
    if (state === 'unknown') entry.owner.submissionUncertain = true;
    entry.resolve(entry.result);
  }

  function send(params) {
    const digest = createHash('sha256').update(params.text, 'utf8').digest('hex');
    const prior = registry.requests.get(params.requestId);
    if (prior) {
      // Registry entries retained from the phone-only bridge bind to phone.
      const target = Object.prototype.hasOwnProperty.call(prior, 'target') ? prior.target : 'phone';
      if (prior.accountId !== params.accountId || prior.digest !== digest || target !== params.target) {
        return Promise.resolve(result('failed', 'request_id_identity_mismatch', params.accountId));
      }
      return prior.promise;
    }
    const entry = {
      owner: connection, accountId: params.accountId, target: params.target, digest, entered: false, settled: false,
      result: null, resolve: null, promise: null,
    };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    registry.requests.set(params.requestId, entry);
    void (async () => {
      try {
        if (!live() || connection.exiting) return settle(entry, 'failed', 'connection_sealed');
        if (connection.submissionUncertain) return settle(entry, 'failed', 'native_submission_unresolved');
        if (!connection.boundAccountId || connection.boundAccountId !== params.accountId) {
          return settle(entry, 'failed', 'inspected_account_required');
        }
        const current = await identity();
        if (entry.settled) return;
        if (!live() || connection.exiting) return settle(entry, 'failed', 'connection_sealed');
        if (current.state !== 'ready') return settle(entry, current.state === 'error' ? 'unsupported' : current.state, current.reason);
        if (current.accountId !== params.accountId || current.accountId !== connection.boundAccountId) {
          return settle(entry, 'failed', 'account_changed_before_submission');
        }
        const elements = [{
          elementType: 1, elementId: '',
          textElement: { content: params.text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' },
        }];
        const peer = { chatType: 8, peerUid: DEVICE_UIDS[params.target], guildId: '' };
        // Both device routes use the desktop composer's normal attribute record.
        // Keep neutral styling; account-specific decoration IDs are not routing data.
        const attributes = new Map([[0, {
          attrType: 0,
          attrId: '0',
          vasMsgInfo: {
            avatarPendantInfo: { avatarId: 0, pendantId: '0', pendantDiyInfoId: 0 },
            iceBreakInfo: {},
            msgNamePlateInfo: { carouselNamePlateIds: [] },
            vasFont: { fontId: 0, diyFontCfgUpdateTime: 0, magicFontType: 0 },
            bubbleInfo: { bubbleId: 0 },
          },
        }]]);
        if (!bindingIsCurrent(current)) return settle(entry, 'failed', 'session_account_changed_before_submission');
        // No await, callback, or queued work may separate the final generation /
        // original-host-HANDLE check from entry into the irreversible native API.
        if (!live() || connection.exiting || entry.settled) return settle(entry, 'failed', 'connection_sealed');
        if (connection.submissionUncertain) return settle(entry, 'failed', 'native_submission_unresolved');
        entry.entered = true;
        const reply = await timeout(Promise.resolve(current.service.sendMsg('0', peer, elements, attributes)), 5000);
        if (entry.settled) return;
        if (!live()) return settle(entry, 'unknown', 'connection_lost_after_submission');
        if (!reply || typeof reply.result !== 'number' || !Number.isFinite(reply.result)) {
          return settle(entry, 'unknown', 'native_submission_reply_invalid');
        }
        // This confirms API submission only, never mobile-device delivery.
        settle(entry, reply.result === 0 ? 'submitted' : 'failed', reply.result === 0 ? null : 'native_submission_rejected');
      } catch {
        settle(entry, entry.entered ? 'unknown' : 'failed', entry.entered ? 'native_submission_outcome_unknown' : 'native_preflight_failed');
      }
    })();
    return entry.promise;
  }

  function unresolvedSubmission() {
    for (const entry of registry.requests.values()) {
      if ((entry.entered && !entry.settled) || entry.result?.state === 'unknown') return true;
    }
    return false;
  }

  function writeResponse(response, callback) {
    if (connection.sealed || socket.destroyed || socket.writableEnded) return;
    const frame = JSON.stringify(response) + '\n';
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME) return connection.seal('response_too_large');
    socket.write(frame, callback);
  }

  async function exit(id) {
    if (!live() || !connection.boundAccountId || unresolvedSubmission() || connection.exiting) {
      return writeResponse({ id, error: { message: 'exit_not_safe' } });
    }
    connection.exiting = true;
    try {
      const current = await identity();
      if (!live() || current.state !== 'ready' || current.accountId !== connection.boundAccountId || unresolvedSubmission()) {
        connection.exiting = false;
        return writeResponse({ id, error: { message: 'exit_account_or_submission_changed' } });
      }
      writeResponse({ id, result: { accepted: true } }, () => {
        void (async () => {
          // Writing the acknowledgement is asynchronous. Recheck identity again
          // after it flushes; account replacement must never inherit exit authority.
          const latest = await identity();
          if (latest.state !== 'ready' || latest.accountId !== connection.boundAccountId || unresolvedSubmission()) return;
          if (!bindingIsCurrent(latest)) return;
          const app = require('electron').app;
          if (!live()) return;
          app.quit();
        })().catch(() => {}).finally(() => { connection.exiting = false; });
      });
    } catch {
      connection.exiting = false;
      writeResponse({ id, error: { message: 'exit_preflight_failed' } });
    }
  }

  function keysAre(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function validSend(params) {
    return keysAre(params, ['requestId', 'target', 'text', 'accountId']) &&
      typeof params.requestId === 'string' && /^(?!0{32}$)[0-9a-f]{32}$/.test(params.requestId) &&
      typeof params.target === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_UIDS, params.target) &&
      typeof params.accountId === 'string' && /^u_[A-Za-z0-9_-]+$/.test(params.accountId) &&
      typeof params.text === 'string' && !params.text.includes('\0') && params.text.isWellFormed() &&
      Buffer.byteLength(params.text, 'utf8') >= 1 && Buffer.byteLength(params.text, 'utf8') <= 4094;
  }

  function dispatch(request) {
    if (!transportIsOpen() || (connection.exiting && request.method !== 'close')) return;
    if (!keysAre(request, ['id', 'method', 'params']) || typeof request.method !== 'string' ||
        (request.method === 'send' ? !validSend(request.params) : !keysAre(request.params, [])) ||
        !['inspect', 'send', 'exit', 'close'].includes(request.method)) {
      return writeResponse({ id: request.id, error: { message: 'invalid_request' } });
    }
    if (request.method === 'close') {
      // Seal pending operations before EOF is generated, but flush the close ack.
      connection.sealed = true;
      connection.connected = false;
      pending = Buffer.alloc(0);
      for (const entry of registry.requests.values()) {
        if (entry.owner === connection && !entry.settled) settle(entry, entry.entered ? 'unknown' : 'failed', 'connection_closed');
      }
      if (registry.active === connection) registry.active = null;
      socket.end(JSON.stringify({ id: request.id, result: { closed: true } }) + '\n');
      return;
    }
    if (request.method === 'exit') return void exit(request.id).catch(() => connection.seal('exit_request_failed'));
    const operation = request.method === 'inspect' ? inspect() : send(request.params);
    Promise.resolve(operation).then((value) => writeResponse({ id: request.id, result: value }),
      () => writeResponse({ id: request.id, error: { message: 'native_request_failed' } }))
      .catch(() => connection.seal('response_write_failed'));
  }

  socket.on('connect', () => { connection.connected = true; });
  socket.on('error', () => connection.seal('pipe_error'));
  socket.on('end', () => connection.seal('pipe_eof'));
  socket.on('close', () => connection.seal('pipe_closed'));
  socket.on('data', (chunk) => {
    if (connection.sealed) return;
    try {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let newline;
      const requests = [];
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline + 1 > MAX_FRAME) return connection.seal('request_too_large');
        const request = JSON.parse(decoder.decode(pending.subarray(0, newline)));
        pending = pending.subarray(newline + 1);
        if (!request || !Number.isSafeInteger(request.id) || wireIds.has(request.id)) return connection.seal('invalid_request_id');
        wireIds.add(request.id);
        requests.push(request);
      }
      if (pending.length >= MAX_FRAME) return connection.seal('request_too_large');
      // Recognize close immediately, including behind a send in the same batch.
      const close = requests.find((request) => request.method === 'close' && keysAre(request, ['id', 'method', 'params']) && keysAre(request.params, []));
      if (close) return dispatch(close);
      for (const request of requests) setImmediate(() => {
        try { dispatch(request); } catch { connection.seal('request_dispatch_failed'); }
      });
    } catch {
      connection.seal('invalid_json_frame');
    }
  });
  socket.connect(config.pipeName);
  return { started: true };
}
