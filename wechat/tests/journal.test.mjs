import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';

const account = 'wxid_bot', peer = 'wxid_friend', group = '123@chatroom';
const event = (sessionId, messageId) => ({ accountId: account, scope: sessionId === group ? 'group' : 'private', sessionId, senderId: sessionId === group ? 'wxid_member' : sessionId, senderName: '用户', messageId, createdAtMs: 1, text: 'hello', mentions: sessionId === group ? [account] : [] });
function fixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-journal-'));
  try { return fn(path.join(dir, 'journal.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('批次提交原子去重，冲突不前移', () => fixture(file => {
  const j = new Journal(file, account);
  try {
    j.ingest([event(peer, '1')], [peer]);
    j.ingest([event(peer, '1')], [peer]);
    assert.throws(() => j.ingest([event(peer, '2'), { ...event(peer, '1'), text: 'changed' }], [peer]), /Conflicting/);
    assert.equal(j.claim().event.messageId, '1');
    assert.equal(j.claim(), null);
  } finally { j.close(); }
}));

test('会话内顺序与会话间隔离，未知结果不能重放', () => fixture(file => {
  let j = new Journal(file, account);
  j.ingest([event(peer, '1'), event(peer, '2'), event(group, '3')], [peer, group]);
  const first = j.claim(); assert.equal(first.event.messageId, '1');
  const other = j.claim(); assert.equal(other.event.messageId, '3');
  const id = j.prepareText(first.seq, peer, ['reply'])[0].id;
  j.beginPart(id);
  j.finishWithoutSend(other.seq, 'failed');
  j.close();
  j = new Journal(file, account);
  try {
    assert.equal(j.claim(), null);
    assert.throws(() => j.beginPart(id));
    j.finishPart(id, 'submitted');
    assert.equal(j.claim().event.messageId, '2');
  } finally { j.close(); }
}));

test('拒绝非授权会话与错账号重开', () => fixture(file => {
  const j = new Journal(file, account);
  assert.throws(() => j.ingest([event(group, '1')], [peer]), /Unscoped/);
  j.close();
  assert.throws(() => new Journal(file, 'wxid_other'), /another account/);
}));

test('群聊只有明确提及机器人入队，全体提醒不会触发', () => fixture(file => {
  const j = new Journal(file, account);
  try {
    const ordinary = { ...event(group, '1'), mentions: [] };
    const everyone = { ...event(group, '2'), mentions: ['notify@all'] };
    const direct = event(group, '3');
    j.ingest([ordinary, everyone, direct, event(peer, '4')], [group, peer]);
    j.ingest([ordinary, everyone], [group, peer]);
    assert.equal(j.claim().event.messageId, '3');
    assert.equal(j.claim().event.messageId, '4');
    assert.equal(j.claim(), null);
  } finally { j.close(); }
}));

test('中断的消息经人工确认关闭后，同一会话继续且未发送的分段不会重放', () => fixture(file => {
  let j = new Journal(file, account);
  j.ingest([event(peer, '1'), event(peer, '2'), event(group, '3')], [peer, group]);
  const first = j.claim();
  const parts = j.prepareText(first.seq, peer, ['已提交', '未提交']);
  j.beginPart(parts[0].id);
  j.finishPart(parts[0].id, 'submitted');
  const other = j.claim();
  assert.equal(other.event.messageId, '3');
  j.finishWithoutSend(other.seq, 'failed');
  j.close();
  j = new Journal(file, account);
  try {
    assert.deepEqual(j.interruptedMessages(), [{ seq: first.seq, peer, message: 'hello', submittedParts: 1 }]);
    assert.equal(j.claim(), null);
    j.closeInterrupted(first.seq);
    assert.deepEqual(j.interruptedMessages(), []);
    assert.equal(j.db.prepare('SELECT state FROM text_parts WHERE id=?').get(parts[1].id).state, 'canceled');
    assert.throws(() => j.closeInterrupted(first.seq));
    assert.equal(j.claim().event.messageId, '2');
  } finally { j.close(); }
}));

test('存在未核对的发送时不能通过关闭中断消息绕过发送核对', () => fixture(file => {
  let j = new Journal(file, account);
  j.ingest([event(peer, '1'), event(peer, '2')], [peer]);
  const first = j.claim();
  const part = j.prepareText(first.seq, peer, ['待核对'])[0];
  j.beginPart(part.id);
  j.close();
  j = new Journal(file, account);
  try {
    assert.deepEqual(j.interruptedMessages(), []);
    assert.throws(() => j.closeInterrupted(first.seq));
    assert.equal(j.claim(), null);
    j.closeUnknown(part.id);
    assert.equal(j.claim().event.messageId, '2');
  } finally { j.close(); }
}));
