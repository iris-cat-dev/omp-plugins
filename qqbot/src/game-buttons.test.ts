import { afterEach, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { GameButtons } from './game-buttons.ts';
import type { GameButtonBinding } from './game-buttons.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
const binding: GameButtonBinding = { scope: 'group', openid: 'group', senderId: 'player', route: {}, turnId: 'turn', gameState: '{"adventure":{"id":"story","revision":0}}' };
function fixture(generation = 9, count = 2) {
  const buttons = new GameButtons(generation, new AbortController().signal, 1000);
  cleanups.push(() => buttons.dispose());
  const menu = buttons.show(binding, Array.from({ length: count }, (_, i) => ({ label: `灵泉旁的第${i + 1}条路线`, command: `路线${i + 1}` })));
  const raw = buttons.keyboard(menu).content.rows[0]!.buttons[0]!.action.data;
  return { buttons, menu, raw };
}
function event(raw: string, patch: Partial<InteractionEvent> = {}): InteractionEvent {
  return { id: 'event', type: 11, scene: 'group', chat_type: 1, group_openid: 'group', group_member_openid: 'player', version: 1, data: { type: 11, resolved: { button_data: raw } }, ...patch };
}
function claim(buttons: GameButtons, value: InteractionEvent) {
  let data: unknown;
  try { data = JSON.parse(value.data.resolved.button_data ?? ''); } catch { data = null; }
  return buttons.claim(value, data);
}

it.each([
  { group_member_openid: 'another-player' },
  { group_openid: 'another-group' },
  { scene: 'c2c', user_openid: 'player' },
  { scene: 'guild', guild_id: 'guild' },
  { chat_type: 2 },
  { type: 12 },
])('rejects a mismatched real interaction identity: %j', patch => {
  const f = fixture();
  expect(claim(f.buttons, event(f.raw, patch))).toBeNull();
  expect(claim(f.buttons, event(f.raw))).not.toBeNull();
});

it('allows exactly one claim, then removes the executable command after consumption', () => {
  const f = fixture();
  const selected = claim(f.buttons, event(f.raw))!;
  expect(claim(f.buttons, event(f.raw))).toBeNull();
  expect(f.buttons.valid(selected, binding)).toBe(true);
  f.buttons.consume(selected);
  expect(f.buttons.valid(selected, binding)).toBe(false);
  expect(claim(f.buttons, event(f.raw))).toBeNull();
});

it.each([
  { route: {} },
  { turnId: 'new-turn' },
  { gameState: '{"adventure":{"id":"story","revision":1}}' },
  { gameState: '{"adventure":{"id":"new-story","revision":0}}' },
])('revalidates the queued claim against the latest route, turn and game state: %j', patch => {
  const f = fixture();
  const selected = claim(f.buttons, event(f.raw))!;
  expect(f.buttons.valid(selected, { ...binding, ...patch })).toBe(false);
});

it('expires old menus and does not accept a prior generation even with a copied nonce', () => {
  vi.useFakeTimers();
  const f = fixture();
  const reloaded = fixture(10);
  const old = JSON.parse(f.raw);
  const current = JSON.parse(reloaded.raw);
  expect(claim(reloaded.buttons, event(JSON.stringify({ ...current, g: old.g })))).toBeNull();
  vi.advanceTimersByTime(1001);
  expect(claim(f.buttons, event(f.raw))).toBeNull();
});

it('rejects extra executable fields, out-of-page indices and nonadjacent pagination', () => {
  const f = fixture(9, 25);
  const data = JSON.parse(f.raw);
  for (const patch of [{ command: '购买大还丹' }, { i: 8 }, { i: -1 }, { a: 'page', i: undefined, p: 2 }]) {
    expect(claim(f.buttons, event(JSON.stringify({ ...data, ...patch })))).toBeNull();
  }
});

it('keeps every option reachable within five two-button rows and rotates the nonce on each page', () => {
  const f = fixture(9, 25);
  const indices: number[] = [];
  let previousRaw: string | undefined;
  for (;;) {
    const keyboard = f.buttons.keyboard(f.menu);
    expect(keyboard.content.rows.length).toBeLessThanOrEqual(5);
    expect(keyboard.content.rows.every(row => row.buttons.length <= 2)).toBe(true);
    const buttons = keyboard.content.rows.flatMap(row => row.buttons);
    for (const button of buttons) {
      expect(Array.from(button.render_data.label).length).toBeLessThanOrEqual(10);
      expect(button.action.permission).toMatchObject({ type: 0, specify_user_ids: ['player'] });
      const data = JSON.parse(button.action.data);
      if (data.a === 'choose') indices.push(data.i);
    }
    if (previousRaw) expect(claim(f.buttons, event(previousRaw))).toBeNull();
    const next = buttons.find(button => { const data = JSON.parse(button.action.data); return data.a === 'page' && data.p === f.menu.menu.page + 1; });
    if (!next) break;
    previousRaw = buttons[0]!.action.data;
    const selected = claim(f.buttons, event(next.action.data))!;
    f.buttons.page(selected);
  }
  expect(indices).toEqual(Array.from({ length: 25 }, (_, i) => i));
});

it('a new text turn or route retirement invalidates only the affected player menus', () => {
  const f = fixture();
  const other = f.buttons.show({ ...binding, senderId: 'other' }, [{ label: '继续', command: '继续修炼' }]);
  f.buttons.cancel(binding);
  expect(claim(f.buttons, event(f.raw))).toBeNull();
  const raw = f.buttons.keyboard(other).content.rows[0]!.buttons[0]!.action.data;
  expect(claim(f.buttons, event(raw, { group_member_openid: 'other' }))).not.toBeNull();
  f.buttons.cancelRoute(binding.route);
  expect(claim(f.buttons, event(raw, { group_member_openid: 'other' }))).toBeNull();
});

it('page navigation and read-only market paging stay valid across unrelated turn/world changes while stateful choices stay strict', () => {
  const f = fixture(9, 25);
  const buttons = f.buttons.keyboard(f.menu).content.rows.flatMap(row => row.buttons);
  const next = buttons.find(button => JSON.parse(button.action.data).a === 'page')!;
  const pageClaim = claim(f.buttons, event(next.action.data))!;
  const drifted: GameButtonBinding = { ...binding, turnId: 'other-player-turn', gameState: '{"world":"changed"}' };
  expect(f.buttons.valid(pageClaim, drifted)).toBe(true);
  f.buttons.page(pageClaim, { ...binding, turnId: 'other-player-turn' });
  expect(f.buttons.pageText(pageClaim)).toContain('第2/4页');

  const navMenu = f.buttons.show(binding, [
    { label: '购生骨丹', command: '坊市购买 1' },
    { label: '下一页', command: '坊市查询 2' },
  ]);
  const navButtons = f.buttons.keyboard(navMenu).content.rows.flatMap(row => row.buttons);
  const buyClaim = claim(f.buttons, event(navButtons[0]!.action.data))!;
  expect(f.buttons.valid(buyClaim, drifted)).toBe(false);
  f.buttons.release(buyClaim);
  const marketNextClaim = claim(f.buttons, event(navButtons[1]!.action.data))!;
  expect(f.buttons.valid(marketNextClaim, drifted)).toBe(true);
});
