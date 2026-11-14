import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { accountDirectory, revokeSavedSessions } from '../src/config-transition.mjs';

test('连续保存移除再添加会话不会恢复排队消息', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-revoke-'));
  const file = path.join(accountDirectory(dir, 'wxid_bot'), 'journal.sqlite');
  const original = { accountId: 'wxid_bot', targets: ['wxid_peer', 'wxid_other'] };
  const removed = { accountId: 'wxid_bot', targets: ['wxid_other'] };
  let j = new Journal(file, original.accountId);
  try {
    j.ingest([{ accountId: 'wxid_bot', scope: 'private', sessionId: 'wxid_peer', senderId: 'wxid_peer', senderName: '用户', messageId: '1', createdAtMs: 1, text: 'hi', mentions: [] }], original.targets);
    j.close(); j = null;
    revokeSavedSessions(dir, original, removed);
    revokeSavedSessions(dir, removed, original);
    j = new Journal(file, original.accountId);
    assert.equal(j.claim(), null);
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('待核对发送阻止切换账号', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-switch-'));
  let j = new Journal(path.join(accountDirectory(dir, 'wxid_bot'), 'journal.sqlite'), 'wxid_bot');
  try {
    j.beginImage('wxid_peer'); j.close(); j = null;
    assert.throws(() => revokeSavedSessions(dir, { accountId: 'wxid_bot', targets: ['wxid_peer'] }, { accountId: 'wxid_new', targets: ['wxid_peer'] }));
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('中断消息先人工关闭才能切换账号', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-switch-interrupted-'));
  const file = path.join(accountDirectory(dir, 'wxid_bot'), 'journal.sqlite');
  const previous = { accountId: 'wxid_bot', targets: ['wxid_peer'] }, next = { accountId: 'wxid_new', targets: ['wxid_peer'] };
  let j = new Journal(file, previous.accountId);
  try {
    j.ingest([{ accountId: 'wxid_bot', scope: 'private', sessionId: 'wxid_peer', senderId: 'wxid_peer', senderName: '用户', messageId: '1', createdAtMs: 1, text: 'hi', mentions: [] }], previous.targets);
    const row = j.claim();
    j.close(); j = null;
    assert.throws(() => revokeSavedSessions(dir, previous, next));
    j = new Journal(file, previous.accountId);
    j.closeInterrupted(row.seq);
    j.close(); j = null;
    revokeSavedSessions(dir, previous, next);
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});
