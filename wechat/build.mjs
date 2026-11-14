import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = ['@omp-desktop/plugin', '@omp-desktop/plugin/*', '@omp-desktop/client', '@omp-desktop/client/*', '@omp-desktop/protocol', '@omp-desktop/protocol/*', 'react', 'react/*', 'react-native', 'zod'];
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/client.jsx'], outfile: 'dist/client.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', external: shared });
await build({ absWorkingDir: root, entryPoints: ['src/service.mjs'], outfile: 'dist/service.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node22', external: [...shared, './native-bridge.cjs', './native-receiver.cjs'] });
for (const name of ['native-bridge.cjs', 'native-receiver.cjs']) await copyFile(new URL(`./src/${name}`, import.meta.url), new URL(`./dist/${name}`, import.meta.url));
