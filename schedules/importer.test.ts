import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importLegacySchedules } from "./importer.js";
import { ScheduleService } from "./engine.js";
import { ScheduleStore } from "./store.js";
import { createApiHarness } from "./fixtures.test-support.js";

describe("canonical schedules installation import", () => {
  let home: string;
  let dataDirectory: string;
  let legacy: ScheduleStore;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "schedule-import-"));
    dataDirectory = join(home, "plugins", "schedules");
    legacy = new ScheduleStore(join(home, "schedules"));
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  async function record(status: "active" | "paused" | "completed" = "active") {
    return legacy.create({
      name: "historic", prompt: "watch", cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "omp", cwd: home, model: "anthropic/sonnet", modeId: "auto", thinkingOptionId: "high", isolation: "worktree", archiveOnFinish: true, title: "History", providerOptions: { endpoint: "custom" }, featureValues: { fast_mode: true }, systemPrompt: "system", mcpServers: { docs: { command: "docs" } } } },
      status, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
      nextRunAt: status === "active" ? "2026-01-01T00:02:00.000Z" : null,
      lastRunAt: "2026-01-01T00:01:00.000Z", pausedAt: status === "paused" ? "2026-01-01T00:01:00.000Z" : null,
      expiresAt: "2027-01-01T00:00:00.000Z", maxRuns: 10,
      runs: [{ id: "run-history", scheduledFor: "2026-01-01T00:01:00.000Z", startedAt: "2026-01-01T00:01:00.000Z", endedAt: "2026-01-01T00:01:30.000Z", status: "succeeded", agentId: "11111111-1111-4111-8111-111111111111", workspaceId: "wks_history", output: "historic output", error: null }],
    });
  }
  test("copies exact original records, retains every field and keeps recovery originals", async () => {
    const records = await Promise.all([record(), record("paused"), record("completed")]);
    expect(await importLegacySchedules(dataDirectory, "schedules")).toBe(3);
    expect(await new ScheduleStore(join(dataDirectory, "schedules")).list()).toEqual(await legacy.list());
    for (const value of records) {
      expect(await readFile(join(dataDirectory, "schedules", `${value.id}.json`), "utf8")).toBe(await readFile(join(home, "schedules", `${value.id}.json`), "utf8"));
    }
  });
  test("durable one-time marker prevents resurrection of deleted records or import of later originals", async () => {
    const original = await record();
    await importLegacySchedules(dataDirectory, "schedules");
    const store = new ScheduleStore(join(dataDirectory, "schedules"));
    await store.delete(original.id);
    await record();
    expect(await importLegacySchedules(dataDirectory, "schedules")).toBe(0);
    expect(await store.list()).toEqual([]);
    expect(await legacy.list()).toHaveLength(2);
  });
  test("resumes partial import without overwriting a record already edited inside the plugin", async () => {
    const original = await record();
    const destination = join(dataDirectory, "schedules");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, `${original.id}.json`), JSON.stringify({ ...original, prompt: "edited inside plugin" }));
    await record("paused");
    expect(await importLegacySchedules(dataDirectory, "schedules")).toBe(1);
    expect((await new ScheduleStore(destination).get(original.id))?.prompt).toBe("edited inside plugin");
  });
  test("noncanonical installations neither import nor run historic records", async () => {
    await record();
    const other = join(home, "plugins", "schedules-copy");
    expect(await importLegacySchedules(other, "schedules-copy")).toBe(0);
    expect(await new ScheduleStore(join(other, "schedules")).list()).toEqual([]);
  });
  test("import activation advances stale cadence without replay and leaves paused/ended history intact", async () => {
    const active = await record();
    const paused = await record("paused");
    const completed = await record("completed");
    await importLegacySchedules(dataDirectory, "schedules");
    const harness = createApiHarness(home);
    const service = new ScheduleService({ dataDirectory, api: harness.api, native: harness.context.native, logger: harness.logger, now: () => new Date("2026-01-01T00:10:00.000Z") });
    await service.start();
    try {
      expect((await service.inspect(active.id)).nextRunAt).toBe("2026-01-01T00:11:00.000Z");
      expect(await service.inspect(paused.id)).toEqual(paused);
      expect(await service.inspect(completed.id)).toEqual(completed);
      expect(harness.run).not.toHaveBeenCalled();
    } finally { await service.stop(); }
  });
  test("marks an empty historical directory imported once", async () => {
    expect(await importLegacySchedules(dataDirectory, "schedules")).toBe(0);
    await record();
    expect(await importLegacySchedules(dataDirectory, "schedules")).toBe(0);
    expect(await new ScheduleStore(join(dataDirectory, "schedules")).list()).toEqual([]);
  });
});
