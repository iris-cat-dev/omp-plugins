import { defineRpc } from '@omp-desktop/plugin';
import { z } from 'zod';

export const nativeRequestId = z.string().length(32).regex(/^[0-9a-f]{32}$/).refine(value => value !== '0'.repeat(32));
export const config = z.object({
  accountId: z.string().regex(/^wxid_[A-Za-z0-9_-]{1,120}$/),
  bindingPath: z.string().min(1).max(4096), pythonPath: z.string().min(1).max(4096),
  targets: z.array(z.string().regex(/^(?:wxid_[A-Za-z0-9_-]{1,120}|[0-9]{1,100}@chatroom)$/)).min(1).max(256),
  model: z.string().regex(/^omp\/[^/\s]+\/[^\s]+$/)
}).strict().superRefine((v, ctx) => {
  if (new Set(v.targets).size !== v.targets.length || v.targets.includes(v.accountId)) ctx.addIssue({ code: 'custom', message: '会话不能重复或等于账号' });
});
export const status = defineRpc({ name: 'wechat.status', input: z.object({}).strict(), output: z.object({ config: config.nullable(), state: z.string(), reason: z.string().nullable(), mode: z.string() }).strict() });
export const save = defineRpc({ name: 'wechat.save', input: config, output: z.object({ saved: z.literal(true) }).strict() });
export const action = defineRpc({ name: 'wechat.action', input: z.object({ operation: z.enum(['start', 'stop']) }).strict(), output: z.object({ state: z.string(), reason: z.string().nullable() }).strict() });
export const models = defineRpc({ name: 'wechat.models', input: z.object({}).strict(), output: z.array(z.object({ id: z.string(), name: z.string() }).strict()) });
export const unknownSends = defineRpc({ name: 'wechat.unknown-sends', input: z.object({}).strict(), output: z.array(z.object({ id: nativeRequestId, peer: z.string(), kind: z.enum(['text', 'image']), createdAt: z.number().nullable(), summary: z.string().nullable() }).strict()) });
export const reviewSend = defineRpc({ name: 'wechat.review-send', input: z.object({ id: nativeRequestId, confirmed: z.literal(true) }).strict(), output: z.object({ closed: z.literal(true) }).strict() });
export const interruptedMessages = defineRpc({ name: 'wechat.interrupted-messages', input: z.object({}).strict(), output: z.array(z.object({ seq: z.number().int().positive().safe(), peer: z.string(), message: z.string(), submittedParts: z.number().int().nonnegative() }).strict()) });
export const closeInterrupted = defineRpc({ name: 'wechat.close-interrupted', input: z.object({ seq: z.number().int().positive().safe(), confirmed: z.literal(true) }).strict(), output: z.object({ closed: z.literal(true) }).strict() });
export const imageSend = defineRpc({ name: 'wechat.image-send', input: z.object({ target: z.string().min(1).max(256), path: z.string().min(1).max(4096), confirmed: z.literal(true) }).strict(), output: z.object({ requestId: nativeRequestId }).strict() });
export const generateBinding = defineRpc({ name: 'wechat.generate-binding', input: z.object({ id: nativeRequestId, accountId: z.string().regex(/^wxid_[A-Za-z0-9_-]{1,120}$/), pid: z.number().int().positive().safe(), contactDatabase: z.string().min(1).max(4096), pythonPath: z.string().min(1).max(4096) }).strict(), output: z.object({ bindingPath: z.string() }).strict() });
export const cancelBinding = defineRpc({ name: 'wechat.cancel-binding', input: z.object({ id: nativeRequestId }).strict(), output: z.object({ canceled: z.literal(true) }).strict() });
