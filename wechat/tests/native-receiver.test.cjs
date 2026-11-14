'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');

// Adversarial child only for protocol trust-boundary tests. Ordinary receiver
// tests below run the actual Python host against real, controlled SQLite files.
if (process.argv[2] === '--receiver-fault') {
  const readline = require('node:readline');
  const mode = process.argv[3];
  const config = JSON.parse(process.argv[4]);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    const respond = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    if (request.method === 'start') {
      respond({ ready: true, readAllowed: true, accountId: config.accountId, pid: config.pid,
        createdAtMs: config.createdAtMs, errors: [], pendingBatchId: null });
      return;
    }
    if (request.method === 'close') { respond({ closed: true }); lines.close(); process.stdin.destroy(); return; }
    if (mode === 'partial-eof') { process.stdout.write('{"id":', () => process.exit(0)); return; }
    if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); return; }
    if (mode === 'duplicate-key') { process.stdout.write(`{"id":${JSON.stringify(request.id)},"id":"forged","result":{}}\n`); return; }
    if (mode === 'wrong-response-id') { process.stdout.write('{"id":"another-request","result":{}}\n'); return; }
    const event = { accountId: config.accountId, scope: 'group', sessionId: config.allowedTargets[0],
      senderId: 'wxid_fixture_member', senderName: 'untrusted name', messageId: '18446744073709551611',
      createdAtMs: 1800000000000, text: '元数据归属边界', mentions: [config.accountId] };
    if (mode === 'other-account') event.accountId = 'wxid_intruder';
    if (mode === 'other-target') event.sessionId = '90009@chatroom';
    if (mode === 'numeric-platform-id') event.messageId = 9007199254740992;
    if (mode === 'missing-mentions') delete event.mentions;
    if (mode === 'raw-sender-name') event.senderName = event.senderId;
    if (mode === 'control-sender-id') event.senderId = 'legacy\u0000invalid';
    if (mode === 'empty-sender-id') event.senderId = '   ';
    if (mode === 'oversize-sender-id') event.senderId = 'x'.repeat(257);
    if (mode === 'control-mention') event.mentions = ['legacy\u200binvalid'];
    if (mode === 'notify-as-sender') event.senderId = 'notify@all';
    if (mode === 'hold') return;
    respond({ batchId: 'a'.repeat(32), events: [event], errors: [] });
  });
} else {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { once } = require('node:events');
  const { tmpdir } = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const { NativeReceiver } = require('../src/native-receiver.cjs');
  const ROOT = path.resolve(__dirname, '..');
  const PYTHON = process.env.WECHAT_TEST_PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const ACCOUNT = 'wxid_fixture_bot';
  const PEER = 'wxid_fixture_member';
  const GROUP = '10001@chatroom';
  const OTHER = '10002@chatroom';
  const table = id => 'Msg_' + createHash('md5').update(id).digest('hex');

  function withDatabase(filename, action) {
    const database = new DatabaseSync(filename);
    try { return action(database); } finally { database.close(); }
  }

  function fixture(t) {
    const home = fs.mkdtempSync(path.join(tmpdir(), 'omp-native-receiver-'));
    const metadata = JSON.parse(childProcess.execFileSync(PYTHON,
      ['-B', path.join(__dirname, 'native', 'test_receiver.py'), '--create-fixture', home, String(process.pid)],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONPATH: '', PYTHONHOME: '' } }));
    const config = { pythonPath: PYTHON, accountId: ACCOUNT, pid: metadata.pid, createdAtMs: metadata.createdAtMs,
      bindingPath: metadata.bindingPath, stateDir: path.join(home, 'state'), allowedTargets: [GROUP, OTHER, PEER], allowRead: true };
    const shard = path.join(home, 'selected', 'db_storage', 'message', 'message_0.db');
    const receivers = [], children = [];
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (executable, args, options) => {
      assert.equal(executable, PYTHON);
      assert.equal(args[1], path.join(ROOT, 'bridge', 'receiver.py'));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('--allow-read'));
      assert.ok(!args.includes('--fixture'));
      const child = spawn(executable, [...args, '--fixture'], options);
      children.push(child);
      return child;
    });
    t.after(async () => {
      await Promise.all(receivers.map(receiver => receiver.close()));
      fs.rmSync(home, { recursive: true, force: true });
    });
    return {
      home, shard, config, children,
      create(changes = {}) { const receiver = new NativeReceiver({ ...config, ...changes }); receivers.push(receiver); return receiver; },
      insert(session = GROUP, { id = 1, messageId = 9007199254740992n, text = '真实 SQLite 中文🙂', sender = 2, source = `<msgsource><atuserlist>${ACCOUNT}</atuserlist></msgsource>` } = {}) {
        const signedId = messageId > (1n << 63n) - 1n ? messageId - (1n << 64n) : messageId;
        withDatabase(shard, db => db.prepare(`INSERT INTO "${table(session)}" VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, 1, sender, 1800000000 + id, text, signedId, null, source));
      },
      state(action) { return withDatabase(path.join(config.stateDir, 'receiver.sqlite'), action); }
    };
  }

  test('default is disabled before opening the binding or spawning any process', async t => {
    const f = fixture(t);
    const receiver = f.create({ allowRead: false, bindingPath: path.join(f.home, 'absent.json') });
    await assert.rejects(receiver.start(), { code: 'READ_DISABLED' });
    assert.equal(f.children.length, 0);
    assert.ok(!fs.existsSync(f.config.stateDir));
  });

  test('real NDJSON reads only new allowed text, preserves uint64 IDs and never auto-acks', async t => {
    const f = fixture(t);
    f.insert(GROUP, { text: '启动前的历史' });
    const receiver = f.create();
    assert.equal((await receiver.start()).ready, true);
    assert.deepEqual(await receiver.poll(), { batchId: null, events: [], errors: [] });
    f.insert(GROUP, { id: 2, messageId: 18446744073709551611n, text: '新消息 中文🙂' });
    f.insert('10003@chatroom', { text: '非允许会话的内容' });
    const batch = await receiver.poll();
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].messageId, '18446744073709551611');
    assert.deepEqual(batch.events[0].mentions, [ACCOUNT]);
    assert.equal(batch.events[0].senderId, PEER);
    assert.equal(batch.events[0].text, '新消息 中文🙂');
    assert.deepEqual(await receiver.poll(), batch);
    assert.equal(f.state(db => db.prepare('SELECT count(*) AS total FROM delivered').get().total), 0);
    // This durable write represents the parent's journal-before-ack boundary.
    const journal = fs.openSync(path.join(f.home, 'inbound.ndjson'), 'wx');
    fs.writeFileSync(journal, JSON.stringify(batch.events) + '\n');
    fs.fsyncSync(journal); fs.closeSync(journal);
    await receiver.ack({ batchId: batch.batchId });
    assert.deepEqual((await receiver.poll()).events, []);
    assert.equal(f.state(db => db.prepare('SELECT count(*) AS total FROM delivered').get().total), 1);
  });

  test('staged batch survives owned-worker death and resumes until the exact ack', async t => {
    const f = fixture(t);
    const first = f.create();
    await first.start();
    f.insert();
    const batch = await first.poll();
    const exited = once(f.children[0], 'close');
    f.children[0].kill();
    await exited;
    await first.close();
    const resumed = f.create();
    assert.equal((await resumed.start()).pendingBatchId, batch.batchId);
    assert.deepEqual(await resumed.poll(), batch);
    await assert.rejects(resumed.ack({ batchId: 'f'.repeat(32) }), { code: 'INVALID_BATCH' });
    await resumed.ack({ batchId: batch.batchId });
    await resumed.close();
    const third = f.create();
    await third.start();
    assert.equal((await third.poll()).batchId, null);
  });

  test('one malformed group cannot pause a healthy group and repair re-reads its unacked row', async t => {
    const f = fixture(t);
    const receiver = f.create();
    await receiver.start();
    f.insert(GROUP, { source: '<msgsource>' });
    f.insert(OTHER, { text: '健康群继续处理' });
    const batch = await receiver.poll();
    assert.deepEqual(batch.events.map(event => event.sessionId), [OTHER]);
    assert.deepEqual(batch.errors.map(error => [error.sessionId, error.code]), [[GROUP, 'INVALID_SOURCE']]);
    await receiver.ack({ batchId: batch.batchId });
    withDatabase(f.shard, db => db.prepare(`UPDATE "${table(GROUP)}" SET source=?`).run('<msgsource/>'));
    assert.deepEqual((await receiver.poll()).events.map(event => event.sessionId), [GROUP]);
  });

  test('member lookup returns verified IDs and rejects another group and corrupt membership', async t => {
    const f = fixture(t);
    const receiver = f.create();
    await receiver.start();
    assert.deepEqual((await receiver.members({ groupId: GROUP })).members,
      [{ userId: ACCOUNT, name: '机器人' }, { userId: PEER, name: '真实成员' }]);
    await assert.rejects(receiver.members({ groupId: '10003@chatroom' }), { code: 'TARGET_NOT_ALLOWED' });
    withDatabase(path.join(f.home, 'selected', 'db_storage', 'contact', 'contact.db'),
      db => db.exec('UPDATE chatroom_member SET member_id=404 WHERE member_id=2'));
    await assert.rejects(receiver.members({ groupId: GROUP }), { code: 'INVALID_MEMBER_MAPPING' });
  });

  test('public names never fall back to private remarks, aliases or stable identifiers', async t => {
    const f = fixture(t);
    const contact = path.join(f.home, 'selected', 'db_storage', 'contact', 'contact.db');
    withDatabase(contact, db => db.prepare('UPDATE contact SET nick_name=?,remark=?,alias=? WHERE username=?')
      .run('公开昵称', '本机私密备注', '私人别名', PEER));
    const receiver = f.create();
    await receiver.start();
    const publicMember = (await receiver.members({ groupId: GROUP })).members.find(member => member.userId === PEER);
    assert.equal(publicMember.name, '公开昵称');
    withDatabase(contact, db => db.prepare('UPDATE contact SET nick_name=? WHERE username=?').run('', PEER));
    const nameless = (await receiver.members({ groupId: GROUP })).members.find(member => member.userId === PEER);
    assert.deepEqual(nameless, { userId: PEER, name: '群友' });
    f.insert();
    const batch = await receiver.poll();
    assert.equal(batch.events[0].senderName, '群友');
    assert.notEqual(batch.events[0].senderName, batch.events[0].senderId);
    assert.ok(!JSON.stringify(batch).includes('本机私密备注'));
  });

  test('legacy member IDs come from real mappings and notify@all is not a bot mention', async t => {
    const f = fixture(t);
    const legacy = 'legacy.user-1987';
    withDatabase(f.shard, db => db.prepare('UPDATE Name2Id SET user_name=? WHERE rowid=2').run(legacy));
    withDatabase(path.join(f.home, 'selected', 'db_storage', 'contact', 'contact.db'), db =>
      db.prepare('UPDATE contact SET username=?,nick_name=? WHERE id=2').run(legacy, '公开旧成员昵称'));
    const receiver = f.create();
    await receiver.start();
    f.insert(GROUP, { source: '<msgsource><atuserlist>legacy.target,notify@all</atuserlist></msgsource>' });
    const batch = await receiver.poll();
    assert.deepEqual(batch.errors, []);
    assert.equal(batch.events[0].senderId, legacy);
    assert.deepEqual(batch.events[0].mentions, ['legacy.target', 'notify@all']);
    assert.ok(!batch.events[0].mentions.includes(ACCOUNT));
    assert.ok((await receiver.members({ groupId: GROUP })).members.some(member => member.userId === legacy));
    assert.throws(() => f.create({ allowedTargets: [legacy] }), { code: 'INVALID_CONFIGURATION' });
  });

  test('runtime account change prevents even re-reading an already staged batch', async t => {
    const f = fixture(t);
    const receiver = f.create();
    await receiver.start();
    f.insert();
    await receiver.poll();
    withDatabase(path.join(f.home, 'selected', 'db_storage', 'fixture-identity.sqlite'),
      db => db.prepare('UPDATE receiver_fixture_identity SET account_id=?').run('wxid_changed'));
    await assert.rejects(receiver.poll(), { code: 'IDENTITY_MISMATCH' });
  });

  test('graceful close and EOF release all owned child pipes, handles and state lock', async t => {
    const f = fixture(t);
    const first = f.create();
    await first.start();
    assert.deepEqual(await first.close(), { closed: true });
    assert.deepEqual(await first.close(), { closed: true });
    assert.equal(f.children[0].exitCode, 0);
    await assert.rejects(first.poll(), { code: 'RECEIVER_NOT_READY' });
    const next = f.create();
    await next.start();
    const exited = once(f.children[1], 'close');
    f.children[1].stdin.end();
    await exited;
    await next.close();
    assert.equal(f.children[1].exitCode, 0);
    const final = f.create();
    await final.start();
    await final.close();
    // Windows refuses this deletion if the state or snapshot handles leaked.
    fs.rmSync(f.config.stateDir, { recursive: true });
  });

  test('closing during startup rejects the pending handshake and joins the child', async t => {
    const f = fixture(t);
    const receiver = f.create();
    const starting = assert.rejects(receiver.start(), { code: 'RECEIVER_CLOSED' });
    await receiver.close();
    await starting;
    assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
  });

  for (const mode of ['partial-eof', 'invalid-utf8', 'duplicate-key', 'wrong-response-id',
    'other-account', 'other-target', 'numeric-platform-id', 'missing-mentions', 'raw-sender-name',
    'control-sender-id', 'empty-sender-id', 'oversize-sender-id', 'control-mention', 'notify-as-sender']) {
    test(`protocol violation ${mode} fails closed and terminates only its child`, async t => {
      const config = { pythonPath: process.execPath, accountId: ACCOUNT, pid: process.pid, createdAtMs: 1000,
        bindingPath: path.join(tmpdir(), 'not-read.json'), stateDir: path.join(tmpdir(), 'not-written'),
        allowedTargets: [GROUP], allowRead: true };
      const spawn = childProcess.spawn;
      let child;
      t.mock.method(childProcess, 'spawn', (_executable, _args, options) => {
        child = spawn(process.execPath, [__filename, '--receiver-fault', mode, JSON.stringify(config)], options);
        return child;
      });
      const receiver = new NativeReceiver(config);
      t.after(() => receiver.close());
      await receiver.start();
      await assert.rejects(receiver.poll(), { code: 'PROTOCOL_ERROR' });
      await receiver.close();
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    });
  }
}
