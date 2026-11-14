import { expect, it } from 'vitest';
import { AssistantOutput } from './assistant-output.ts';
import { parseGameOutput } from './game-bridge.ts';

const review = { scores: { experience: { value: 1, quote: '修为够了也会失败', factIds: ['state'] }, problem: { value: 1, quote: '也会失败，先查概率' }, reason: { value: 2, quote: '免得白白损失修为' }, change: { value: 1, quote: '先查概率' } }, feedback: '先看风险，再调整。', followUp: null };
it.each([
  ['action', JSON.stringify({ type: 'game_action', command: '我的状态' })],
  ['review', JSON.stringify(review)],
  ['natural', '一张完整的图片。\n这个换行来自原文，emoji也不能断开：🌙。'],
])('reconstructs %s from OMP distinct-seq deltas without inserting characters', (kind, text) => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '' }, 1);
  // One UTF-16 code unit per row also splits escaped JSON strings and emoji.
  for (let index = 0; index < text.length; index++) {
    const item = { type: 'assistant_message' as const, messageId: 'native-message', text: text[index]! };
    output.add(item, index + 2, 1);
    output.add(item, index + 2, 1); // replay of the same canonical row is not a second delta
  }
  expect(output.reply).toEqual({ text, messageCount: 1 });
  if (kind === 'action') expect(parseGameOutput(output.reply.text).type).toBe('action');
  if (kind === 'review') expect(JSON.parse(output.reply.text)).toEqual(review);
  if (kind === 'natural') expect(parseGameOutput(output.reply.text)).toEqual({ type: 'text', text });
});
it('a contentVersion edit replaces only its canonical row and rejects an older revision', () => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '先' }, 1, 1);
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '看概率' }, 2, 1);
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '查询' }, 2, 2);
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '旧片段' }, 2, 1);
  expect(output.reply).toEqual({ text: '先查询', messageCount: 1 });
});
it('same message identity survives interleaved non-text timeline rows', () => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '完整' }, 1);
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '回复' }, 4);
  expect(output.reply).toEqual({ text: '完整回复', messageCount: 1 });
});
it('separate assistant identities remain separate even when their concatenation parses as JSON', () => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', messageId: 'first', text: '{"type":"game_action",' }, 1);
  output.add({ type: 'assistant_message', messageId: 'second', text: '"command":"我的状态"}' }, 2);
  expect(output.reply.messageCount).toBe(2);
  expect(output.reply.text).toBe('{"type":"game_action",\n"command":"我的状态"}');
});
it('hydrates a projected active-message prefix before new live deltas', () => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '已经归并' }, 3, 0, 1);
  output.add({ type: 'assistant_message', messageId: 'native-message', text: '的后续内容' }, 4, 1);
  expect(output.reply).toEqual({ text: '已经归并的后续内容', messageCount: 1 });
});
it('anonymous legacy chunks merge only when adjacent, while distinct messages preserve their own newlines', () => {
  const output = new AssistantOutput();
  output.add({ type: 'assistant_message', text: 'Hel' }, 1);
  output.add({ type: 'assistant_message', text: 'lo\n原文' }, 2);
  output.add({ type: 'assistant_message', text: '下一条消息' }, 4);
  expect(output.reply).toEqual({ text: 'Hello\n原文\n下一条消息', messageCount: 2 });
});
