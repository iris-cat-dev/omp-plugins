import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReminderController } from '../src/reminder-core.mjs';
import { createReminderStore } from '../src/reminder-store.mjs';
import { createNotificationTransport } from '../src/notification-transport.mjs';

const project = { workspaceName: '中文工作区' };
const ready = { state: 'ready', reason: null, accountId: 'fixture-qq', version: '9.9.37' };
const submitted = { state: 'submitted', reason: null, accountId: ready.accountId };
const offline = reason => ({ state: 'not_logged_in', reason, accountId: null, version: null });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate) {
  for (let turn = 0; turn < 300; turn += 1) { if (predicate()) return; await tick(); }
  assert.fail('离线夹具未达到预期状态。');
}
async function drain() { for (let turn = 0; turn < 5; turn += 1) await tick(); }
const cleanups = new WeakMap();
function cleanup(t) {
  if (!cleanups.has(t)) {
    const state = { fixtures: [], directories: [] };
    cleanups.set(t, state);
    t.after(async () => {
      for (const entry of state.fixtures) await entry.close();
      for (const dir of state.directories) rmSync(dir, { recursive: true, force: true });
    });
  }
  return cleanups.get(t);
}
function databaseFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-notifier-fixture-'));
  cleanup(t).directories.push(dir);
  return path.join(dir, 'reminders.sqlite');
}
function question(id = 'ui_1', body = '要使用哪个方案？') {
  return {
    id, provider: 'omp', name: 'OMP ask', kind: 'question', title: '请回答以下问题',
    input: { questions: [{ id: 'choice', header: '方案', question: body,
      options: [{ label: '方案甲', recommended: true }, { label: '方案乙', recommended: false }],
      multiSelect: false, allowOther: true }] },
    metadata: { extensionUiMethod: 'ask', questions: [{ id: 'choice', question: body,
      options: [{ label: '方案甲' }, { label: '方案乙' }], recommended: 0, multi: false }] },
  };
}
function plan(revision, body) {
  return { id: 'omp-plan-approval', provider: 'omp', name: 'OmpPlanApproval', kind: 'plan',
    input: { plan: body }, metadata: revision ? { planMessageId: revision } : {} };
}
function agent(id, requests = [question()], extra = {}) {
  return { id, title: `会话-${id}`, cwd: 'C:/测试工程', workspaceId: 'workspace-1',
    pendingPermissions: requests, archivedAt: null, ...extra };
}
function directory(entries, nextCursor = null) {
  return { entries: entries.map(value => ({ agent: value, project })), pageInfo: { nextCursor } };
}
function fixture(t, options = {}) {
  const store = createReminderStore(options.file ?? ':memory:');
  const settings = {};
  if (options.enabled !== undefined) settings.enabled = options.enabled;
  if (options.targetMode !== undefined) settings.targetMode = options.targetMode;
  if (Object.keys(settings).length) store.configure(settings);
  const snapshots = new Map((options.entries ?? []).map(value => [value.id, value]));
  let listener;
  let storeClosed = false;
  const calls = { list: [], refresh: [], inspect: 0, ensure: [], finish: [], send: [], close: 0, unsubscribe: 0 };
  const omp = { hostId: options.hostId ?? 'fixture-host', agents: {
    subscribe(handler) { listener = handler; return () => { calls.unsubscribe += 1; listener = null; }; },
    async list(input) {
      assert.ok(listener, '必须先订阅再读取目录');
      calls.list.push(input);
      return options.list ? options.list(input, calls.list.length) : directory([...snapshots.values()]);
    },
    ref(id) { return { async refresh() {
      calls.refresh.push(id);
      return options.refresh ? options.refresh(id, calls.refresh.length) : { agent: snapshots.get(id) ?? null };
    } }; },
  } };
  const qq = {
    async inspect() { calls.inspect += 1; return options.inspect ? options.inspect(calls.inspect) : ready; },
    async ensureLoggedIn(input) { calls.ensure.push(input); return options.ensure ? options.ensure(input) : ready; },
    async send(value) {
      calls.send.push(value);
      return options.send ? options.send(value, calls.send.length) : submitted;
    },
    async finishBatch(input) {
      calls.finish.push(input);
      return options.finish ? options.finish(input, calls.finish.length) : null;
    },
    async close() { calls.close += 1; },
  };
  const sender = createNotificationTransport({ qq, signal: options.signal });
  const controller = new ReminderController({ omp, sender, store, signal: options.signal, onChange: options.onChange });
  const result = { controller, store, calls,
    emit(value) { assert.ok(listener); snapshots.set(value.id, value); listener({ kind: 'upsert', agent: value, project }); },
    remove(id) { assert.ok(listener); snapshots.delete(id); listener({ kind: 'remove', agentId: id }); },
    async close() { await controller.close(); if (!storeClosed) { store.close(); storeClosed = true; } },
  };
  cleanup(t).fixtures.push(result);
  return result;
}
const bodyOf = messages => messages.map(({ text }) => text.replace(/^【OMP 提醒 [0-9a-f]{32} · 第 \d+\/\d+ 段】\n/u, '')).join('');

