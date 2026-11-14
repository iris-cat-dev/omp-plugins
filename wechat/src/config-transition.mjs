import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Journal } from './journal.mjs';

export function accountDirectory(directory, accountId) {
  return path.join(directory, createHash('sha256').update(accountId).digest('hex'));
}

/** Revoke before persisting the new configuration; a failed save remains conservative. */
export function revokeSavedSessions(directory, previous, next) {
  if (!previous) return;
  const filename = path.join(accountDirectory(directory, previous.accountId), 'journal.sqlite');
  if (!existsSync(filename)) return;
  const journal = new Journal(filename, previous.accountId);
  try {
    if (previous.accountId !== next.accountId && (journal.hasUnknownSend() || journal.interruptedMessages().length)) throw new Error('当前账号有未核对的发送或中断消息，请先处理再切换账号');
    journal.revokeExcept(previous.accountId === next.accountId ? next.targets : []);
  } finally { journal.close(); }
}
