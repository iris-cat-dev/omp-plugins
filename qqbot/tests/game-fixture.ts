import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { loadGameFactory } from '../src/game-loader.ts';
import type { Game, GameOptions, Player } from '../src/game-api.ts';

export interface TestEngine {
  createGame: (options: GameOptions) => Game;
  openStore: (databasePath: string) => { save(groupId: string, player: Player): void; close(): void };
  data: { realms: Array<{ exp: number }> };
  stats: (player: Player) => { maxHp: number; maxMp: number };
}

const configured = process.env.QQBOT_TEST_ENGINE_DIRECTORY;
if (!configured || !isAbsolute(configured) || !existsSync(join(configured, 'engine.js'))) {
  throw new Error('QQ game tests require the real external engine. Set QQBOT_TEST_ENGINE_DIRECTORY to its absolute directory containing engine.js; no bundled fixture or fallback is used.');
}
export const testEngineDirectory = configured;

async function openEngine(sandboxRoot: string): Promise<TestEngine> {
  const directory = await realpath(testEngineDirectory);
  const createGame = await loadGameFactory(directory, sandboxRoot);
  const require = createRequire(join(directory, 'engine.js'));
  const { openStore } = require(join(directory, 'store.js'));
  const { data, stats } = require(join(directory, 'rules.js'));
  return { createGame, openStore, data, stats };
}
let engine: Promise<TestEngine> | undefined;
export function testEngine(sandboxRoot: string) {
  return engine ??= openEngine(sandboxRoot);
}