test('管理模式可读取且关闭不接触OMP或销毁状态库', async () => {
  const store = createReminderStore(':memory:');
  let closed = 0;
  const controller = new ReminderController({ omp: undefined, store, sender: { close() { closed += 1; } } });
  await assert.rejects(controller.test(), /启用/u);
  await controller.close(); await controller.close();
  assert.equal(closed, 1);
  assert.equal(controller.read().connection, null);
  assert.equal(store.readSettings().lastAttempt, null);
  store.close();
});

test('关闭时不检查QQ，启用不补旧问题，只有新问题发送', async t => {
  const f = fixture(t, { entries: [agent('a')] });
  await f.controller.start();
  assert.equal(f.calls.inspect, 0);
  f.controller.configure({ enabled: true });
  await drain();
  assert.equal(f.calls.send.length, 0);
  f.emit(agent('a', [question(), question('new', '新问题正文')]));
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(f.calls.send.length, 1);
  assert.ok(bodyOf(f.calls.send).includes('新问题正文'));
  assert.ok(!bodyOf(f.calls.send).includes('要使用哪个方案？'));
});

test('分页合并保留实时新增与移除，不让迟到旧页恢复旧问题', async t => {
  const first = deferred();
  const oldA = agent('a', [question('old', '旧页内容')]);
  const newA = agent('a', [question('new', '实时新问题')]);
  const oldB = agent('b');
  let f;
  f = fixture(t, { enabled: true, entries: [oldA, oldB], list: async (input, page) => {
    if (page === 1) return first.promise;
    f.remove('b'); return directory([oldB]);
  } });
  const starting = f.controller.start();
  f.emit(newA); first.resolve(directory([oldA], 'next'));
  await starting;
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.deepEqual(f.calls.refresh, ['a']);
  assert.ok(bodyOf(f.calls.send).includes('实时新问题'));
  assert.ok(!bodyOf(f.calls.send).includes('旧页内容'));
  assert.equal(f.controller.read().pendingCount, 1);
});

test('三种设备选择准确生效，双端使用独立requestId', async t => {
  for (const [targetMode, expected] of [['phone', ['phone']], ['pad', ['pad']], ['both', ['phone', 'pad']]]) {
    await t.test(targetMode, async subtest => {
      const f = fixture(subtest, { enabled: true, targetMode, entries: [agent('a')] });
      await f.controller.start();
      await until(() => f.controller.read().lastAttempt?.state === 'submitted');
      assert.deepEqual(f.calls.send.map(value => value.target), expected);
      assert.equal(new Set(f.calls.send.map(value => value.requestId)).size, expected.length);
      assert.deepEqual(Object.keys(f.controller.read().lastAttempt.targets), expected);
    });
  }
});

