import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { submitImage, closeReviewedSend } from '../src/outbound.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wechat-send-'));
  const journal = new Journal(path.join(dir, 'journal.sqlite'), 'wxid_bot');
  try { await fn(dir, journal); } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('图片绑定目标并先准备后持久登记后提交', async () => fixture(async (dir, journal) => {
  const source = path.join(dir, 'input'); await writeFile(source, 'image bytes');
  const calls = [];
  const bridge = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'prepare_image') { assert.equal(params.targetId, 'wxid_peer'); assert.equal(await readFile(params.path, 'utf8'), 'image bytes'); return { assetId: 'a'.repeat(32) }; }
    assert.equal(method, 'submit_image'); assert.equal(journal.unknownSends()[0].id, params.requestId);
    assert.equal(params.targetId, 'wxid_peer'); assert.equal(params.assetId, 'a'.repeat(32));
    return { requestId: params.requestId, status: 'submitted' };
  } };
  await submitImage({ bridge, journal, target: 'wxid_peer', source, directory: dir, current: () => true });
  assert.deepEqual(calls.map(x => x.method), ['prepare_image', 'submit_image']);
  assert.deepEqual(journal.unknownSends(), []);
}));

test('提交超时保留未知状态，人工核对封口不会发送', async () => fixture(async (dir, journal) => {
  const source = path.join(dir, 'input'); await writeFile(source, 'image bytes');
  let calls = [];
  const bridge = { async request(method, params) {
    calls.push(method);
    if (method === 'prepare_image') return { assetId: 'a'.repeat(32) };
    if (method === 'submit_image') throw new Error('timeout');
    if (method === 'submission') return { found: true, requestId: params.requestId, targetId: 'wxid_peer', kind: 'image', status: 'unknown', reviewed: false };
    if (method === 'acknowledge') { assert.equal(params.resolution, 'checked_no_retry'); return { requestId: params.requestId, status: 'unknown', reviewed: true }; }
    throw new Error('unexpected request');
  } };
  await assert.rejects(submitImage({ bridge, journal, target: 'wxid_peer', source, directory: dir, current: () => true }), e => e.sendUnknown === true);
  const row = journal.unknownSends()[0]; assert.equal(row.peer, 'wxid_peer');
  calls = []; await closeReviewedSend({ bridge, journal, row });
  assert.deepEqual(calls, ['submission', 'acknowledge']); assert.deepEqual(journal.unknownSends(), []);
}));

test('原生记录目标不符不得封口；准备后撤权不得提交', async () => fixture(async (dir, journal) => {
  const source = path.join(dir, 'input'); await writeFile(source, 'image bytes');
  const id = journal.beginImage('wxid_peer');
  const row = journal.unknownSends()[0];
  await assert.rejects(closeReviewedSend({ bridge: { request: async () => ({ found: true, requestId: id, targetId: 'wxid_other', kind: 'image', status: 'unknown', reviewed: false }) }, journal, row }), /不符/);
  assert.equal(journal.unknownSends().length, 1);
  let current = true; const methods = [];
  const bridge = { async request(method) { methods.push(method); current = false; return { assetId: 'a'.repeat(32) }; } };
  await assert.rejects(submitImage({ bridge, journal, target: 'wxid_peer', source, directory: dir, current: () => current }), /停止/);
  assert.deepEqual(methods, ['prepare_image']);
  assert.equal(journal.unknownSends().length, 1);
}));

test('核对期间停止时不会登记本地封口', async () => fixture(async (_dir, journal) => {
  journal.beginImage('wxid_peer', 'photo.png');
  const row = journal.unknownSends()[0];
  let current = true;
  const bridge = { async request(method, params) {
    assert.equal(method, 'submission');
    current = false;
    return { found: true, requestId: params.requestId, targetId: row.peer, kind: row.kind, status: 'unknown', reviewed: false };
  } };
  await assert.rejects(closeReviewedSend({ bridge, journal, row, current: () => current }), /取消/);
  assert.equal(journal.unknownSends().length, 1);
}));

test('原生不存在记录时，明确人工封口仍保留不重发结论', async () => fixture(async (_dir, journal) => {
  journal.beginImage('wxid_peer', 'photo.png');
  const calls = [];
  await closeReviewedSend({ bridge: { async request(method) { calls.push(method); return { found: false }; } }, journal, row: journal.unknownSends()[0] });
  assert.deepEqual(calls, ['submission']);
  assert.equal(journal.hasUnknownSend(), false);
}));
