import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const declarations = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: directory, stdio: "inherit" });
if (declarations.error) throw declarations.error;
if (declarations.status !== 0) throw new Error("Schedules plugin declaration emission failed");
const external = ["@omp-desktop/plugin", "@omp-desktop/plugin/*", "@omp-desktop/client", "@omp-desktop/client/*", "@omp-desktop/protocol", "@omp-desktop/protocol/*", "react", "react/*", "react-native", "react-i18next", "i18next", "zod"];
for (const format of ["esm", "cjs"]) {
  const extension = format === "esm" ? "mjs" : "cjs";
  await build({ absWorkingDir: directory, entryPoints: ["client.tsx"], outfile: `dist/client.${extension}`, bundle: true, format, platform: "browser", target: "es2022", jsx: "automatic", external, sourcemap: true });
  await build({ absWorkingDir: directory, entryPoints: ["service.ts"], outfile: `dist/service.${extension}`, bundle: true, format, platform: "node", target: "node22", external, sourcemap: true });
}