test('选择固定在入队时；登录等待和分段期间改选不转投旧提醒', async t => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, targetMode: 'both', entries: [agent('a')],
    inspect: count => count === 1 ? offline('QQ未登录') : ready, ensure: () => gate.promise });
  await f.controller.start();
  await until(() => f.calls.ensure.length === 1);
  f.controller.configure({ targetMode: 'pad' });
  f.emit(agent('b', [question('second')]));
  gate.resolve(ready);
  await until(() => f.calls.finish.length === 1);
  assert.deepEqual(f.calls.send.map(value => value.target), ['phone', 'pad', 'pad']);
  assert.equal(f.controller.read().targetMode, 'pad');
});

test('重复事件、改选及重载都不补发；已答后同ID重新出现是新生命周期', async t => {
  const file = databaseFile(t);
  const current = agent('a');
  const first = fixture(t, { file, enabled: true, targetMode: 'both', entries: [current] });
  await first.controller.start();
  await until(() => first.controller.read().lastAttempt?.state === 'submitted');
  first.controller.configure({ targetMode: 'pad' });
  for (let i = 0; i < 5; i += 1) first.emit(current);
  await drain(); assert.equal(first.calls.send.length, 2);
  await first.close();
  const second = fixture(t, { file, entries: [current] });
  await second.controller.start(); await drain();
  assert.equal(second.calls.send.length, 0);
  second.emit(agent('a', [])); second.emit(current);
  await until(() => second.controller.read().lastAttempt?.state === 'submitted' && second.calls.send.length === 1);
  assert.equal(second.calls.send[0].target, 'pad');
});

test('不同会话或不同host的同requestId分别提醒', async t => {
  const file = databaseFile(t);
  const first = fixture(t, { file, enabled: true, hostId: 'one', entries: [agent('a'), agent('b')] });
  await first.controller.start(); await until(() => first.calls.finish.length === 1);
  assert.equal(first.calls.send.length, 2); await first.close();
  const next = fixture(t, { file, hostId: 'two', entries: [agent('a')] });
  await next.controller.start(); await until(() => next.calls.finish.length === 1);
  assert.equal(next.calls.send.length, 1);
});

test('刷新期间已答、归档和排队移除均不发送旧请求', async t => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, entries: [agent('a'), agent('b')], refresh: id => id === 'a' ? gate.promise : { agent: agent('b', [], { archivedAt: 'now' }) } });
  await f.controller.start(); await until(() => f.calls.refresh.length === 1);
  f.emit(agent('a', [])); f.remove('b'); gate.resolve({ agent: agent('a') });
  await drain();
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.controller.read().pendingCount, 0);
});

test('真实待处理请求各提醒一次，问答保留全部选项，审批只发送类型和会话名', async t => {
  const request = question();
  request.input.questions = [{ id: 'features', question: '选择功能', multiSelect: true, allowOther: true,
    options: [{ label: '搜索' }, { label: '导出' }] }];
  request.metadata.questions = [{ id: 'features', recommended: 1,
    options: [{ label: '搜索', description: '搜索全部条目', preview: '搜索预览\n第二行' }, { label: '导出' }] }];
  const privateMarker = 'PRIVATE_APPROVAL_CONTENT';
  const requests = [request, plan('plan-1', privateMarker), ...['tool', 'mode', 'other'].map(kind => ({
    id: kind, kind, name: privateMarker, title: privateMarker, description: privateMarker,
    input: { command: privateMarker }, detail: { command: privateMarker },
    metadata: { toolArgs: { token: privateMarker } },
    actions: [{ label: privateMarker }],
  }))];
  const current = agent('a', requests);
  const f = fixture(t, { enabled: true, entries: [current] });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  assert.equal(f.controller.read().pendingCount, 5);
  const bodies = f.calls.send.map(message => bodyOf([message]));
  assert.equal(bodies.length, 5);
  for (const expected of ['会话-a', '中文工作区', 'C:/测试工程', '选择功能', '可多选', '导出（推荐）', '搜索全部条目', '搜索预览\n第二行', '自定义输入']) assert.ok(bodies[0].includes(expected), expected);
  for (const [index, label] of ['计划待审批', '工具或权限待审批', '模式切换待确认', '有事项待确认'].entries()) {
    const message = bodies[index + 1];
    assert.ok(message.includes(label) && message.includes('会话-a') && message.includes('OMP 原会话'));
    assert.ok(!message.includes('C:/测试工程') && !message.includes(privateMarker));
  }
  assert.match(bodies[1], /批准执行.*继续规划/u);
  f.emit(current); await drain();
  assert.equal(f.calls.send.length, 5);
});

