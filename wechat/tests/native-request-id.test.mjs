import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.mjs';
import { nativeRequestId } from '../src/rpc.mjs';

const worker = fileURLToPath(new URL('../bridge/worker.py', import.meta.url));
test('真实离线 worker 接受文本和图片编号并拒绝边界值', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-id-'));
  const state = path.join(dir, 'native'), media = path.join(dir, 'media'), engine = path.join(dir, 'engine');
  for (const folder of [state, media, engine]) mkdirSync(folder);
  const journal = new Journal(path.join(dir, 'journal.sqlite'), 'wxid_bot');
  try {
    const event = { accountId: 'wxid_bot', scope: 'private', sessionId: 'wxid_peer', senderId: 'wxid_peer', senderName: '用户', messageId: '1', createdAtMs: 1, text: 'hi', mentions: [] };
    journal.ingest([event], ['wxid_peer']);
    const row = journal.claim();
    const textId = journal.prepareText(row.seq, 'wxid_peer', ['hello'])[0].id;
    const imageId = journal.beginImage('wxid_peer');
    const valid = [textId, imageId, 'f'.repeat(32), '0'.repeat(31) + '1'];
    const invalid = ['0'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'a'.repeat(31) + '-', 'a'.repeat(32) + '\n', ''];
    for (const value of valid) assert.equal(nativeRequestId.safeParse(value).success, true);
    for (const value of invalid) assert.equal(nativeRequestId.safeParse(value).success, false);
    const values = [...valid, ...invalid];
    const frames = values.map((value, index) => JSON.stringify({ id: `q${index}`, method: 'submission', params: { requestId: value } })).join('\n') + '\n';
    const result = spawnSync(process.env.WECHAT_TEST_PYTHON || 'python', ['-B', worker, '--account-id', 'wxid_bot', '--state-dir', state, '--media-root', media, '--engine-dir', engine], { input: frames, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, values.length);
    for (let i = 0; i < valid.length; i++) assert.deepEqual(replies[i], { id: `q${i}`, result: { found: false } });
    for (let i = valid.length; i < values.length; i++) assert.equal(replies[i].error?.code, 'invalid_params');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
