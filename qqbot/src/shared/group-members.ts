import { z } from 'zod';

export const GroupOpenIdSchema = z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
const ProfileText = z.string().refine(value => !value.includes('\0'), 'QQ 群成员资料不能包含 NUL');
export const GroupMemberSchema = z.object({
  member_openid: GroupOpenIdSchema,
  username: ProfileText.optional(),
  member_role: z.enum(['member', 'owner', 'admin']).optional(),
  bot: z.boolean().optional(),
  joined_at: ProfileText.optional(),
  union_openid: ProfileText.optional(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;
export type GroupRole = NonNullable<GroupMember['member_role']>;

// z.record strips __proto__; parsing entries preserves that legitimate identity
// without ever assigning an untrusted key through Object.prototype's setter.
const GroupProfilesSchema = z.preprocess(value => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null,
  z.array(z.tuple([GroupOpenIdSchema, GroupMemberSchema]))).superRefine((entries, ctx) => {
  for (const [id, member] of entries) if (id !== member.member_openid) ctx.addIssue({ code: 'custom', message: '群成员目录 OpenID 与记录不匹配' });
}).transform(entries => Object.fromEntries(entries) as Record<string, GroupMember>);
const DirectoryKey = z.string().refine(value => {
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => GroupOpenIdSchema.safeParse(part).success);
  } catch { return false; }
}, '群成员目录账号/群键无效');
export const GroupDirectorySchema = z.preprocess(value => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null,
  z.array(z.tuple([DirectoryKey, GroupProfilesSchema]))).transform(entries => Object.fromEntries(entries) as Record<string, Record<string, GroupMember>>);

export const GroupMemberFiltersSchema = z.object({ nickname: z.string().optional(), member_openid: GroupOpenIdSchema.optional() }).strict();
export const GroupMemberQuerySchema = GroupMemberFiltersSchema.extend({ refresh: z.boolean().optional() });
export const GroupRosterPageSchema = z.object({ members: z.array(GroupMemberSchema), next_cursor: z.string() });
export const GroupMemberResultSchema = z.object({
  group_openid: GroupOpenIdSchema,
  members: z.array(GroupMemberSchema),
  source: z.enum(['directory', 'platform']),
  complete: z.boolean(),
  platform_error: z.object({ code: z.number().int(), message: z.string() }).strict().optional(),
}).strict();
export type GroupMemberFilters = z.infer<typeof GroupMemberFiltersSchema>;
export type GroupMemberQuery = z.infer<typeof GroupMemberQuerySchema>;
export type GroupMemberResult = z.infer<typeof GroupMemberResultSchema>;