test('修改后的同ID计划重新提醒，重复快照和重载不会重复发送，也不保存计划正文', async t => {
  for (const hasMessageId of [true, false]) {
    await t.test(hasMessageId ? '计划消息ID' : '缺少消息ID时的版本识别', async subtest => {
      const file = databaseFile(subtest);
      const original = agent('plan', [plan(hasMessageId ? 'plan-1' : null, 'PRIVATE_PLAN_ORIGINAL')]);
      const revised = agent('plan', [plan(hasMessageId ? 'plan-2' : null, 'PRIVATE_PLAN_REVISED')]);
      const first = fixture(subtest, { file, enabled: true, entries: [original] });
      await first.controller.start(); await until(() => first.calls.finish.length === 1);
      first.emit(revised); first.emit(revised);
      await until(() => first.calls.finish.length === 2);
      assert.equal(first.calls.send.length, 2);
      assert.equal(first.controller.read().pendingCount, 1);
      assert.ok(first.calls.send.every(message => !message.text.includes('PRIVATE_PLAN')));
      await first.close();
      assert.ok(!readFileSync(file).includes(Buffer.from('PRIVATE_PLAN')));
      const next = fixture(subtest, { file, entries: [revised] });
      await next.controller.start(); await drain();
      assert.equal(next.calls.send.length, 0);
      assert.equal(next.controller.read().pendingCount, 1);
    });
  }
});

test('自动通过、普通回复和报错均无待处理卡，不触发QQ', async t => {
  const f = fixture(t, { enabled: true, entries: [agent('a', [])] });
  await f.controller.start();
  f.emit(agent('a', [], { status: 'running' }));
  f.emit(agent('a', [], { status: 'idle', requiresAttention: true, attentionReason: 'finished' }));
  f.emit(agent('a', [], { status: 'error', requiresAttention: true, attentionReason: 'error' }));
  await drain();
  assert.equal(f.controller.read().pendingCount, 0);
  assert.equal(f.calls.inspect, 0);
  assert.deepEqual(f.calls.send, []);
});

test('旧计划被新版本取代时，已排队的旧版本不再提交', async t => {
  const gate = deferred();
  const original = agent('a', [plan('plan-1', '原计划')]);
  const revised = agent('a', [plan('plan-2', '修改计划')]);
  const f = fixture(t, { enabled: true, entries: [original], refresh: (_id, count) =>
    count === 1 ? gate.promise : { agent: revised } });
  await f.controller.start(); await until(() => f.calls.refresh.length === 1);
  f.emit(revised);
  gate.resolve({ agent: original });
  await until(() => f.calls.finish.length === 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.controller.read().pendingCount, 1);
});

test('手机提交后审批已处理，即使撤回事件尚未到达也不发送Pad', async t => {
  const current = agent('a', [{ id: 'tool', kind: 'tool' }]);
  const f = fixture(t, { enabled: true, targetMode: 'both', entries: [current], refresh: (_id, count) =>
    ({ agent: count === 1 ? current : agent('a', []) }) });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  assert.deepEqual(f.calls.send.map(value => value.target), ['phone']);
  assert.equal(f.controller.read().lastAttempt.state, 'partial');
  assert.equal(f.controller.read().lastAttempt.targets.pad.state, 'skipped');
  assert.equal(f.controller.read().pendingCount, 0);
});

