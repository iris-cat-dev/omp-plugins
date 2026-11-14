import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StoredScheduleSchema } from "@omp-desktop/protocol/schedule/types";
import { writeJsonFileAtomic } from "./atomic-file.js";

export async function importLegacySchedules(dataDirectory: string, installationId: string): Promise<number> {
  if (installationId !== "schedules") return 0;
  if (basename(dataDirectory) !== installationId || basename(dirname(dataDirectory)) !== "plugins") {
    throw new Error("Invalid installation-owned schedules data directory");
  }
  const marker = join(dataDirectory, ".legacy-schedules-import-v1");
  try {
    await stat(marker);
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const legacyDirectory = join(dirname(dirname(dataDirectory)), "schedules");
  let files: string[];
  try {
    files = (await readdir(legacyDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  const destination = join(dataDirectory, "schedules");
  await mkdir(destination, { recursive: true });
  let imported = 0;
  for (const file of files) {
    const source = join(legacyDirectory, file);
    const content = await readFile(source, "utf8");
    const record = StoredScheduleSchema.parse(JSON.parse(content));
    if (file !== `${record.id}.json`) throw new Error(`Schedule file/id mismatch: ${file}`);
    const temporary = join(destination, `.${file}.${randomUUID()}.import`);
    try {
      // Publish complete bytes exclusively. A crash can leave an ignored temp
      // file, never a partially imported record or an overwritten plugin edit.
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await link(temporary, join(destination, file));
      imported += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await writeJsonFileAtomic(marker, { version: 1, importedAt: new Date().toISOString(), source: legacyDirectory });
  return imported;
}
