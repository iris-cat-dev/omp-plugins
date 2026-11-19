import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReminderStore } from '../src/reminder-store.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-notifier-store-fixture-'));
  const file = path.join(dir, 'reminders.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, open() { const store = createReminderStore(file); stores.push(store); return store; } };
}

test('关闭期间及上次进程排队的问题不会在启用或重载后补发', t => {
  const f = fixture(t);
  const first = f.open();
  first.syncAgent('host', 'off', '关闭时的问题', ['off'], false);
  first.configure({ enabled: true, targetMode: 'pad' });
  first.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.equal(first.nextQueued('host').target_mode, 'pad');
  first.close();
  const second = f.open();
  assert.equal(second.readSettings().enabled, true);
  assert.equal(second.readSettings().targetMode, 'pad');
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  second.syncAgent('host', 'off', '关闭时的问题', ['off'], true);
  assert.equal(second.nextQueued('host'), null);
  assert.equal(second.countCurrent('host'), 2);
});

test('选择只影响新提醒，关闭开关不会丢失设备选择，测试任务也固定自己的选择', t => {
  const f = fixture(t);
  const store = f.open();
  store.configure({ enabled: true, targetMode: 'both' });
  store.syncAgent('host', 'a', '会话', ['first'], true);
  const first = store.nextQueued('host');
  store.configure({ targetMode: 'pad' });
  store.syncAgent('host', 'a', '会话', ['first', 'second'], true);
  assert.equal(store.nextQueued('host').target_mode, 'both');
  store.finish(first.lifecycle, { state: 'submitted', targets: { phone: { state: 'submitted', reason: null }, pad: { state: 'submitted', reason: null } } });
  assert.equal(store.nextQueued('host').target_mode, 'pad');
  const life = store.enqueueTest('host');
  store.configure({ enabled: false });
  assert.equal(store.readSettings().targetMode, 'pad');
  const observer = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(observer.prepare('SELECT target_mode FROM reminder_requests WHERE lifecycle = ?').get(life).target_mode, 'pad');
  } finally { observer.close(); }
});

test('分设备unknown状态跨重载保持，重复快照不重新入队', t => {
  const f = fixture(t);
  const first = f.open();
  first.configure({ targetMode: 'both' });
  first.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  const row = first.nextQueued('host');
  const targets = { phone: { state: 'submitted', reason: null }, pad: { state: 'unknown', reason: 'Pad 提交结果未知' } };
  first.markUnknown(row.lifecycle, 'a'.repeat(32), { agentTitle: '会话', targets });
  first.close();
  const second = f.open();
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.equal(second.nextQueued('host'), null);
  assert.equal(second.readSettings().lastAttempt.state, 'unknown');
  assert.deepEqual(second.readSettings().lastAttempt.targets, targets);
  second.syncAgent('host', 'agent', '会话', [], true);
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.notEqual(second.nextQueued('host').lifecycle, row.lifecycle);
});

test('保留当前去重身份和有限历史，不保存问题或答案正文', t => {
  const f = fixture(t);
  const store = f.open();
  for (let i = 0; i < 300; i += 1) {
    store.syncAgent('host', 'agent', '会话', [`ui_${i}`], true);
    const row = store.nextQueued('host');
    store.markUnknown(row.lifecycle, 'b'.repeat(32), { agentTitle: '会话', targets: { phone: { state: 'unknown', reason: null } } });
    store.finish(row.lifecycle, { state: 'submitted', targets: { phone: { state: 'submitted', reason: null } } });
    store.syncAgent('host', 'agent', '会话', [], true);
  }
  store.syncAgent('host', 'agent', '会话', ['current'], true);
  const observer = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(observer.prepare('SELECT count(*) AS count FROM reminder_requests WHERE present = 0').get().count, 256);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM reminder_requests WHERE present = 1').get().count, 1);
    const names = observer.prepare('PRAGMA table_info(reminder_requests)').all().map(column => column.name);
    for (const forbidden of ['body', 'text', 'input', 'questions', 'answers', 'metadata', 'payload']) assert.ok(!names.includes(forbidden));
  } finally { observer.close(); }
});

test('目录收尾只清理当前host，测试提醒不计入待答数量', t => {
  const store = fixture(t).open();
  store.syncAgent('host-a', 'keep', '保留', ['same'], true);
  store.syncAgent('host-a', 'remove', '移除', ['same'], true);
  store.syncAgent('host-b', 'remove', '另一个宿主', ['same'], true);
  const life = store.enqueueTest('host-a');
  store.completeDirectory('host-a', new Set(['keep']));
  assert.equal(store.countCurrent('host-a'), 1);
  assert.equal(store.countCurrent('host-b'), 1);
  store.finish(life, { state: 'skipped', targets: { phone: { state: 'not_logged_in', reason: 'QQ 未登录' } } });
  assert.equal(store.isCurrent(life), false);
  store.cancelQueued('提醒已停用');
  assert.equal(store.nextQueued('host-a'), null);
  assert.equal(store.nextQueued('host-b'), null);
});

test('真实v1表升级默认手机，保留开关、旧快照、unknown与去重，不重排旧提醒', t => {
  const f = fixture(t);
  const oldAttempt = { at: 123456789, state: 'partial', reason: '旧版待核对', agentTitle: '旧会话', channels: { qq: { state: 'unknown', reason: 'QQ 未知' }, wechat: { state: 'submitted', reason: null } } };
  const legacy = new DatabaseSync(f.file);
  legacy.exec(`
    CREATE TABLE reminder_settings (singleton INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, last_attempt TEXT);
    CREATE TABLE reminder_requests (
      lifecycle TEXT PRIMARY KEY, host_id TEXT NOT NULL, agent_id TEXT NOT NULL, request_id TEXT NOT NULL,
      type TEXT NOT NULL, agent_title TEXT, present INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT,
      segment_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  legacy.prepare('INSERT INTO reminder_settings VALUES (1,1,?)').run(JSON.stringify(oldAttempt));
  legacy.prepare('INSERT INTO reminder_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('old-life', 'host', 'agent', 'old-request', 'question', '旧会话', 1, 'unknown', '旧未知', 'c'.repeat(32), 1, 1);
  legacy.close();
  const migrated = f.open();
  assert.equal(migrated.readSettings().enabled, true);
  assert.equal(migrated.readSettings().targetMode, 'phone');
  assert.deepEqual(migrated.readSettings().lastAttempt.targets, { phone: oldAttempt.channels.qq });
  migrated.configure({ targetMode: 'both' });
  migrated.syncAgent('host', 'agent', '旧会话', ['old-request'], true);
  assert.equal(migrated.nextQueued('host'), null);
  const observer = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(observer.prepare('SELECT legacy_last_attempt FROM reminder_settings').get().legacy_last_attempt), oldAttempt);
    const row = observer.prepare('SELECT state, segment_id, target_mode FROM reminder_requests').get();
    assert.equal(row.state, 'unknown');
    assert.equal(row.segment_id, 'c'.repeat(32));
    assert.equal(row.target_mode, 'phone');
    assert.equal(observer.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { observer.close(); }
});