test('双端长问题UTF8无截断，每端完整且每设备每段独立标识', async t => {
  const long = '开始🧵\n' + '中文🙂👨‍👩‍👧‍👦é𠀀\n'.repeat(400) + '最后：终';
  const f = fixture(t, { enabled: true, targetMode: 'both', entries: [agent('a', [question('long', long)])] });
  await f.controller.start(); await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(new Set(f.calls.send.map(value => value.requestId)).size, f.calls.send.length);
  for (const target of ['phone', 'pad']) {
    const messages = f.calls.send.filter(value => value.target === target);
    assert.ok(bodyOf(messages).includes(long));
    for (const [index, message] of messages.entries()) {
      assert.ok(Buffer.byteLength(message.text) <= 4094);
      assert.equal(Buffer.from(message.text).toString('utf8'), message.text);
      assert.ok(message.text.includes(`第 ${index + 1}/${messages.length} 段`));
    }
  }
});

test('每端调用前已落盘unknown，前一端提交结果不会被后一端覆盖', async t => {
  const file = databaseFile(t);
  const f = fixture(t, { file, enabled: true, targetMode: 'both', entries: [agent('a')], send: value => {
    const observer = new DatabaseSync(file, { readOnly: true });
    try {
      const row = observer.prepare('SELECT state, segment_id FROM reminder_requests WHERE present = 1').get();
      assert.equal(row.state, 'unknown'); assert.equal(row.segment_id, value.requestId);
      const attempt = JSON.parse(observer.prepare('SELECT last_attempt FROM reminder_settings').get().last_attempt);
      assert.equal(attempt.targets[value.target].state, 'unknown');
      if (value.target === 'pad') assert.equal(attempt.targets.phone.state, 'submitted');
    } finally { observer.close(); }
    return submitted;
  } });
  await f.controller.start(); await until(() => f.controller.read().lastAttempt?.state === 'submitted');
});

test('Pad失败不重复手机，手机继续完整分段且重载不补发', async t => {
  const file = databaseFile(t);
  const long = '手机完整内容🙂'.repeat(1000);
  const current = agent('a', [question('partial', long)]);
  const f = fixture(t, { file, enabled: true, targetMode: 'both', entries: [current],
    send: value => value.target === 'pad' ? { state: 'failed', reason: 'Pad目标不可用' } : submitted });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  assert.equal(f.controller.read().lastAttempt.state, 'partial');
  assert.equal(f.controller.read().lastAttempt.targets.pad.state, 'failed');
  assert.equal(f.calls.send.filter(value => value.target === 'pad').length, 1);
  assert.ok(bodyOf(f.calls.send.filter(value => value.target === 'phone')).includes(long));
  assert.equal(f.calls.finish[0].mayClose(), false);
  const count = f.calls.send.length; f.emit(current); await drain(); assert.equal(f.calls.send.length, count);
  await f.close();
  const second = fixture(t, { file, entries: [current] });
  await second.controller.start(); await drain(); assert.equal(second.calls.send.length, 0);
});

test('无成功时unknown优先于明确失败，重复事件不重试任一设备', async t => {
  const current = agent('a');
  const f = fixture(t, { enabled: true, targetMode: 'both', entries: [current], send: value => ({
    state: value.target === 'phone' ? 'unknown' : 'failed', reason: '需要核对',
  }) });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  assert.equal(f.controller.read().lastAttempt.state, 'unknown');
  assert.equal(f.calls.finish[0].mayClose(), false);
  f.emit(current); await drain(); assert.equal(f.calls.send.length, 2);
});

