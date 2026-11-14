import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeTextBackend } from './native-text.mjs';

export async function openHostText() {
  const directory = path.join(path.dirname(process.execPath), 'resources', 'omp-sdk', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'node');
  const entry = path.join(directory, 'sdk.mjs');
  if (!existsSync(entry)) throw new Error('当前进程没有安装版 OMP 模型 SDK');
  const modulePath = JSON.parse(readFileSync(path.join(directory, 'modules.json'), 'utf8')).modules?.['@oh-my-pi/pi-ai'];
  if (typeof modulePath !== 'string') throw new Error('OMP SDK 未声明模型模块');
  const aiPath = path.resolve(directory, modulePath);
  if (!aiPath.startsWith(directory + path.sep)) throw new Error('OMP SDK 模型模块路径无效');
  const [sdk, ai] = await Promise.all([import(pathToFileURL(entry).href), import(pathToFileURL(aiPath).href)]);
  return createNativeTextBackend({ sdk, ai });
}
