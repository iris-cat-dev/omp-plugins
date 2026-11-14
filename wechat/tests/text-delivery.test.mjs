import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { splitReply, deliverText } from '../src/text-delivery.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wechat-parts-'));
  const journal = new Journal(path.join(dir, 'journal.sqlite'), 'wxid_bot');
  try {
    const event = { accountId: 'wxid_bot', scope: 'private', sessionId: 'wxid_peer', senderId: 'wxid_peer', senderName: '用户', messageId: '1', createdAtMs: 1, text: 'hi', mentions: [] };
    journal.ingest([event], ['wxid_peer']);
    await fn(journal, journal.claim());
  } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('多字节和辅助平面字符分段可完整还原且不超原生边界', () => {
  const text = '字😀a'.repeat(2200), chunks = splitReply(text);
  assert.ok(chunks.length > 1);
  chunks.forEach(chunk => { assert.ok(Buffer.byteLength(chunk) <= 4094); assert.ok(chunk.length <= 2047); assert.equal(Buffer.from(chunk).toString('utf8'), chunk); });
  assert.equal(chunks.map(chunk => chunk.replace(/^（\d+\/\d+）\n/u, '')).join(''), text);
  assert.throws(() => splitReply('\ud800'), /Unicode/);
});

test('各段按顺序提交并分别持久保存回执', async () => fixture(async (journal, row) => {
  const text = '汉😀'.repeat(2500), sent = [];
  const bridge = { async request(method, params) {
    assert.equal(method, 'submit_text');
    assert.equal(journal.db.prepare('SELECT state FROM text_parts WHERE id=?').get(params.requestId).state, 'unknown');
    sent.push(params);
    return { requestId: params.requestId, status: 'submitted' };
  } };
  await deliverText({ journal, bridge, seq: row.seq, peer: 'wxid_peer', text, current: () => true });
  assert.ok(sent.length > 1);
  assert.equal(new Set(sent.map(value => value.requestId)).size, sent.length);
  assert.ok(journal.db.prepare('SELECT state FROM text_parts ORDER BY ordinal').all().every(item => item.state === 'submitted'));
  assert.equal(journal.db.prepare('SELECT state FROM inbox WHERE seq=?').get(row.seq).state, 'completed');
}));

test('中段结果未知后不发送余下分段，核对封口不会恢复', async () => fixture(async (journal, row) => {
  let calls = 0;
  const bridge = { async request(_method, params) { if (++calls === 2) throw new Error('timeout'); return { requestId: params.requestId, status: 'submitted' }; } };
  await assert.rejects(deliverText({ journal, bridge, seq: row.seq, peer: 'wxid_peer', text: '汉😀'.repeat(3000), current: () => true }), error => error.sendUnknown === true);
  assert.equal(calls, 2);
  const unknown = journal.unknownSends(); assert.equal(unknown.length, 1);
  journal.closeUnknown(unknown[0].id);
  const parts = journal.db.prepare('SELECT state FROM text_parts ORDER BY ordinal').all().map(item => item.state);
  assert.equal(parts[0], 'submitted'); assert.equal(parts[1], 'unknown');
  assert.ok(parts.slice(2).every(state => state === 'canceled'));
  assert.equal(journal.claim(), null);
}));
