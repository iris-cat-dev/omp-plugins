import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GeneratedImage, ImageGenerationInput, OmpApi } from '@omp-desktop/client';
import { QQImageGenerator } from './image-generation.ts';

const image: GeneratedImage = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=', mimeType: 'image/png' };
const peer = { appId: 'app', scope: 'c2c' as const };
const input: ImageGenerationInput = { prompt: 'Draw one pixel.', images: [] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qq-plugin-image-quota-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'private', 'images.sqlite');
  let calls = 0;
  let produce: (signal: AbortSignal) => Promise<GeneratedImage> = async () => image;
  const omp: Pick<OmpApi, 'images'> = { images: { async generate(_input, options) {
    calls++;
    return produce(options!.signal!);
  } } };
  const generator = new QQImageGenerator(omp, databasePath);
  cleanups.push(() => generator.dispose());
  const generate = (senderId = 'alice', signal = new AbortController().signal) => generator.generate(peer, senderId, input, signal);
  const states = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare('SELECT state, COUNT(*) AS count FROM image_quota_reservations GROUP BY state ORDER BY state').all(); }
    finally { database.close(); }
  };
  return { generator, omp, databasePath, generate, states, calls: () => calls, setProduce: (next: typeof produce) => { produce = next; } };
}

it('refuses the eleventh API generation and preserves successful usage after plugin reopen', async () => {
  const f = fixture();
  for (let index = 0; index < 10; index++) await f.generate();
  await expect(f.generate()).rejects.toThrow('QQ_IMAGE_QUOTA_EXHAUSTED');
  expect(f.calls()).toBe(10);
  expect(f.states()).toEqual([{ state: 'succeeded', count: 10 }]);
  f.generator.dispose();
  const reopened = new QQImageGenerator(f.omp, f.databasePath);
  cleanups.push(() => reopened.dispose());
  await expect(reopened.generate(peer, 'alice', input, new AbortController().signal)).rejects.toThrow('QQ_IMAGE_QUOTA_EXHAUSTED');
  expect(f.calls()).toBe(10);
});

it('releases only exact host-authorized non-generation failures, preserving room for ten real outputs', async () => {
  const f = fixture();
  const errors = [
    'Image generation is disabled on this host.',
    'Image generation is disabled by the OMP provider policy on this host.',
    'Set an OpenAI image API key in this host’s image generation settings.',
    'The selected ChatGPT image account is unavailable. Sign in or choose another subscription account on the host.',
    'The host’s OMP Node SDK does not support direct image generation. Update or rebuild the selected SDK.',
    'The image provider returned no image.',
    'Plugin capability is not granted: images.generate',
  ];
  for (const message of errors) {
    f.setProduce(async () => { throw new Error(message); });
    await expect(f.generate()).rejects.toThrow(message);
  }
  f.setProduce(async () => image);
  for (let index = 0; index < 10; index++) await f.generate();
  await expect(f.generate()).rejects.toThrow('QQ_IMAGE_QUOTA_EXHAUSTED');
  expect(f.states()).toEqual([{ state: 'failed', count: 7 }, { state: 'succeeded', count: 10 }]);
  expect(f.calls()).toBe(17);
});

it('retains uncertain provider failures, timeout and abort reservations across restart instead of allowing overrun', async () => {
  const f = fixture();
  for (const message of ['The image provider request failed. Check the host’s image generation settings and credentials.', 'Image generation timed out.', 'The provider must return one PNG, JPEG, or WebP image of at most 4 MiB.']) {
    f.setProduce(async () => { throw new Error(message); });
    await expect(f.generate()).rejects.toThrow(message);
  }
  const started = Promise.withResolvers<void>();
  f.setProduce(signal => {
    const completion = Promise.withResolvers<GeneratedImage>();
    signal.addEventListener('abort', () => completion.reject(signal.reason), { once: true });
    started.resolve();
    return completion.promise;
  });
  const controller = new AbortController();
  const work = f.generate('alice', controller.signal);
  const aborted = expect(work).rejects.toThrow('sender left');
  await started.promise; controller.abort(new Error('sender left')); await aborted;
  expect(f.states()).toEqual([{ state: 'pending', count: 4 }]);
  f.generator.dispose();
  const reopened = new QQImageGenerator(f.omp, f.databasePath);
  cleanups.push(() => reopened.dispose());
  f.setProduce(async () => image);
  for (let index = 0; index < 6; index++) await reopened.generate(peer, 'alice', input, new AbortController().signal);
  await expect(reopened.generate(peer, 'alice', input, new AbortController().signal)).rejects.toThrow('QQ_IMAGE_QUOTA_EXHAUSTED');
  expect(f.calls()).toBe(10);
});

it('charges a positive API output even if cancellation arrives before the caller can publish it', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.setProduce(async () => { controller.abort(new Error('publication canceled')); return image; });
  await f.generate('alice', controller.signal);
  expect(f.states()).toEqual([{ state: 'succeeded', count: 1 }]);
});

it('refuses missing sender identity before calling the host and leaves canceled-before-admission requests free', async () => {
  const f = fixture();
  await expect(f.generate(' ')).rejects.toThrow('QQ_IMAGE_QUOTA_IDENTITY_REQUIRED');
  const controller = new AbortController(); controller.abort(new Error('already canceled'));
  await expect(f.generate('alice', controller.signal)).rejects.toThrow('already canceled');
  expect(f.calls()).toBe(0);
  expect(f.states()).toEqual([]);
});

it('plugin disposal aborts the active API request but retains its uncertain reservation', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.setProduce(signal => {
    const completion = Promise.withResolvers<GeneratedImage>();
    signal.addEventListener('abort', () => completion.reject(signal.reason), { once: true });
    started.resolve();
    return completion.promise;
  });
  const work = f.generate();
  const stopped = expect(work).rejects.toThrow('服务已关闭');
  await started.promise; f.generator.dispose(); await stopped;
  expect(f.states()).toEqual([{ state: 'pending', count: 1 }]);
  await expect(f.generate()).rejects.toThrow('服务已关闭');
  expect(f.calls()).toBe(1);
});
