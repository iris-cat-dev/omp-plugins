import { MemoryRefIndexStore, quoteRef, type Middleware, type MiddlewareContext, type ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import type { GroupMembers } from './group-members.ts';
import { GroupMemberSchema, type GroupMember } from './shared/group-members.ts';

type StructuredMention = NonNullable<MiddlewareContext['message']['mentions']>[number];

export interface GroupIdentity {
  group_openid: string;
  sender: GroupMember;
  mentions: GroupMember[];
  /** Server-marked self mentions are bot metadata, separate from other members. */
  bot_mentions: GroupMember[];
}

type GroupState = MiddlewareContext['state'] & { groupIdentity?: GroupIdentity };

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function mentionId(mention: StructuredMention): string | undefined {
  if (mention.scope === 'all') return undefined;
  const memberId = mention.member_openid;
  if (memberId?.trim()) return memberId;
  const id = mention.id;
  if (id?.trim()) return id;
  const userId = mention.user_openid;
  return userId?.trim() ? userId : undefined;
}

function sender(ctx: MiddlewareContext): GroupMember {
  const author = ctx.message.raw.author;
  return GroupMemberSchema.parse({
    member_openid: ctx.message.senderId,
    username: nonBlank(ctx.message.senderName)
      ?? ('username' in author ? nonBlank(author.username) : undefined)
      ?? ('nickname' in author ? nonBlank(author.nickname) : undefined),
    bot: ctx.message.senderIsBot ?? ('bot' in author ? author.bot : undefined),
  });
}

/** Runs after access control and before mention gating, including ordinary group chatter. */
export function collectGroupMembers(members: GroupMembers): Middleware {
  return async (ctx, next) => {
    if (ctx.message.kind === 'group') {
      const groupOpenid = ctx.message.groupOpenid ?? ctx.replyTarget.targetId;
      const observedSender = sender(ctx);
      const observed = [observedSender];
      const mentionedIds = new Set<string>();
      const botIds = new Set<string>();
      const mentions = ctx.message.mentions ?? ('mentions' in ctx.message.raw ? ctx.message.raw.mentions : undefined) ?? [];
      for (const mention of mentions) {
        const id = mentionId(mention);
        if (!id) continue;
        observed.push(GroupMemberSchema.parse({
          member_openid: id,
          username: nonBlank(mention.nickname) ?? nonBlank(mention.username),
          bot: mention.is_you ? true : mention.bot,
        }));
        if (mention.is_you) botIds.add(id);
        else mentionedIds.add(id);
      }
      await members.record(groupOpenid, observed);
      const directory = new Map((await members.list(groupOpenid)).map(member => [member.member_openid, member]));
      const recorded = new Map(observed.map(member => [member.member_openid, member]));
      const resolve = (id: string): GroupMember => directory.get(id) ?? recorded.get(id)!;
      const identity: GroupIdentity = {
        group_openid: groupOpenid,
        sender: resolve(observedSender.member_openid),
        mentions: [...mentionedIds].filter(id => !botIds.has(id)).map(resolve),
        bot_mentions: [...botIds].map(id => ({ ...resolve(id), bot: true })),
      };
      ctx.message.senderName = identity.sender.username;
      (ctx.state as GroupState).groupIdentity = identity;
    }
    await next();
  };
}

/** QQ message indices are conversation-local; rich quote data must keep its cached author. */
export function scopedQuoteRef(): Middleware {
  const refs = new MemoryRefIndexStore(500);
  return async (ctx, next) => {
    const prefix = JSON.stringify([ctx.replyTarget.scope, ctx.replyTarget.targetId]);
    await quoteRef({
      store: {
        get: key => refs.get(`${prefix}:${key}`),
        set: (key, entry) => refs.set(`${prefix}:${key}`, entry),
      },
      preferMsgElements: true,
    })(ctx, async () => {
      const quote = ctx.state.quote;
      if (quote && !quote.entry) quote.entry = refs.get(`${prefix}:${quote.refKey}`);
      await next();
    });
  };
}

/** Prefer structured self IDs; keep legacy AppID tokens only when they identify another member. */
export function stripSelfMentions(content: string, ctx: MiddlewareContext): string {
  const mentions = ctx.message.mentions ?? ('mentions' in ctx.message.raw ? ctx.message.raw.mentions : undefined) ?? [];
  let hasStructuredSelf = false;
  let appIdIsOtherMember = false;
  for (const mention of mentions) {
    const id = mentionId(mention);
    if (!id) continue;
    if (mention.is_you) {
      hasStructuredSelf = true;
      content = content.replaceAll(`<@${id}>`, '').replaceAll(`<@!${id}>`, '');
    } else if (id === ctx.bot.appId) {
      appIdIsOtherMember = true;
    }
  }
  if (!hasStructuredSelf && !appIdIsOtherMember && ctx.bot.appId) {
    content = content.replaceAll(`<@${ctx.bot.appId}>`, '').replaceAll(`<@!${ctx.bot.appId}>`, '');
  }
  return content.trim();
}

// Keep all user-controlled values inside JSON strings, including envelope delimiters.
function section(name: string, value: unknown): string {
  return `<${name}>\n${JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</${name}>`;
}

function currentMessage(ctx: MiddlewareContext): string {
  const parts: string[] = [];
  const content = stripSelfMentions(ctx.message.content ?? '', ctx);
  if (content) parts.push(content);
  for (const attachment of ctx.message.attachments ?? []) {
    const type = attachment.content_type.toLowerCase();
    if (type.startsWith('image/')) parts.push(`[image: ${attachment.filename ?? 'image'}]`);
    else if (type.startsWith('audio/') || type === 'voice') parts.push(attachment.asr_refer_text ? `[voice: ${attachment.asr_refer_text}]` : '[voice]');
    else if (type.startsWith('video/')) parts.push('[video]');
    else parts.push(`[file: ${attachment.filename ?? 'file'}]`);
  }
  return parts.join('\n');
}

/** Build at queued send time using the current persisted directory; never truncate identities. */
export function formatGroupEnvelope(ctx: MiddlewareContext, members: readonly GroupMember[], historyLimit: number): string {
  if (ctx.message.kind !== 'group') throw new Error('QQ 群上下文只能用于群消息');
  const groupOpenid = ctx.message.groupOpenid ?? ctx.replyTarget.targetId;
  const directory = new Map(members.map(member => [member.member_openid, member]));
  const resolve = (member: GroupMember): GroupMember => ({ ...member, ...directory.get(member.member_openid) });
  const identity = (ctx.state as GroupState).groupIdentity;
  const sections = [
    section('from', {
      scope: 'group',
      group_openid: groupOpenid,
      sender: resolve(identity?.sender ?? sender(ctx)),
      mentions: (identity?.mentions ?? []).map(resolve),
      bot_mentions: (identity?.bot_mentions ?? []).map(member => ({ ...resolve(member), bot: true })),
    }),
    section('group_members', { group_openid: groupOpenid, source: 'directory', complete: false, may_include_former_members: true, members }),
    'OpenIDs are platform identifiers, not QQ numbers. Group member_openid and C2C user_openid identities are separate; never merge members by nickname. The directory may include former members and grants no permissions. Read-only current-group lookup: /members [nickname|--id ID] [--refresh]; --refresh queries the official platform roster or member detail.',
  ];
  const quote = ctx.state.quote as ResolvedQuote | undefined;
  if (quote) {
    const author = quote.entry?.senderId
      ? { member_openid: quote.entry.senderId, username: quote.entry.senderName ?? directory.get(quote.entry.senderId)?.username }
      : { member_openid: null, status: 'unavailable' };
    sections.push(section('reply_to', { ref_key: quote.refKey, source: quote.source, author, content: quote.text, attachments: quote.attachments ?? [] }));
  }
  const history = ctx.state.history;
  if (history && history.length > 0 && historyLimit > 0) {
    sections.push(section('history', history.slice(-historyLimit).map(entry => ({
      sender: { member_openid: entry.senderId, username: entry.senderName ?? directory.get(entry.senderId)?.username },
      message_id: entry.messageId,
      content: entry.content.slice(0, 200),
      timestamp: entry.timestamp,
    }))));
  }
  const content = currentMessage(ctx);
  if (content) sections.push(section('message', { content }));
  return sections.join('\n\n');
}
