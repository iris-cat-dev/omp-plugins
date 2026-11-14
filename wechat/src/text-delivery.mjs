// Leave room for part labels and the native UTF-16 and UTF-8 size limits.
export function splitReply(text) {
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed()) throw new Error('回复文本为空或 Unicode 无效');
  const chunks = [];
  let part = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (part.length + character.length > 1500 || bytes + size > 3900) {
      chunks.push(part); part = ''; bytes = 0;
    }
    part += character; bytes += size;
  }
  if (part) chunks.push(part);
  const result = chunks.length === 1 ? chunks : chunks.map((value, index) => `（${index + 1}/${chunks.length}）\n${value}`);
  if (result.some(value => Buffer.byteLength(value) > 4094 || value.length > 2047)) throw new Error('回复分段超过原生限制');
  return result;
}

export async function deliverText({ journal, bridge, seq, peer, text, current }) {
  const parts = journal.prepareText(seq, peer, splitReply(text));
  for (const part of parts) {
    if (!current()) { journal.finishWithoutSend(seq, 'unknown'); return; }
    journal.beginPart(part.id);
    if (!current()) return;
    try {
      const result = await bridge.request('submit_text', { requestId: part.id, targetId: peer, text: part.text });
      if (result.requestId !== part.id || result.status !== 'submitted') throw new Error('文本分段发送结果未知');
      journal.finishPart(part.id, 'submitted');
    } catch (error) {
      if (error?.outcome === 'not_submitted') { journal.finishPart(part.id, 'failed'); error.journalHandled = true; }
      else error.sendUnknown = true;
      throw error;
    }
  }
}
