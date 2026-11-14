import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineLocation, loadGameFactory } from './game-loader.ts';
import { testEngine, testEngineDirectory } from '../tests/game-fixture.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-loader-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sandbox = join(root, 'sandbox');
  const engine = join(root, 'engine');
  await mkdir(sandbox); await mkdir(engine);
  return { root, sandbox, engine };
}

it.each(['', 'relative/engine', '~', '../engine', '/engine\0'])('rejects ambiguous engine directory %j', async directory => {
  const f = await fixture();
  await expect(loadGameFactory(directory, f.sandbox)).rejects.toThrow('绝对路径或 ~/');
});

it('reports real missing directory and entry errors instead of returning an empty game', async () => {
  const f = await fixture();
  await expect(loadGameFactory(join(f.root, 'missing'), f.sandbox)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(loadGameFactory(f.engine, f.sandbox)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(join(f.engine, 'engine.js'));
  await expect(loadGameFactory(f.engine, f.sandbox)).rejects.toThrow('入口不是文件');
});

it.each(['module.exports = {};', 'module.exports = { createGame: 1 };'])('rejects a malformed CommonJS factory export', async source => {
  const f = await fixture();
  await writeFile(join(f.engine, 'engine.js'), source);
  await expect(loadGameFactory(f.engine, f.sandbox)).rejects.toThrow('CommonJS createGame');
});

it('preserves an engine entry execution error', async () => {
  const f = await fixture();
  await writeFile(join(f.engine, 'engine.js'), 'throw new Error("entry initialization failed");');
  await expect(loadGameFactory(f.engine, f.sandbox)).rejects.toThrow('entry initialization failed');
});

it.each(['() => ({})', 'async () => ({})'])('rejects an incomplete or asynchronous game factory result', async factory => {
  const f = await fixture();
  await writeFile(join(f.engine, 'engine.js'), `module.exports = { createGame: ${factory} };`);
  const createGame = await loadGameFactory(f.engine, f.sandbox);
  expect(() => createGame({ databasePath: join(f.root, 'unused.sqlite') })).toThrow('未同步返回完整游戏 API');
});

it.each(['directory-alias', 'parent-alias', 'entry-alias'] as const)('rejects %s controlled by the sandbox without executing its entry', async kind => {
  const f = await fixture();
  const marker = join(f.root, 'executed');
  const untrusted = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('untrusted entry executed');`;
  let configured = f.engine;
  if (kind === 'entry-alias') {
    await writeFile(join(f.sandbox, 'entry.js'), untrusted);
    await symlink(join(f.sandbox, 'entry.js'), join(f.engine, 'engine.js'));
  } else {
    await writeFile(join(f.engine, 'engine.js'), untrusted);
    const alias = join(f.sandbox, 'source');
    await symlink(kind === 'parent-alias' ? f.root : f.engine, alias, 'dir');
    configured = kind === 'parent-alias' ? join(alias, 'engine') : alias;
  }
  await expect(loadGameFactory(configured, f.sandbox)).rejects.toThrow(/QQ 沙箱/);
  expect(existsSync(marker)).toBe(false);
});

it('rejects a sandbox-parent alias pointing at the registered engine before execution', async () => {
  const f = await fixture();
  const marker = join(f.root, 'executed');
  await writeFile(join(f.engine, 'engine.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const alias = join(f.root, 'alias'); await symlink(f.root, alias, 'dir');
  await expect(loadGameFactory(f.engine, join(alias, 'engine', 'qq'))).rejects.toThrow('独立游戏引擎目录');
  expect(existsSync(marker)).toBe(false);
});

it('keeps a not-yet-installed registered source directory protected while disabled', async () => {
  const f = await fixture();
  const planned = join(f.root, 'planned-engine');
  await expect(engineLocation(planned, f.root)).rejects.toThrow('独立游戏引擎目录');
  expect(existsSync(planned)).toBe(false);
});

it('loads the real external engine through its canonical directory and preserves data across reopening', async () => {
  const f = await fixture();
  const alias = join(f.root, 'registered-source'); await symlink(testEngineDirectory, alias, 'dir');
  const location = await engineLocation(alias, await realpath(f.sandbox));
  expect(location.directory).toBe(await realpath(testEngineDirectory));
  const createGame = await loadGameFactory(alias, f.sandbox);
  const databasePath = join(f.root, 'game.sqlite');
  const game = createGame({ databasePath, now: () => Date.parse('2026-11-13T01:00:00Z'), random: () => 0 });
  const event = { groupId: 'qq-account-group', userId: 'player', text: '我要修仙' };
  try {
    expect((await game.handleMessage(event)).handled).toBe(true);
    expect(game.getPlayer(event.groupId, event.userId)).not.toBeNull();
    expect(game.getPlayer('another-qq-account-group', event.userId)).toBeNull();
  } finally { game.close(); }
  const { createGame: reopen } = await testEngine(f.sandbox);
  const reopened = reopen({ databasePath });
  try { expect(reopened.getPlayer(event.groupId, event.userId)).not.toBeNull(); }
  finally { reopened.close(); }
});