test('输入编辑器与secret不读敏感正文，也不写状态库', async t => {
  const file = databaseFile(t);
  const hidden = 'THIS-MUST-NEVER-LEAVE-OMP';
  const requests = ['input', 'editor'].map(method => {
    const value = { id: method, kind: 'question', metadata: { extensionUiMethod: method } };
    for (const field of ['input', 'title', 'description']) Object.defineProperty(value, field, { get() { throw new Error(`禁止读取${field}`); } });
    return value;
  });
  const secret = question('secret', hidden); secret.metadata.secret = true; requests.push(secret);
  const f = fixture(t, { file, enabled: true, targetMode: 'both', entries: [agent('a', requests)] });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  assert.equal(f.calls.send.length, 6);
  for (const message of f.calls.send) { assert.ok(message.text.includes('此会话有输入请求')); assert.ok(!message.text.includes(hidden)); }
  assert.ok(!JSON.stringify(f.controller.read()).includes(hidden));
  assert.ok(!readFileSync(file).includes(Buffer.from(hidden)));
});

test('手机提交后停用取消Pad和后续分段，再开启不恢复旧提醒', async t => {
  let f;
  f = fixture(t, { enabled: true, targetMode: 'both', entries: [agent('a', [question('long', '很长🙂'.repeat(1000))])], send: () => {
    f.controller.configure({ enabled: false }); return submitted;
  } });
  await f.controller.start(); await until(() => f.controller.read().lastAttempt?.state === 'partial');
  assert.deepEqual(f.calls.send.map(value => value.target), ['phone']);
  assert.equal(f.controller.read().lastAttempt.targets.pad.state, 'skipped');
  f.controller.configure({ enabled: true }); await drain(); assert.equal(f.calls.send.length, 1);
});

test('unknown落盘回调同步停用时，不进入真正发送', async t => {
  let f; let stopped = false;
  f = fixture(t, { enabled: true, entries: [agent('a')], onChange: state => {
    if (!stopped && state.lastAttempt?.state === 'unknown') { stopped = true; f.controller.configure({ enabled: false }); }
  } });
  await f.controller.start(); await until(() => f.controller.read().lastAttempt?.state === 'skipped');
  assert.equal(f.calls.send.length, 0);
});

test('QQ登录等待可由已答事件取消，后续新问题仍可发送', async t => {
  let waiting;
  const f = fixture(t, { enabled: true, entries: [agent('a')], inspect: count => count === 1 ? offline('QQ未登录') : ready,
    ensure: input => { waiting = input; return new Promise(resolve => input.signal.addEventListener('abort', () => resolve(offline('已取消')), { once: true })); } });
  await f.controller.start(); await until(() => Boolean(waiting));
  f.emit(agent('a', [])); assert.equal(waiting.signal.aborted, true); assert.equal(waiting.mayContinue(), false);
  await drain(); assert.equal(f.calls.send.length, 0);
  f.emit(agent('a', [question('next')]));
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(f.calls.ensure.length, 1);
});

test('测试提醒遵循当前设备选择，不创建或刷新真实问题', async t => {
  const f = fixture(t, { enabled: true, targetMode: 'pad' });
  await f.controller.start(); const result = await f.controller.test();
  assert.equal(result.lastAttempt.state, 'submitted'); assert.equal(result.pendingCount, 0);
  assert.deepEqual(f.calls.send.map(value => value.target), ['pad']);
  assert.equal(f.calls.refresh.length, 0);
});

test('整批双端及长问题全部提交后才退出临时QQ', async t => {
  const last = deferred(); const permissions = []; let f;
  f = fixture(t, { enabled: true, targetMode: 'both', entries: [agent('a', [question('long', '长问题🙂'.repeat(1000))]), agent('b', [question('second')])],
    inspect: count => count === 1 ? offline('QQ未登录') : ready,
    send: value => value.target === 'pad' && value.text.includes('请求：second') ? last.promise : submitted,
    finish: ({ mayClose }) => { permissions.push(mayClose()); return offline('临时QQ正常退出'); } });
  await f.controller.start(); await until(() => f.calls.send.some(value => value.target === 'pad' && value.text.includes('请求：second')));
  assert.equal(f.calls.finish.length, 0);
  last.resolve(submitted); await until(() => f.controller.read().connection.state === 'not_logged_in');
  assert.deepEqual(permissions, [true]); assert.equal(f.calls.ensure.length, 1);
  assert.equal(f.controller.read().lastAttempt.state, 'submitted');
});

