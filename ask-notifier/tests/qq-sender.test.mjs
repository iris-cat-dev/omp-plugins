import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createQQSender } from '../src/qq-sender.mjs';

const windows = process.platform === 'win32' && process.arch === 'x64';
const key = '1234567890abcdef1234567890abcdef';
const ready = { state: 'ready', reason: null, accountId: 'qq-desktop:42:1000', version: '9.9.37-54395' };
const offline = { state: 'not_logged_in', reason: 'offline fixture', accountId: null, version: null };

async function fixture(t, operation, options = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'omp-qq-offline-'));
  mkdirSync(path.join(folder, 'bridge'));
  writeFileSync(path.join(folder, 'bridge/qq_worker.py'), '# Offline protocol peer only. Never executed.\n');
  writeFileSync(path.join(folder, 'python.exe'), 'offline placeholder');
  const previous = process.env.OMP_QQ_NOTIFIER_PYTHON;
  process.env.OMP_QQ_NOTIFIER_PYTHON = path.join(folder, 'python.exe');
  const events = [];
  const launches = [];
  const children = [];
  const saved = new Map();
  let connection = options.connection || ready;
  let sendState = options.unknown ? 'unknown' : 'submitted';
  let sender;
  const spawn = t.mock.method(childProcess, 'spawn', (executable, args, settings) => {
    const child = new EventEmitter();
    child.pid = args.includes('--state-dir') ? 1000 + children.length : 42;
    child.kind = args.includes('--state-dir') ? 'bridge' : 'qq';
    child.kills = 0;
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    child.kill = () => { child.kills += 1; child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
    children.push(child);
    if (!args.includes('--state-dir')) {
      launches.push({ executable, args, settings, child });
      options.onLaunch?.();
      if (options.autoLogin) connection = ready;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(buffer, _, done) {
      const request = JSON.parse(String(buffer));
      events.push(request);
      let result;
      if (request.method === 'inspect') result = { ...connection };
      else if (request.method === 'installation') result = { executable: path.join(folder, 'QQ.exe'), reason: null };
      else if (request.method === 'beginLaunch') result = { mayLaunch: options.mayLaunch !== false };
      else if (request.method === 'claimLaunch') result = { owned: options.claimOwned !== false };
      else if (request.method === 'finishBatch') {
        result = options.exitError
          ? { ...offline, state: 'error', reason: 'normal exit was not confirmed' }
          : { ...offline, reason: 'temporary QQ and descendants exited normally' };
        if (!options.exitError) {
          connection = offline;
          const qq = launches.at(-1)?.child;
          if (qq) { qq.exitCode = 0; queueMicrotask(() => qq.emit('close', 0)); }
        }
      }
      else if (request.method === 'query') {
        const prior = saved.get(request.params.requestId);
        if (prior && (prior.params.target !== request.params.target || prior.params.text !== request.params.text)) {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: 'invalid_request', message: 'requestId identity mismatch' } })}\n`));
          done();
          return;
        }
        result = prior ? { found: true, ...prior.result } : { found: false };
      }
      else if (request.method === 'send') {
        result = { state: sendState, reason: sendState === 'submitted' ? null : 'offline failure boundary', accountId: ready.accountId };
        saved.set(request.params.requestId, { params: { ...request.params }, result });
        if (options.loseSendReply) {
          queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1); });
          done();
          return;
        }
      } else if (request.method === 'close') result = { closed: true };
      else throw new Error('unexpected offline method');
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      done();
    } });
    return child;
  });
  syncBuiltinESMExports();
  const make = (signal) => createQQSender({ packageRoot: folder, dataDirectory: path.join(folder, 'data'), signal });
  try {
    sender = make();
    await operation({ sender, make, events, launches, children, setConnection: (value) => { connection = value; },
      setSendState: (value) => { sendState = value; }, folder });
  } finally {
    await sender?.close();
    spawn.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.OMP_QQ_NOTIFIER_PYTHON;
    else process.env.OMP_QQ_NOTIFIER_PYTHON = previous;
    rmSync(folder, { recursive: true, force: true });
  }
}

test('QQ rejects invalid input and arbitrary targets without starting any worker', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'omp-qq-invalid-'));
  const sender = createQQSender({ packageRoot: folder, dataDirectory: path.join(folder, 'data') });
  try {
    for (const params of [
      { requestId: '0'.repeat(32), target: 'phone', text: '提醒' },
      { requestId: key.toUpperCase(), target: 'phone', text: '提醒' },
      { requestId: key, target: 'phone', text: 'x\0y' },
      { requestId: key, target: 'phone', text: '\ud800' },
      { requestId: key, target: 'phone', text: '中'.repeat(1365) },
      { requestId: key, text: '提醒', target: '我的手机' },
      { requestId: key, text: '提醒' },
      { requestId: key, target: 'both', text: '提醒' },
      { requestId: key, target: 'u_arbitrary_contact', text: '提醒' },
      { requestId: key, target: 'pad', text: '提醒', peerUid: 'u_arbitrary_contact' },
    ]) assert.equal((await sender.send(params)).state, 'failed');
    assert.equal(existsSync(path.join(folder, 'data')), false);
  } finally { await sender.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('QQ inspect never starts QQ or sends and same submitted ID is never resent', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, launches }) => {
    assert.deepEqual(await sender.inspect(), ready);
    assert.equal(launches.length, 0);
    const params = { requestId: key, target: 'phone', text: '问题与选项' };
    assert.equal((await sender.send(params)).state, 'submitted');
    assert.equal((await sender.send(params)).state, 'submitted');
    assert.equal(events.filter((event) => event.method === 'send').length, 1);
    assert.equal(launches.length, 0);
  });
});

test('QQ auto-login spawns only one official discovered entry even across canceled waits', { skip: !windows }, async (t) => {
  let cancel;
  await fixture(t, async ({ sender, launches, setConnection }) => {
    const signal = new AbortController();
    cancel = () => signal.abort();
    assert.equal((await sender.ensureLoggedIn({ signal: signal.signal })).state, 'not_logged_in');
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].args, []);
    assert.equal(launches[0].settings.shell, false);
    setConnection(ready);
    assert.equal((await sender.ensureLoggedIn()).state, 'ready');
    assert.equal(launches.length, 1);
  }, { connection: offline, onLaunch: () => cancel() });
});

test('QQ canceled auto-login and uncertain inspection never launch QQ', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, launches, setConnection }) => {
    const cancel = new AbortController();
    cancel.abort();
    assert.equal((await sender.ensureLoggedIn({ signal: cancel.signal })).state, 'not_logged_in');
    assert.equal((await sender.ensureLoggedIn({ mayContinue: () => false })).state, 'not_logged_in');
    setConnection({ ...offline, state: 'unsupported', reason: 'background UIA unavailable' });
    assert.equal((await sender.ensureLoggedIn()).state, 'unsupported');
    assert.equal(launches.length, 0);
  }, { connection: offline });
});

test('QQ unknown request is fenced and close does not kill detached QQ', { skip: !windows }, async (t) => {
  let cancel;
  await fixture(t, async ({ sender, events, launches, setConnection }) => {
    const abort = new AbortController();
    cancel = () => abort.abort();
    await sender.ensureLoggedIn({ signal: abort.signal });
    setConnection(ready);
    const params = { requestId: key, target: 'phone', text: '未决提醒' };
    assert.equal((await sender.send(params)).state, 'unknown');
    assert.equal((await sender.send(params)).state, 'unknown');
    assert.equal(events.filter((event) => event.method === 'send').length, 1);
    await sender.close();
    assert.equal(launches[0].child.exitCode, null);
  }, { connection: offline, unknown: true, onLaunch: () => cancel() });
});

test('QQ can auto-open again for a later question after the previous QQ process exits', { skip: !windows }, async (t) => {
  let cancel = () => {};
  await fixture(t, async ({ sender, launches }) => {
    const first = new AbortController();
    cancel = () => first.abort();
    await sender.ensureLoggedIn({ signal: first.signal });
    assert.equal(launches.length, 1);
    launches[0].child.exitCode = 0;
    launches[0].child.emit('close', 0);
    const next = new AbortController();
    cancel = () => next.abort();
    const abortFallback = setImmediate(() => next.abort());
    try {
      await sender.ensureLoggedIn({ signal: next.signal });
    } finally { clearImmediate(abortFallback); }
    assert.equal(launches.length, 2);
    assert.equal(launches[1].child.exitCode, null);
  }, { connection: offline, onLaunch: () => cancel() });
});

test('QQ leaves an existing logged-in or already-open client unowned', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, launches }) => {
    assert.equal((await sender.ensureLoggedIn()).state, 'ready');
    assert.equal((await sender.send({ requestId: key, target: 'phone', text: '已有客户端' })).state, 'submitted');
    assert.equal(await sender.finishBatch(), null);
    assert.equal(launches.length, 0);
    assert.equal(events.some((item) => item.method === 'finishBatch'), false);
  });
});

test('QQ existing login process and launcher handoff never acquire exit ownership', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, launches, setConnection }) => {
    let permit = true;
    const waiting = sender.ensureLoggedIn({ mayContinue: () => permit });
    while (!events.some((item) => item.method === 'beginLaunch')) await new Promise(setImmediate);
    permit = false;
    assert.equal((await waiting).state, 'not_logged_in');
    assert.equal(launches.length, 0);
    setConnection(ready);
    await sender.send({ requestId: key, target: 'phone', text: '用户原先打开的QQ' });
    assert.equal(await sender.finishBatch(), null);
  }, { connection: offline, mayLaunch: false });
  await fixture(t, async ({ sender, events }) => {
    assert.equal((await sender.ensureLoggedIn()).state, 'ready');
    await sender.send({ requestId: key, target: 'phone', text: '启动器交接' });
    assert.equal(await sender.finishBatch(), null);
    assert.equal(events.some((item) => item.method === 'finishBatch'), false);
  }, { connection: offline, autoLogin: true, claimOwned: false });
});

test('QQ batch exit waits for submission and permission, releases its bridge and can auto-start next time', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, children, launches }) => {
    assert.equal((await sender.ensureLoggedIn()).state, 'ready');
    assert.equal(await sender.finishBatch(), null);
    assert.equal((await sender.send({ requestId: key, target: 'phone', text: '完整批次' })).state, 'submitted');
    assert.equal(await sender.finishBatch({ mayClose: () => false }), null);
    assert.equal(events.some((item) => item.method === 'finishBatch'), false);
    const result = await sender.finishBatch({ mayClose: () => true });
    assert.equal(result.state, 'not_logged_in');
    assert.equal(children.filter((child) => child.kind === 'bridge' && child.exitCode !== null).length, 1);
    assert.equal(launches[0].child.kills, 0);
    assert.equal((await sender.ensureLoggedIn()).state, 'ready');
    assert.equal(launches.length, 2);
    assert.equal(children.filter((child) => child.kind === 'bridge').length, 2);
    assert.equal((await sender.send({ requestId: 'abcdef1234567890abcdef1234567890', target: 'phone', text: '下次批次' })).state, 'submitted');
    assert.equal((await sender.finishBatch()).state, 'not_logged_in');
    assert.equal(events.filter((item) => item.method === 'finishBatch').length, 2);
    assert.deepEqual(events.filter((item) => item.method === 'finishBatch').map((item) => item.params), [{}, {}]);
  }, { connection: offline, autoLogin: true });
});

test('QQ any failed or unknown segment keeps temporary QQ open even after a later success', { skip: !windows }, async (t) => {
  for (const state of ['failed', 'unknown', 'not_logged_in', 'unsupported', 'multiple_accounts']) {
    await fixture(t, async ({ sender, events, launches, setSendState }) => {
      await sender.ensureLoggedIn();
      await sender.send({ requestId: key, target: 'phone', text: '第一段成功' });
      setSendState(state);
      assert.equal((await sender.send({ requestId: 'abcdef1234567890abcdef1234567890', target: 'pad', text: '第二端失败' })).state, state);
      setSendState('submitted');
      await sender.send({ requestId: '11111111111111111111111111111111', target: 'phone', text: '后续成功' });
      assert.equal(await sender.finishBatch(), null);
      assert.equal(events.some((item) => item.method === 'finishBatch'), false);
      await sender.close();
      assert.equal(launches[0].child.exitCode, null);
      assert.equal(launches[0].child.kills, 0);
    }, { connection: offline, autoLogin: true });
  }
});

test('QQ exit errors preserve submitted records and are not retried or forced', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, launches }) => {
    await sender.ensureLoggedIn();
    await sender.send({ requestId: key, target: 'phone', text: '已提交但退出失败' });
    assert.equal((await sender.finishBatch()).state, 'error');
    assert.equal((await sender.send({ requestId: key, target: 'phone', text: '已提交但退出失败' })).state, 'submitted');
    assert.equal(await sender.finishBatch(), null);
    assert.equal(events.filter((item) => item.method === 'finishBatch').length, 1);
    assert.equal(events.filter((item) => item.method === 'send').length, 1);
    await sender.close();
    assert.equal(launches[0].child.kills, 0);
    assert.equal(launches[0].child.exitCode, null);
  }, { connection: offline, autoLogin: true, exitError: true });
});

test('QQ closing the plugin never exits even an owned successfully-used client', { skip: !windows }, async (t) => {
  await fixture(t, async ({ sender, events, launches }) => {
    await sender.ensureLoggedIn();
    await sender.send({ requestId: key, target: 'phone', text: '插件关闭' });
    await sender.close();
    assert.equal(await sender.finishBatch(), null);
    assert.equal(events.some((item) => item.method === 'finishBatch'), false);
    assert.equal(launches[0].child.kills, 0);
    assert.equal(launches[0].child.exitCode, null);
  }, { connection: offline, autoLogin: true });
});

test('QQ version metadata does not override a verified ready account', { skip: !windows }, async t => {
  for (const version of ['10.0.0-beta', null]) {
    await t.test(version ?? 'no version metadata', async t => {
      await fixture(t, async ({ sender }) => {
        assert.equal((await sender.inspect()).state, 'ready');
        assert.equal((await sender.send({ requestId: key, target: 'phone', text: '按实际接口判断兼容' })).state, 'submitted');
      }, { connection: { ...ready, version } });
    });
  }
});

test('QQ phone and pad carry distinct IDs and exact target/text identity into both worker methods', { skip: !windows }, async t => {
  await fixture(t, async ({ sender, events }) => {
    const phone = { requestId: key, target: 'phone', text: '同一问题' };
    const pad = { requestId: 'abcdef1234567890abcdef1234567890', target: 'pad', text: phone.text };
    assert.equal((await sender.send(phone)).state, 'submitted');
    assert.equal((await sender.send(pad)).state, 'submitted');
    assert.equal((await sender.send(pad)).state, 'submitted');
    assert.deepEqual(events.filter(event => event.method === 'send').map(event => event.params), [phone, pad]);
    assert.deepEqual(events.filter(event => event.method === 'query').map(event => event.params), [phone, pad, pad]);
    assert.equal((await sender.send({ ...phone, target: 'pad' })).state, 'failed');
    assert.equal((await sender.send({ ...pad, text: '另一问题' })).state, 'failed');
    assert.equal(events.filter(event => event.method === 'send').length, 2);
  });
});

test('QQ uncertain cache keeps target/text binding and seals both destinations in the current sender', { skip: !windows }, async t => {
  await fixture(t, async ({ sender, events, setSendState }) => {
    const params = { requestId: key, target: 'pad', text: 'Pad未决问题' };
    assert.equal((await sender.send(params)).state, 'unknown');
    assert.equal((await sender.send({ ...params, target: 'phone' })).state, 'failed');
    assert.equal((await sender.send({ ...params, text: '被替换的内容' })).state, 'failed');
    assert.equal((await sender.send(params)).state, 'unknown');
    setSendState('submitted');
    assert.equal((await sender.send({ ...params, requestId: 'abcdef1234567890abcdef1234567890', target: 'phone' })).state, 'failed');
    assert.equal(events.filter(event => event.method === 'send').length, 1);
  }, { unknown: true });
});

test('QQ losing the worker reply never replays or redirects that request', { skip: !windows }, async t => {
  await fixture(t, async ({ sender, events }) => {
    const params = { requestId: key, target: 'pad', text: '回包丢失' };
    assert.equal((await sender.send(params)).state, 'unknown');
    assert.equal((await sender.send(params)).state, 'unknown');
    assert.equal((await sender.send({ ...params, target: 'phone' })).state, 'failed');
    assert.equal((await sender.send({ ...params, requestId: 'abcdef1234567890abcdef1234567890', target: 'phone' })).state, 'failed');
    assert.equal(events.filter(event => event.method === 'send').length, 1);
  }, { loseSendReply: true });
});

test('QQ restarted sender can submit a new question while old unknown and target bindings remain durable', { skip: !windows }, async t => {
  await fixture(t, async ({ sender, make, events, setSendState }) => {
    const original = { requestId: key, target: 'phone', text: '旧未决问题' };
    assert.equal((await sender.send(original)).state, 'unknown');
    await sender.close();
    const restarted = make();
    try {
      assert.equal((await restarted.send(original)).state, 'unknown');
      assert.equal((await restarted.send({ ...original, target: 'pad' })).state, 'failed');
      setSendState('submitted');
      assert.equal((await restarted.send({ requestId: 'abcdef1234567890abcdef1234567890', target: 'pad', text: '重启后的新问题' })).state, 'submitted');
      assert.equal(events.filter(event => event.method === 'send').length, 2);
    } finally { await restarted.close(); }
  }, { unknown: true });
});

test('QQ persisted ID collision fails without native submission or sealing unrelated new questions', { skip: !windows }, async t => {
  await fixture(t, async ({ sender, make, events }) => {
    const params = { requestId: key, target: 'phone', text: '已绑定内容' };
    await sender.send(params);
    await sender.close();
    const restarted = make();
    try {
      assert.equal((await restarted.send({ ...params, target: 'pad' })).state, 'failed');
      assert.equal(events.filter(event => event.method === 'send').length, 1);
      assert.equal(await restarted.finishBatch(), null);
      assert.equal((await restarted.send({ requestId: 'abcdef1234567890abcdef1234567890', target: 'pad', text: '合法的新问题' })).state, 'submitted');
      assert.equal(events.filter(event => event.method === 'send').length, 2);
    } finally { await restarted.close(); }
  });
});
