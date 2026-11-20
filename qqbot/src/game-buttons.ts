import { randomUUID } from 'node:crypto';
import timers from 'node:timers';
import { z } from 'zod';
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { GameChoice } from './game-api.ts';
import type { ReplyTarget } from './types.ts';

const ButtonSchema = z.discriminatedUnion('a', [
  z.object({ t: z.literal('game'), g: z.number().int(), n: z.string(), a: z.literal('choose'), i: z.number().int().nonnegative() }).strict(),
  z.object({ t: z.literal('game'), g: z.number().int(), n: z.string(), a: z.literal('page'), p: z.number().int().nonnegative() }).strict(),
]);
export interface GameButtonBinding {
  scope: 'group' | 'c2c';
  openid: string;
  senderId: string;
  route: object;
  turnId?: string;
  gameState: string;
}
interface Menu {
  binding: GameButtonBinding;
  choices: GameChoice[];
  nonce: string;
  page: number;
  expiresAt: number;
  claimed: boolean;
  timer: number | NodeJS.Timeout;
}
export interface GameButtonClaim {
  menu: Menu;
  action: z.infer<typeof ButtonSchema>;
}
const key = (binding: Pick<GameButtonBinding, 'scope' | 'openid' | 'senderId'>) => JSON.stringify([binding.scope, binding.openid, binding.senderId]);
const pageSize = (menu: Menu) => menu.choices.length > 10 ? 8 : 10;
const pages = (menu: Menu) => Math.ceil(menu.choices.length / pageSize(menu));
const shortLabel = (label: string) => { const text = Array.from(label.trim()); return text.length > 10 ? text.slice(0, 9).join('') + '…' : text.join(''); };
const READ_ONLY_NAV_COMMAND = /^坊市查询(?:\s+全部)?(?:\s+\d+)?$/u;

/** Only trusted host/engine choices enter this registry; callbacks contain no executable command. */
export class GameButtons {
  private menus = new Map<string, Menu>();
  constructor(private generation: number, private signal: AbortSignal, private timeoutMs: number) {}

  show(binding: GameButtonBinding, choices: readonly GameChoice[]): GameButtonClaim {
    this.cancel(binding);
    const menu: Menu = {
      binding, choices: choices.map(choice => ({ ...choice })), nonce: randomUUID(), page: 0,
      expiresAt: Date.now() + this.timeoutMs, claimed: false,
      timer: timers.setTimeout(() => this.cancelMenu(menu), this.timeoutMs),
    };
    this.menus.set(key(binding), menu);
    return { menu, action: { t: 'game', g: this.generation, n: menu.nonce, a: 'page', p: 0 } };
  }

  claim(event: InteractionEvent, value: unknown): GameButtonClaim | null {
    if (this.signal.aborted || event.type !== 11 || event.data?.type !== 11 || !event.id) return null;
    const scope = event.scene;
    if (scope !== 'group' && scope !== 'c2c') return null;
    if (event.chat_type !== undefined && event.chat_type !== (scope === 'group' ? 1 : 2)) return null;
    if (event.guild_id || event.channel_id) return null;
    const openid = scope === 'group' ? event.group_openid : event.user_openid;
    const senderId = scope === 'group' ? event.group_member_openid : event.user_openid;
    if (!openid || !senderId || (scope === 'c2c' && (event.group_openid || event.group_member_openid))) return null;
    const parsed = ButtonSchema.safeParse(value);
    if (!parsed.success) return null;
    const action = parsed.data;
    const menu = this.menus.get(key({ scope, openid, senderId }));
    if (!menu || !this.current(menu) || menu.claimed || action.g !== this.generation || action.n !== menu.nonce) return null;
    if (action.a === 'choose') {
      const start = menu.page * pageSize(menu);
      if (!menu.choices[action.i] || action.i < start || action.i >= start + pageSize(menu)) return null;
    } else if (action.p >= pages(menu) || Math.abs(action.p - menu.page) !== 1) return null;
    menu.claimed = true;
    return { menu, action };
  }

  valid(claim: GameButtonClaim, binding: GameButtonBinding): boolean {
    const saved = claim.menu.binding;
    if (!this.current(claim.menu) || saved.route !== binding.route || key(saved) !== key(binding)) return false;
    if (claim.action.a === 'page') return true;
    const command = claim.menu.choices[claim.action.i]?.command;
    if (command && READ_ONLY_NAV_COMMAND.test(command)) return true;
    return saved.turnId === binding.turnId && saved.gameState === binding.gameState;
  }

