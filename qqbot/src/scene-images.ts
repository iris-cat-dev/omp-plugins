import { randomUUID } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import type { GameSceneImage } from './game-api.ts';
import { validateGeneratedImage } from './media.ts';
import type { SandboxFiles } from './sandbox-files.ts';
import type { StateStore, Peer } from './state.ts';
import type { QQImageGenerator } from './image-generation.ts';

const TIMEOUT_MS = 180_000;

export function validateSceneImage(bytes: Buffer, dimensions?: { width: number; height: number }) {
  validateGeneratedImage(bytes, 'image/png');
  const invalid = () => { throw new Error('场景图必须为尺寸匹配的完整 PNG。'); };
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const imageWidth = bytes.readUInt32BE(16), imageHeight = bytes.readUInt32BE(20);
  if (!imageWidth || !imageHeight || imageWidth > 0x7fffffff || imageHeight > 0x7fffffff
    || (dimensions && (imageWidth !== dimensions.width || imageHeight !== dimensions.height))) invalid();
  const depth = bytes[24]!, color = bytes[25]!;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) invalid();
  const chunks: Buffer[] = [];
  let ended = false, palette = false, dataEnded = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (type === 'IHDR' && offset !== 8) invalid();
    if (type === 'PLTE') { if (chunks.length || !size || size % 3 || size > 768) invalid(); palette = true; }
    if (type === 'IDAT') { if (dataEnded) invalid(); chunks.push(bytes.subarray(offset + 8, end - 4)); }
    else if (chunks.length) dataEnded = true;
    if (type === 'IEND') { if (size !== 0 || end !== bytes.length) invalid(); ended = true; }
    else if (!['IHDR', 'PLTE', 'IDAT'].includes(type) && (bytes[offset + 4]! & 32) === 0) invalid();
    offset = end;
  }
  if (!ended || !chunks.length || (color === 3 && !palette)) invalid();
  // Validate the actual compressed pixels, including Adam7 scanline layout.
  const passes = bytes[28] === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const layouts = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((imageWidth - x!) / dx!)), height = Math.max(0, Math.ceil((imageHeight - y!) / dy!));
    return { rows: width ? height : 0, stride: 1 + Math.ceil(width * channels! * depth / 8) };
  });
  const expected = layouts.reduce((sum, layout) => sum + layout.rows * layout.stride, 0);
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (pixels.length !== expected) invalid();
  let offset = 0;
  for (const { rows, stride } of layouts) {
    for (let row = 0; row < rows; row++) { if (pixels[offset]! > 4) invalid(); offset += stride; }
  }
}

interface Flight { controller: AbortController; users: number; promise: Promise<Buffer> }
export interface SceneImageRequest { scene: GameSceneImage; signal: AbortSignal; peer: Peer; senderId: string }

export class SceneImages {
  private flights = new Map<string, Flight>();
  constructor(private root: string, private files: SandboxFiles, private store: StateStore,
    private imageGeneration: QQImageGenerator) {}

  async get(request: SceneImageRequest): Promise<Buffer> {
    const { scene, signal } = request;
    signal.throwIfAborted();
    const brief = scene.image.prompt;
    const key = JSON.stringify([this.root, scene.sceneId, brief]);
    const flightKey = JSON.stringify([key, scene.image.width, scene.image.height]);
    let flight = this.flights.get(flightKey);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      flight = { controller, users: 0, promise: this.load(key, brief, { ...request, signal: controller.signal }) };
      const owned = flight;
      owned.promise = owned.promise.finally(() => { if (this.flights.get(flightKey) === owned) this.flights.delete(flightKey); });
      this.flights.set(flightKey, owned);
    }
    flight.users++;
    const interrupted = Promise.withResolvers<never>();
    const abort = () => interrupted.reject(signal.reason ?? new Error('场景图请求已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await Promise.race([flight.promise, interrupted.promise]); }
    finally {
      signal.removeEventListener('abort', abort);
      if (--flight.users === 0) flight.controller.abort(new Error('该场景已无等待图片的请求。'));
    }
  }

  private async load(key: string, brief: string, request: SceneImageRequest): Promise<Buffer> {
    const { signal } = request;
    await this.files.mkdir('.qqbot-media/generated');
    signal.throwIfAborted();
    const cached = (await this.store.read()).values.sceneImages[key];
    if (cached) {
      // Native list rejects links and unsafe directories. Only a genuinely absent
      // entry is a cache miss; corrupt or linked entries must fail visibly.
      const name = cached.slice(cached.lastIndexOf('/') + 1);
      if ((await this.files.list('.qqbot-media/generated')).some(file => file.name === name)) {
        const bytes = await this.files.read(cached);
        validateSceneImage(bytes, request.scene.image);
        signal.throwIfAborted();
        return bytes;
      }
    }
    signal.throwIfAborted();
    const { path, bytes } = await this.generate(brief, request);
    signal.throwIfAborted();
    await this.store.mutate(state => { signal.throwIfAborted(); state.sceneImages[key] = path; });
    return bytes;
  }

  private async generate(brief: string, request: SceneImageRequest): Promise<{ path: string; bytes: Buffer }> {
    request.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => {
      const error = new Error('场景绘图超时。'); error.name = 'TimeoutError';
      controller.abort(error);
    }, TIMEOUT_MS);
    try {
      const dimensions = request.scene.image;
      const prompt = [dimensions.system, brief, `请生成一张完整 PNG 场景图片，尺寸必须为 ${dimensions.width} × ${dimensions.height} 像素。`].join('\n\n');
      const image = await this.imageGeneration.generate(request.peer, request.senderId, { prompt, images: [] }, signal);
      signal.throwIfAborted();
      if (image.mimeType !== 'image/png') throw new Error('场景图必须为 PNG 图片。');
      const bytes = Buffer.from(image.data, 'base64');
      validateSceneImage(bytes, dimensions);
      const path = `.qqbot-media/generated/${randomUUID()}.png`;
      signal.throwIfAborted();
      await this.files.write(path, bytes);
      signal.throwIfAborted();
      return { path, bytes };
    } finally { clearTimeout(timer); }
  }
}
