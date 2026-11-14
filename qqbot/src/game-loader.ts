import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Game, GameOptions } from './game-api.ts';

function inside(root: string, path: string) {
  const r = relative(root, path);
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`));
}
export function overlaps(a: string, b: string) { return inside(a, b) || inside(b, a); }

const gameMethods = ['parseInput', 'handleCommand', 'handleMessage', 'resolveReview', 'getPlayer', 'close'];

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    return resolve(await canonicalPath(resolve(path, '..')), basename(path));
  }
}

function requestedEngineDirectory(directory: string) {
  if (!directory || directory.includes('\0') || (!isAbsolute(directory) && !directory.startsWith('~/'))) {
    throw new Error('game.engineDirectory 必须配置明确的绝对路径或 ~/ 路径');
  }
  return directory.startsWith('~/') ? resolve(homedir(), directory.slice(2)) : resolve(directory);
}

// Protect registered source paths even while the game is disabled or not yet installed.
export async function engineLocation(engineDirectory: string, sandboxRoot: string) {
  const requested = requestedEngineDirectory(engineDirectory);
  const directory = await canonicalPath(requested);
  if (overlaps(sandboxRoot, requested) || overlaps(sandboxRoot, directory)) {
    throw new Error('QQ 沙箱不能与独立游戏引擎目录重叠或通过符号链接别名加载引擎');
  }
  // A parent alias can cross the sandbox and then point back outside it. Check
  // that traversal too; comparing only the final realpath would hide the alias.
  for (let parent = resolve(requested, '..'); parent !== resolve(parent, '..'); parent = resolve(parent, '..')) {
    if (inside(sandboxRoot, await canonicalPath(parent))) throw new Error('不能通过 QQ 沙箱符号链接别名加载游戏引擎');
  }
  const entry = await canonicalPath(resolve(directory, 'engine.js'));
  if (overlaps(sandboxRoot, entry)) throw new Error('游戏引擎入口不能解析到 QQ 沙箱');
  return { directory, entry };
}

export async function loadGameFactory(engineDirectory: string, sandboxRoot: string): Promise<(options: GameOptions) => Game> {
  sandboxRoot = await canonicalPath(sandboxRoot);
  const location = await engineLocation(engineDirectory, sandboxRoot);
  const directory = await realpath(location.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error(`游戏引擎目录不是目录：${directory}`);
  const entry = await realpath(resolve(directory, 'engine.js'));
  if (overlaps(sandboxRoot, entry)) throw new Error('游戏引擎入口不能解析到 QQ 沙箱');
  if (!(await stat(entry)).isFile()) throw new Error(`游戏引擎入口不是文件：${entry}`);
  // This computed, canonical filename is loaded by Node, never by the plugin bundler.
  const engine: unknown = createRequire(entry)(entry);
  if (!engine || typeof engine !== 'object' || !('createGame' in engine) || typeof engine.createGame !== 'function') {
    throw new Error(`游戏引擎 ${entry} 必须导出 CommonJS createGame(options) 同步工厂`);
  }
  const createGame = engine.createGame as (options: GameOptions) => unknown;
  return options => {
    const game = createGame(options);
    if (!game || typeof game !== 'object' || !gameMethods.every(method => typeof (game as Record<string, unknown>)[method] === 'function')) {
      throw new Error(`游戏引擎 ${entry} 的 createGame(options) 未同步返回完整游戏 API`);
    }
    return game as Game;
  };
}
