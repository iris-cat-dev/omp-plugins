import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQQSender } from './qq-sender.mjs';
import { createNotificationTransport } from './notification-transport.mjs';
import { ReminderController } from './reminder-core.mjs';
import { createReminderStore } from './reminder-store.mjs';
import { status, configure, testReminder } from './rpc.mjs';

export default async function register(context) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share');
  const dataDirectory = path.join(parent, 'OMP', 'wechat-ask-notifier', encodeURIComponent(context.installation.id));
  mkdirSync(dataDirectory, { recursive: true });
  const store = createReminderStore(path.join(dataDirectory, 'reminders.sqlite'));
  const sender = createNotificationTransport({
    qq: createQQSender({ packageRoot, dataDirectory, signal: context.signal }),
    signal: context.signal
  });
  const controller = new ReminderController({ omp: context.omp, sender, store, signal: context.signal });
  const read = () => ({ ...controller.read(), mode: context.mode });
  const active = () => {
    context.signal.throwIfAborted();
    if (context.mode !== 'active') throw new Error('请先在 OMP 插件管理中启用本插件，再打开 QQ 提醒。');
  };
  try {
    if (context.mode === 'active') await controller.start();
    context.handle(status, read);
    context.handle(configure, (settings) => { active(); controller.configure(settings); return read(); });
    context.handle(testReminder, async () => { active(); await controller.test(); return read(); });
  } catch (error) {
    try { await controller.close(); } finally { store.close(); }
    throw error;
  }
  return async () => { try { await controller.close(); } finally { store.close(); } };
}
export { register as manage };