test('收尾时新问题撤回退出许可，完成后继续队列不丢单', async t => {
  const gate = deferred(); const allowed = [];
  const first = question('first');
  const f = fixture(t, { enabled: true, entries: [agent('a', [first])], finish: async ({ mayClose }, count) => {
    if (count === 1) await gate.promise;
    allowed.push(mayClose()); return allowed.at(-1) ? offline('正常退出') : null;
  } });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  f.emit(agent('a', [first, question('second')])); assert.equal(f.calls.finish[0].mayClose(), false);
  gate.resolve(); await until(() => f.calls.finish.length === 2 && f.controller.read().connection.state === 'not_logged_in');
  assert.deepEqual(allowed, [false, true]); assert.equal(f.calls.send.length, 2);
});

test('空队列不空转，原已打开QQ不关闭，退出失败不改已提交结果', async t => {
  const f = fixture(t, { enabled: true, finish: () => { throw new Error('退出失败'); } });
  await f.controller.start(); await drain(); assert.equal(f.calls.finish.length, 0);
  const current = agent('a'); f.emit(current);
  await until(() => f.controller.read().connection?.state === 'error');
  assert.equal(f.controller.read().lastAttempt.state, 'submitted');
  assert.equal(f.calls.close, 0);
  for (let i = 0; i < 5; i += 1) f.emit(current);
  await drain(); assert.equal(f.calls.finish.length, 1);
});

test('已答导致分段不完整时保持QQ打开，后续成功不擦除退出保护', async t => {
  const gate = deferred(); const allowed = [];
  const f = fixture(t, { enabled: true, entries: [agent('a', [question('long', '长问题🙂'.repeat(1000))])],
    send: (value, count) => count === 1 ? gate.promise : submitted,
    finish: ({ mayClose }) => { allowed.push(mayClose()); return null; } });
  await f.controller.start(); await until(() => f.calls.send.length === 1);
  f.emit(agent('a', [])); gate.resolve(submitted);
  await until(() => f.calls.finish.length === 1);
  assert.equal(f.controller.read().lastAttempt.targets.phone.state, 'partial');
  f.emit(agent('a', [question('later')])); await until(() => f.calls.finish.length === 2);
  assert.deepEqual(allowed, [false, false]);
});

test('关闭不等待迟到提交，保留unknown和已提交端，不发剩余设备', async t => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, targetMode: 'both', entries: [agent('a')], send: () => gate.promise });
  await f.controller.start(); await until(() => f.calls.send.length === 1);
  await f.controller.close();
  assert.equal(f.calls.close, 1); assert.equal(f.calls.unsubscribe, 1);
  assert.equal(f.store.readSettings().lastAttempt.targets.phone.state, 'unknown');
  gate.resolve(submitted); await drain(); assert.equal(f.calls.send.length, 1);
});

test('异步收尾时关闭撤回退出许可，迟到结果不更改已提交状态', async t => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, entries: [agent('a')], finish: () => gate.promise });
  await f.controller.start(); await until(() => f.calls.finish.length === 1);
  const completed = f.controller.read(); await f.controller.close();
  assert.equal(f.calls.finish[0].mayClose(), false);
  gate.resolve(offline('迟到退出')); await drain();
  assert.deepEqual(f.controller.read().lastAttempt, completed.lastAttempt);
  assert.deepEqual(f.controller.read().connection, completed.connection);
});
