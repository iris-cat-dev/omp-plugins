'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// A real child process is the fault boundary. It deliberately fragments bytes,
// exits, persists a submission before losing its reply, and replies after EOF.
// Only process selection is redirected in the tests; no stream is mocked.
function runFaultWorker(mode, home) {
  const readline = require('node:readline');
  if (mode === 'stubborn') setInterval(() => {}, 60_000);
  const ledger = path.join(home, 'submission.json');
  const record = () => fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : null;
  const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
  const fragmented = (id, result) => {
    const bytes = Buffer.from(JSON.stringify({ id, result }) + '\n');
    let offset = 0;
    const next = () => {
      if (offset === bytes.length) return;
      process.stdout.write(bytes.subarray(offset, ++offset));
      setImmediate(next);
    };
    next();
  };
  let delayed;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(path.join(home, 'requests.ndjson'), line + '\n');
    if (request.method === 'status') {
      const result = { nativeAllowed: false, connected: false, unknownCount: record() ? 1 : 0, preparedImages: 0 };
      if (mode === 'bad-start') result.connected = 'false';
      if (mode === 'slow-start') setTimeout(() => respond(request.id, result), 80);
      else if (mode === 'fragments') fragmented(request.id, result);
      else respond(request.id, result);
      return;
    }
    if (request.method === 'close') { respond(request.id, { closed: true }); lines.close(); process.stdin.destroy(); return; }
    if (request.method === 'submission') { respond(request.id, record() ?? { found: false }); return; }
    if (request.method === 'submit_text' || request.method === 'submit_image') {
      const saved = { found: true, requestId: request.params.requestId, status: 'unknown', reviewed: false, targetId: request.params.targetId, kind: request.method === 'submit_text' ? 'text' : 'image' };
      const fd = fs.openSync(ledger, 'w');
      fs.writeFileSync(fd, JSON.stringify(saved));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      process.stderr.write('submission-persisted\n');
      if (mode === 'exit-submit') { process.exit(23); return; }
      if (mode === 'late-submit') { delayed = request; return; }
      if (mode === 'hold') return;
      if (mode === 'incomplete-submit') { respond(request.id, { requestId: saved.requestId, status: 'submitted' }); return; }
      if (mode === 'structured-error') {
        process.stdout.write(JSON.stringify({ id: request.id, error: { code: 'conflict', message: 'same key, different content', outcome: 'unknown', requestId: saved.requestId } }) + '\n');
        return;
      }
      respond(request.id, { requestId: saved.requestId, status: 'unknown', reviewed: false });
      return;
    }
    if (mode === 'wrong-id') { respond('another-process:1', {}); return; }
    if (mode === 'duplicate-key') { process.stdout.write(`{"id":${JSON.stringify(request.id)},"id":${JSON.stringify(request.id)},"result":{}}\n`); return; }
    if (mode === 'overflow') { process.stdout.write(`{"id":${JSON.stringify(request.id)},"result":{"value":1e999}}\n`); return; }
    if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); return; }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\n'); return; }
    if (mode === 'partial-eof') { process.stdout.write('{"id":', () => process.exit(0)); return; }
    if (mode === 'empty-eof') { process.stdout.end(); process.stdin.destroy(); return; }
    if (mode === 'hold') { process.stderr.write('request-held\n'); return; }
    const bytes = fs.readFileSync(path.join(home, 'input.txt'));
    const result = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, text: bytes.toString('utf8') };
    setTimeout(() => {
      if (mode === 'fragments') fragmented(request.id, result);
      else respond(request.id, result);
    }, request.params.delay ?? 0);
  });
  lines.on('close', () => {
    if (delayed) {
      setTimeout(() => {
        fs.writeFileSync(path.join(home, 'late-response-written'), delayed.id);
        respond(delayed.id, { requestId: delayed.params.requestId, status: 'submitted', reviewed: false });
      }, 80);
    }
  });
}

