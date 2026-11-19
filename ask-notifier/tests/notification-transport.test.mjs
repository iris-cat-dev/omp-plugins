import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationTransport } from '../src/notification-transport.mjs';

const state = (value, reason = null) => ({ state: value, reason, accountId: value === 'ready' ? 'qq-fixture' : null, version: value === 'ready' ? '9.9.37' : null });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) {
  for (let turn = 0; turn < 100; turn += 1) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('路由夹具未达到预期状态。');
}
function fixture(t, options = {}) {
  const calls = { inspect: 0, ensure: [], finish: [], close: 0 };
  const qq = {
    async inspect() { calls.inspect += 1; return options.inspect ? options.inspect() : state(options.state ?? 'ready'); },
    async ensureLoggedIn(input) { calls.ensure.push(input); return options.ensure ? options.ensure(input) : state('ready'); },
    async finishBatch(input) { calls.finish.push(input); return options.finish ? options.finish(input) : null; },
    async close() { calls.close += 1; },
  };
  const transport = createNotificationTransport({ qq, signal: options.signal });
  t.after(() => transport.close());
  return { transport, calls };
}

test('已登录不启动新QQ，明确未登录才等待自动登录', async t => {
  for (const value of ['ready', 'not_logged_in']) {
    await t.test(value, async subtest => {
      const f = fixture(subtest, { state: value });
      assert.equal((await f.transport.prepare()).connection.state, 'ready');
      assert.equal(f.calls.ensure.length, value === 'not_logged_in' ? 1 : 0);
    });
  }
});

test('状态不确定、多账号、未安装或接口不支持时不猜测并自动启动', async t => {
  for (const value of ['unsupported', 'multiple_accounts', 'error', 'not_installed']) {
    await t.test(value, async subtest => {
      const f = fixture(subtest, { state: value });
      assert.equal((await f.transport.prepare()).connection.state, value);
      assert.equal(f.calls.ensure.length, 0);
    });
  }
});

test('自动登录超时和检查异常均保留实际失败状态', async t => {
  const timeout = fixture(t, { state: 'not_logged_in', ensure: () => state('login_timeout', '等待60秒超时') });
  assert.equal((await timeout.transport.prepare()).connection.reason, '等待60秒超时');
  const failure = fixture(t, { inspect: () => { throw new Error('inspect failed'); } });
  assert.equal((await failure.transport.prepare()).connection.state, 'error');
  assert.equal(failure.calls.ensure.length, 0);
});

test('取消或问题已结束时不启动QQ', async t => {
  const abort = new AbortController(); abort.abort();
  const f = fixture(t, { state: 'not_logged_in' });
  await f.transport.prepare({ signal: abort.signal });
  await f.transport.prepare({ maySend: () => false });
  assert.equal(f.calls.ensure.length, 0);
});

test('等待登录期间问题取消实时撤回许可，关闭传递取消并只释放一次', async t => {
  const gate = deferred(); let current = true;
  const f = fixture(t, { state: 'not_logged_in', ensure: () => gate.promise });
  const preparing = f.transport.prepare({ maySend: () => current });
  await until(() => f.calls.ensure.length === 1);
  const input = f.calls.ensure[0];
  assert.equal(input.mayContinue(), true);
  current = false; assert.equal(input.mayContinue(), false);
  await f.transport.close(); await f.transport.close();
  assert.equal(input.signal.aborted, true); assert.equal(f.calls.close, 1);
  gate.resolve(state('ready')); await preparing;
});

test('退出许可随新增排队、宿主关闭变化，未拥有临时QQ时保持连接', async t => {
  const signal = new AbortController(); let empty = true;
  const f = fixture(t, { signal: signal.signal, finish: ({ mayClose }) => {
    assert.equal(mayClose(), true); empty = false; assert.equal(mayClose(), false);
    empty = true; signal.abort(); assert.equal(mayClose(), false); return null;
  } });
  assert.equal(await f.transport.finishBatch({ mayClose: () => empty }), null);
  assert.equal(f.calls.close, 0);
});

test('退出异常返回可读失败状态，不重试或关闭用户QQ', async t => {
  const f = fixture(t, { finish: () => { throw new Error('退出RPC失败'); } });
  const result = await f.transport.finishBatch();
  assert.equal(result.state, 'error'); assert.match(result.reason, /退出失败/u);
  assert.equal(f.calls.finish.length, 1); assert.equal(f.calls.close, 0);
});
