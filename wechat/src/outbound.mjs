import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_IMAGE = 32 * 1024 * 1024;

/** Stage exactly the file selected by the operator; the native bridge validates and snapshots it. */
export async function stageImage(source, directory) {
  if (!path.isAbsolute(source) || source.includes('\0')) throw new Error('图片路径必须为绝对路径');
  const file = await open(source, 'r');
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE) throw new Error('图片文件无效或超过 32 MiB');
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const part = await file.read(buffer, count, buffer.length - count, count);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    if (count !== info.size) throw new Error('读取期间图片发生变化');
    bytes = buffer.subarray(0, count);
  } finally { await file.close(); }
  const dir = path.join(directory, 'image-input');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, randomUUID() + '.image');
  await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
  return dest;
}

export async function submitImage({ bridge, journal, target, source, directory, current }) {
  let staged, id;
  try {
    if (!current()) throw new Error('连接已停止');
    staged = await stageImage(source, directory);
    if (!current()) throw new Error('连接已停止');
    const asset = await bridge.request('prepare_image', { targetId: target, path: staged });
    if (typeof asset.assetId !== 'string' || !/^[a-f0-9]{32}$/.test(asset.assetId)) throw new Error('图片准备结果无效');
    await unlink(staged); staged = null;
    if (!current()) throw new Error('连接已停止');
    id = journal.beginImage(target, path.basename(source));
    if (!current()) throw new Error('连接已停止');
    const result = await bridge.request('submit_image', { requestId: id, targetId: target, assetId: asset.assetId });
    if (result.requestId !== id || result.status !== 'submitted') throw new Error('图片发送结果未知');
    journal.finishImage(id, 'submitted');
    return { requestId: id };
  } catch (error) {
    if (id && error?.outcome === 'not_submitted') journal.finishImage(id, 'failed');
    else if (id) error.sendUnknown = true;
    throw error;
  } finally { if (staged) await unlink(staged); }
}

/** Operator confirmation is recorded only after checking the same native state directory. */
export async function closeReviewedSend({ bridge, journal, row, current = () => true }) {
  if (!current()) throw new Error('人工核对已取消');
  const result = await bridge.request('submission', { requestId: row.id });
  if (!current()) throw new Error('人工核对已取消');
  if (typeof result.found !== 'boolean') throw new Error('原生发送记录查询结果无效');
  if (result.found) {
    if (result.requestId !== row.id || result.targetId !== row.peer || result.kind !== row.kind || !['submitted', 'unknown'].includes(result.status) || typeof result.reviewed !== 'boolean') throw new Error('原生发送记录与本地记录不符');
    if (result.status === 'unknown') {
      const ack = await bridge.request('acknowledge', { requestId: row.id, resolution: 'checked_no_retry' });
      if (ack.requestId !== row.id || ack.status !== 'unknown' || ack.reviewed !== true) throw new Error('原生封口未确认');
    }
  }
  if (!current()) throw new Error('人工核对已取消，本地记录保留');
  journal.closeUnknown(row.id);
}
