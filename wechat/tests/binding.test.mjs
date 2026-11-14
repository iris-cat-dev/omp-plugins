import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBinding } from '../src/binding.mjs';
import { BindingManager } from '../src/binding-manager.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wechat-binding-'));
  const contactDir = path.join(dir, 'db_storage', 'contact'); await mkdir(contactDir, { recursive: true });
  const contact = path.join(contactDir, 'contact.db'); await writeFile(contact, 'fixture');
  try { await fn(dir, contact); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('显式输入交给绑定 CLI，回读匹配账号、进程与选定数据库', async () => fixture(async (dir, contact) => {
  const calls = [];
  const spawnProcess = (python, args, options) => {
    calls.push({ python, args, options });
    const child = new EventEmitter(); child.kill = () => true;
    const get = key => args[args.indexOf(key) + 1];
    setImmediate(async () => { await writeFile(get('--output'), JSON.stringify({ accountId: get('--account-id'), pid: Number(get('--pid')), createdAtMs: 123, contactDatabaseFiles: [contact] }), { flag: 'wx' }); child.emit('close', 0); });
    return child;
  };
  const options = { root: dir, directory: path.join(dir, 'private'), pythonPath: path.join(dir, 'python'), accountId: 'wxid_bot', pid: 42, contactDatabase: contact, signal: new AbortController().signal, spawnProcess };
  const first = await createBinding(options), second = await createBinding(options);
  assert.notEqual(first.bindingPath, second.bindingPath);
  assert.equal(JSON.parse(await readFile(first.bindingPath, 'utf8')).accountId, 'wxid_bot');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-B', path.join(dir, 'bridge', 'create_binding.py')]);
  assert.ok(calls[0].args.includes('--allow-read')); assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore']);
}));

test('取消会结束自有进程且不会返回绑定路径', async () => fixture(async (dir, contact) => {
  const controller = new AbortController(); let killed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.kill = () => { killed = true; setImmediate(() => child.emit('close', null)); return true; };
    setImmediate(() => controller.abort()); return child;
  };
  await assert.rejects(createBinding({ root: dir, directory: dir, pythonPath: path.join(dir, 'python'), accountId: 'wxid_bot', pid: 42, contactDatabase: contact, signal: controller.signal, spawnProcess }), /取消/);
  assert.equal(killed, true);
}));

test('先到达的取消请求阻止生成，关闭期间抑制成功', async () => {
  const signal = new AbortController(); let invoked = 0, finish;
  const manager = new BindingManager({ root: 'unused', directory: 'unused', signal: signal.signal, create: () => { invoked++; return new Promise(resolve => { finish = resolve; }); } });
  const id = 'a'.repeat(32); manager.cancel(id);
  await assert.rejects(manager.run({ id }), /取消/); assert.equal(invoked, 0);
  const work = manager.run({ id: 'b'.repeat(32) });
  const closing = manager.close(); finish({ bindingPath: 'fixture' });
  await assert.rejects(work); await closing;
});

test('CLI 失败和不匹配绑定均不回填路径', async () => fixture(async (dir, contact) => {
  const base = { root: dir, directory: dir, pythonPath: path.join(dir, 'python'), accountId: 'wxid_bot', pid: 42, contactDatabase: contact, signal: new AbortController().signal };
  const fail = () => { const child = new EventEmitter(); child.kill = () => true; setImmediate(() => child.emit('close', 1)); return child; };
  await assert.rejects(createBinding({ ...base, spawnProcess: fail }), /未通过/);
  const mismatch = (_python, args) => { const child = new EventEmitter(); child.kill = () => true; setImmediate(async () => { await writeFile(args[args.indexOf('--output') + 1], JSON.stringify({ accountId: 'wxid_other', pid: 42, createdAtMs: 123, contactDatabaseFiles: [contact] })); child.emit('close', 0); }); return child; };
  await assert.rejects(createBinding({ ...base, spawnProcess: mismatch }), /不符/);
}));
