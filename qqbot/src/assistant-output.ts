import type { AgentTimelineItem } from '@omp-desktop/protocol/agent-types';

type AssistantMessage = Extract<AgentTimelineItem, { type: 'assistant_message' }>;
interface TextRow {
  item: AssistantMessage;
  start: number;
  end: number;
  version: number;
}
export interface AssistantReply { text: string; messageCount: number }

// OMP live timeline rows are text deltas at distinct canonical seqs. A new
// contentVersion at the same seq replaces that row, not the whole message.
// messageId identifies one assistant message; anonymous continuations follow
// the host's adjacent assistant_merge rule. Unrelated messages stay separate.
export class AssistantOutput {
  private rows = new Map<number, TextRow>();

  add(item: AssistantMessage, seq: number, version = 0, start = seq) {
    const previous = this.rows.get(seq);
    if (previous && previous.version > version) return;
    this.rows.set(seq, { item, start, end: seq, version });
  }

  get reply(): AssistantReply {
    const rows = [...this.rows.values()].sort((a, b) => a.start - b.start);
    const messages: Array<{ text: string; item: AssistantMessage }> = [];
    const identities = new Map<string, number>();
    let previous: TextRow | undefined;
    let previousIndex = -1;
    for (const row of rows) {
      let index = row.item.customMessage === undefined && row.item.messageId !== undefined
        ? identities.get(row.item.messageId) : undefined;
      if (index !== undefined && messages[index]!.item.presentation !== row.item.presentation) index = undefined;
      if (index === undefined && row.item.messageId === undefined && previous
        && previous.end + 1 === row.start && previous.item.customMessage === undefined
        && row.item.customMessage === undefined && previous.item.presentation === row.item.presentation) index = previousIndex;
      if (index === undefined) {
        index = messages.length;
        messages.push({ text: row.item.text, item: row.item });
        if (row.item.customMessage === undefined && row.item.messageId !== undefined) identities.set(row.item.messageId, index);
      } else messages[index]!.text += row.item.text;
      previous = row;
      previousIndex = index;
    }
    let text = '';let messageCount = 0;
    for (const message of messages) {
      if (!message.text.length) continue;
      if (messageCount++) text += '\n';
      text += message.text;
    }
    return { text, messageCount };
  }
}