  consume(claim: GameButtonClaim): string {
    if (claim.action.a !== 'choose' || !this.current(claim.menu)) throw new Error('游戏选项已失效');
    const command = claim.menu.choices[claim.action.i]!.command;
    this.cancelMenu(claim.menu);
    return command;
  }

  page(claim: GameButtonClaim, latestBinding?: GameButtonBinding): void {
    if (claim.action.a !== 'page' || !this.current(claim.menu)) throw new Error('游戏选项已失效');
    claim.menu.page = claim.action.p;
    claim.menu.nonce = randomUUID();
    claim.menu.claimed = false;
    if (latestBinding && latestBinding.gameState === claim.menu.binding.gameState) {
      claim.menu.binding.turnId = latestBinding.turnId;
    }
    timers.clearTimeout(claim.menu.timer);
    claim.menu.expiresAt = Date.now() + this.timeoutMs;
    claim.menu.timer = timers.setTimeout(() => this.cancelMenu(claim.menu), this.timeoutMs);
  }

  release(claim: GameButtonClaim): void {
    if (this.current(claim.menu)) claim.menu.claimed = false;
  }

  keyboard(claim: GameButtonClaim): InlineKeyboard {
    const menu = claim.menu;
    const data = (extra: object) => JSON.stringify({ t: 'game', g: this.generation, n: menu.nonce, ...extra });
    const permission = { type: 0, specify_user_ids: [menu.binding.senderId] };
    const button = (label: string, value: string, id: string, unsupportedTips: string) => ({
      id: `${menu.nonce}-${id}`,
      render_data: { label: shortLabel(label), visited_label: '已选', style: 1 },
      action: { type: 1, permission, data: value, unsupport_tips: unsupportedTips },
    });
    const start = menu.page * pageSize(menu);
    const buttons = menu.choices.slice(start, start + pageSize(menu)).map((choice, offset) => {
      const i = start + offset;
      return button(choice.label, data({ a: 'choose', i }), String(i), `请发送：${choice.command}`);
    });
    const rows: InlineKeyboard['content']['rows'] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push({ buttons: buttons.slice(i, i + 2) });
    if (pages(menu) > 1) {
      const navigation = [];
      if (menu.page > 0) navigation.push(button('上一页', data({ a: 'page', p: menu.page - 1 }), 'prev', '请直接输入游戏指令'));
      if (menu.page + 1 < pages(menu)) navigation.push(button('下一页', data({ a: 'page', p: menu.page + 1 }), 'next', '请直接输入游戏指令'));
      rows.push({ buttons: navigation });
    }
    return { content: { rows } };
  }

  pageText(claim: GameButtonClaim): string {
    const menu = claim.menu;
    const size = pageSize(menu);
    const start = menu.page * size;
    const slice = menu.choices.slice(start, start + size);
    const entries = slice.map((choice, offset) => `${start + offset + 1}. ${choice.label}${choice.label === choice.command ? '' : `（${choice.command}）`}`);
    return `第${menu.page + 1}/${pages(menu)}页（共${menu.choices.length}项）\n${entries.join('\n')}`;
  }

  text(claim: GameButtonClaim, requireMention: boolean): string {
    const menu = claim.menu;
    const entries = menu.choices.map((choice, i) => `${i + 1}. ${choice.label}${choice.label === choice.command ? '' : ` · ${choice.command}`}`);
    return `快捷指令：\n${entries.join('\n')}\n发送对应指令${menu.binding.scope === 'group' && requireMention ? '（需 @机器人）' : ''}；也可自由输入。`;
  }

  target(claim: GameButtonClaim, eventId: string): ReplyTarget {
    const binding = claim.menu.binding;
    return { scope: binding.scope, targetId: binding.openid, eventId: `INTERACTION_CREATE:${eventId}`,
      ...(binding.scope === 'group' ? { mentionUserId: binding.senderId } : {}) };
  }

  cancel(binding: Pick<GameButtonBinding, 'scope' | 'openid' | 'senderId'>): void {
    const menu = this.menus.get(key(binding));
    if (menu) this.cancelMenu(menu);
  }
  discard(claim: GameButtonClaim): void { this.cancelMenu(claim.menu); }
  cancelRoute(route: object): void { for (const menu of this.menus.values()) if (menu.binding.route === route) this.cancelMenu(menu); }
  private current(menu: Menu): boolean { return !this.signal.aborted && menu.expiresAt > Date.now() && this.menus.get(key(menu.binding)) === menu; }
  private cancelMenu(menu: Menu): void { timers.clearTimeout(menu.timer); if (this.menus.get(key(menu.binding)) === menu) this.menus.delete(key(menu.binding)); }
  dispose(): void { for (const menu of this.menus.values()) timers.clearTimeout(menu.timer); this.menus.clear(); }
}
