import { defineRpc } from '@omp-desktop/plugin';
import { z } from 'zod';

const empty = z.object({}).strict();
const targetMode = z.enum(['phone', 'pad', 'both']);
const connection = z.object({
  state: z.enum(['ready', 'not_logged_in', 'unsupported', 'multiple_accounts', 'not_installed', 'login_timeout', 'error']),
  reason: z.string().nullable(), accountId: z.string().nullable(), version: z.string().nullable(),
}).strict();
const outcome = z.object({ state: z.string(), reason: z.string().nullable() }).strict();
const snapshot = z.object({
  enabled: z.boolean(), targetMode, mode: z.string(), connection: connection.nullable(),
  lastAttempt: z.object({
    at: z.number(), state: z.string(), reason: z.string().nullable(), agentTitle: z.string().nullable(),
    targets: z.object({ phone: outcome.optional(), pad: outcome.optional() }).strict(),
  }).strict().nullable(),
  pendingCount: z.number().int().nonnegative(), error: z.string().nullable(),
}).strict();
const settings = z.object({ enabled: z.boolean().optional(), targetMode: targetMode.optional() }).strict()
  .refine(value => Object.keys(value).length > 0, '请提供要修改的提醒设置。');
export const status = defineRpc({ name: 'wechat-ask-notifier.status', input: empty, output: snapshot });
export const configure = defineRpc({ name: 'wechat-ask-notifier.configure', input: settings, output: snapshot });
export const testReminder = defineRpc({ name: 'wechat-ask-notifier.test', input: empty, output: snapshot });