if (process.argv[2] === '--native-fixture') {
  runFaultWorker(process.argv[3], process.argv[4]);
} else {
  const assert = require('node:assert/strict');
  const childProcess = require('node:child_process');
  const { once } = require('node:events');
  const { tmpdir } = require('node:os');
  const test = require('node:test');
  const { NativeBridge } = require('../src/native-bridge.cjs');

  function fixture(t, mode) {
    const home = fs.mkdtempSync(path.join(tmpdir(), 'omp-native-client-test-'));
    fs.writeFileSync(path.join(home, 'input.txt'), '真实分片内容 中文🙂');
    const config = { pythonPath: process.execPath, accountId: 'wxid_offline_test', stateDir: path.join(home, 'state'), mediaRoot: path.join(home, 'media'), engineDir: path.join(home, 'engine') };
    for (const directory of [config.stateDir, config.mediaRoot, config.engineDir]) fs.mkdirSync(directory);
    const spawned = [];
    const bridges = [];
    const originalSpawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (executable, args, options) => {
      assert.equal(executable, config.pythonPath);
      assert.deepEqual(args, ['-B', path.resolve(__dirname, '..', 'bridge', 'worker.py'), '--account-id', config.accountId,
        '--state-dir', config.stateDir, '--media-root', config.mediaRoot, '--engine-dir', config.engineDir]);
      assert.equal(options.shell, false);
      const child = originalSpawn(process.execPath, [__filename, '--native-fixture', mode, home], options);
      spawned.push(child);
      return child;
    });
    t.after(async () => {
      t.mock.timers.reset();
      await Promise.all(bridges.map(bridge => bridge.close()));
      fs.rmSync(home, { recursive: true, force: true });
    });
    return {
      home, spawned,
      setMode(value) { mode = value; },
      create() { const bridge = new NativeBridge(config); bridges.push(bridge); return bridge; },
      requests() { return fs.readFileSync(path.join(home, 'requests.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)); }
    };
  }

  test('real status gates readiness and fragmented UTF-8 survives transport', async t => {
    const rig = fixture(t, 'fragments');
    const bridge = rig.create();
    await assert.rejects(bridge.request('fingerprint'), { code: 'BRIDGE_NOT_READY' });
    const first = bridge.start();
    assert.strictEqual(bridge.start(), first);
    assert.deepEqual(await first, { nativeAllowed: false, connected: false, unknownCount: 0, preparedImages: 0 });
    const result = await bridge.request('fingerprint');
    const bytes = fs.readFileSync(path.join(rig.home, 'input.txt'));
    assert.equal(result.text, '真实分片内容 中文🙂');
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await bridge.close(), { closed: true });
    await assert.rejects(bridge.start(), { code: 'BRIDGE_CLOSED' });
    assert.equal(rig.spawned.length, 1);
  });

  test('out-of-order replies settle only their own RPC IDs', async t => {
    const rig = fixture(t, 'normal');
    const bridge = rig.create();
    await bridge.start();
    const completed = [];
    const slow = bridge.request('fingerprint', { delay: 120 }).then(value => { completed.push('slow'); return value; });
    const fast = bridge.request('fingerprint', { delay: 0 }).then(value => { completed.push('fast'); return value; });
    await Promise.all([slow, fast]);
    assert.deepEqual(completed, ['fast', 'slow']);
    const requests = rig.requests();
    assert.equal(new Set(requests.map(request => request.id)).size, requests.length);
  });

  test('invalid startup status never marks an instance ready', async t => {
    const rig = fixture(t, 'bad-start');
    const bridge = rig.create();
    await assert.rejects(bridge.start(), { code: 'PROTOCOL_ERROR' });
    await assert.rejects(bridge.request('fingerprint'), { code: 'PROTOCOL_ERROR' });
    assert.equal(rig.spawned.length, 1);
  });

  for (const mode of ['wrong-id', 'duplicate-key', 'overflow', 'invalid-utf8', 'oversized', 'partial-eof']) {
    test(`${mode} terminates the instance without reconnecting`, async t => {
      const rig = fixture(t, mode);
      const bridge = rig.create();
      await bridge.start();
      await assert.rejects(bridge.request('fingerprint'), error => ['PROTOCOL_ERROR', 'WORKER_EXIT'].includes(error.code));
      await bridge.close();
      await assert.rejects(bridge.start());
      assert.equal(rig.spawned.length, 1);
    });
  }

  test('unexpected stdout EOF rejects pending reads', async t => {
    const rig = fixture(t, 'empty-eof');
    const bridge = rig.create();
    await bridge.start();
    await assert.rejects(bridge.request('fingerprint'), error => ['WORKER_EOF', 'WORKER_EXIT'].includes(error.code));
  });

  test('worker exit preserves unknown write identity and durable record for a new instance', async t => {
    const rig = fixture(t, 'exit-submit');
    const bridge = rig.create();
    await bridge.start();
    const request = { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', text: 'once' };
    await assert.rejects(bridge.request('submit_text', request), error => error.outcome === 'unknown' && error.requestId === request.requestId);
    await bridge.close();
    rig.setMode('normal');
    const next = rig.create();
    assert.equal((await next.start()).unknownCount, 1);
    const record = await next.request('submission', { requestId: request.requestId });
    assert.equal(record.status, 'unknown');
    assert.equal(record.requestId, request.requestId);
    assert.equal(rig.requests().filter(item => item.method === 'submit_text').length, 1);
  });

  test('caller mutation cannot change the identity of an in-flight submission', async t => {
    const rig = fixture(t, 'exit-submit');
    const bridge = rig.create();
    await bridge.start();
    const params = { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', text: 'once' };
    const rejected = assert.rejects(bridge.request('submit_text', params), { outcome: 'unknown', requestId: '01abcdef'.padStart(32, '0') });
    params.requestId = 'f'.repeat(32);
    await rejected;
    assert.equal(JSON.parse(fs.readFileSync(path.join(rig.home, 'submission.json'), 'utf8')).requestId, '01abcdef'.padStart(32, '0'));
  });

  test('incomplete submission responses are unknown, never successful', async t => {
    const rig = fixture(t, 'incomplete-submit');
    const bridge = rig.create();
    await bridge.start();
    await assert.rejects(bridge.request('submit_text', { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', text: 'once' }), {
      code: 'PROTOCOL_ERROR', outcome: 'unknown', requestId: '01abcdef'.padStart(32, '0')
    });
  });

  test('structured errors retain code, outcome, and business request ID', async t => {
    const rig = fixture(t, 'structured-error');
    const bridge = rig.create();
    await bridge.start();
    await assert.rejects(bridge.request('submit_text', { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', text: 'once' }), {
      code: 'conflict', outcome: 'unknown', requestId: '01abcdef'.padStart(32, '0')
    });
    assert.equal((await bridge.request('status')).nativeAllowed, false);
  });

  test('close cancels its generation; late old responses cannot settle new requests', async t => {
    const rig = fixture(t, 'late-submit');
    const old = rig.create();
    await old.start();
    const received = once(rig.spawned[0].stderr, 'data');
    const rejected = assert.rejects(old.request('submit_text', { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', text: 'once' }), {
      code: 'BRIDGE_CLOSED', outcome: 'unknown', requestId: '01abcdef'.padStart(32, '0')
    });
    await received;
    const oldClosed = old.close();
    rig.setMode('normal');
    const current = rig.create();
    await current.start();
    const result = await current.request('fingerprint', { delay: 180 });
    await oldClosed;
    await rejected;
    assert.equal(result.text, '真实分片内容 中文🙂');
    assert.equal(fs.existsSync(path.join(rig.home, 'late-response-written')), true);
    assert.equal(rig.requests().filter(item => item.method === 'submit_text').length, 1);
  });

  test('request deadline preserves unknown and closes only the owned child', async t => {
    const rig = fixture(t, 'hold');
    const bridge = rig.create();
    await bridge.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const received = once(rig.spawned[0].stderr, 'data');
    const rejected = assert.rejects(bridge.request('submit_image', { requestId: '01abcdef'.padStart(32, '0'), targetId: '123456789@chatroom', assetId: 'a'.repeat(32) }), {
      code: 'REQUEST_TIMEOUT', outcome: 'unknown', requestId: '01abcdef'.padStart(32, '0')
    });
    await received;
    t.mock.timers.tick(75_000);
    await rejected;
    t.mock.timers.reset();
    await bridge.close();
    assert.equal(rig.spawned.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rig.home, 'submission.json'), 'utf8')).status, 'unknown');
  });

  test('bounded close kills a stubborn owned worker without killing an independent child', async t => {
    const originalSpawn = childProcess.spawn;
    const sentinel = originalSpawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      if (sentinel.exitCode === null && sentinel.signalCode === null) {
        const stopped = once(sentinel, 'close');
        sentinel.kill();
        await stopped;
      }
    });
    await once(sentinel, 'spawn');
    const rig = fixture(t, 'stubborn');
    const bridge = rig.create();
    await bridge.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ended = once(rig.spawned[0].stdin, 'finish');
    const closed = bridge.close();
    await ended;
    t.mock.timers.tick(2_000);
    await closed;
    t.mock.timers.reset();
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
    assert.notEqual(rig.spawned[0].exitCode ?? rig.spawned[0].signalCode, null);
  });

  test('close during startup cannot be reversed by a late status', async t => {
    const rig = fixture(t, 'slow-start');
    const bridge = rig.create();
    const rejected = assert.rejects(bridge.start(), error => error.code === 'BRIDGE_CLOSED');
    await bridge.close();
    await rejected;
    await assert.rejects(bridge.start());
    assert.equal(rig.spawned.length, 1);
  });
}
