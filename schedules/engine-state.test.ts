import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OmpAgent } from "@omp-desktop/client";
import { ScheduleService, ScheduleTargetGoneError, type ScheduleServiceOptions } from "./engine.js";
import { ScheduleStore } from "./store.js";
import { createApiHarness } from "./fixtures.test-support.js";

// Cadence, CRUD, counters, recovery and concurrency expectations relocated
// from the former core service suite; execution uses the public API fixture.
describe("ScheduleService persisted state", () => {
  let tempDir: string;
  let now: Date;
  let harness: ReturnType<typeof createApiHarness>;
  let services: ScheduleService[];
  const createTestLogger = () => harness.logger;
  const agentStorage = { upsert: async (record: { id: string; [key: string]: unknown }) => { harness.agents.set(record.id, record as unknown as OmpAgent); } };
  function createScheduleService(options: Omit<ScheduleServiceOptions, "api" | "native"> & { archiveWorkspace?: (id: string) => Promise<void> }) {
    if (options.archiveWorkspace) {
      const archive = options.archiveWorkspace;
      harness.archive.mockImplementation(async (id) => { await archive(id); return { requestId: "archive", workspaceId: id, archivedAt: now.toISOString(), error: null }; });
    }
    const service = new ScheduleService({ ...options, api: harness.api, native: harness.context.native });
    services.push(service);
    return service;
  }
  function buildAgentRecord(params: { id: string; cwd: string; iso: string; archivedAt?: string | null }) {
    return { id: params.id, cwd: params.cwd, provider: "claude", archivedAt: params.archivedAt ?? null, createdAt: params.iso, updatedAt: params.iso };
  }
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-plugin-state-"));
    now = new Date("2026-01-01T00:00:00.000Z");
    harness = createApiHarness(tempDir);
    services = [];
  });
  afterEach(async () => {
    await Promise.all(services.map(service => service.stop()));
    await rm(tempDir, { recursive: true, force: true });
  });
test("ticks due schedules and records run history on disk", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async (schedule) => ({
            agentId: "00000000-0000-0000-0000-000000000001",
            output: `ran:${schedule.prompt}`
        })
    });
    const created = await service.create({
        prompt: "Review new PRs",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir
            }
        }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
        status: "succeeded",
        agentId: "00000000-0000-0000-0000-000000000001",
        output: "ran:Review new PRs"
    });
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
});

test("pause and resume update persisted schedule state", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({
            agentId: null,
            output: "ok"
        })
    });
    const created = await service.create({
        prompt: "Check status",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir
            }
        }
    });
    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();
    now = new Date("2026-01-01T00:03:00.000Z");
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
});

test("completes schedules when max runs is reached", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({
            agentId: null,
            output: "done"
        })
    });
    const created = await service.create({
        prompt: "One shot",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir
            }
        },
        maxRuns: 1
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
});

test("new-agent schedule records create no workspace until run time", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "server-owned workspace happens at run time",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                model: "test-model",
                cwd: tempDir
            }
        },
        runOnCreate: false
    });
    expect(created.target.config).toMatchObject({
        provider: "claude",
        model: "test-model",
        cwd: tempDir
    });
    expect(harness.workspaces).toEqual([]);
});

test("new-agent cwd existence is checked at run time, not when editing the schedule", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "missing cwd can be configured",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: join(tempDir, "does-not-exist") }
        },
        runOnCreate: false
    });
    const updated = await service.update({
        id: created.id,
        newAgentConfig: { cwd: join(tempDir, "also-missing") }
    });
    expect(updated.target.config).toMatchObject({
        provider: "claude",
        cwd: join(tempDir, "also-missing")
    });
});

test("concurrent run finish and update preserve the target config and run outcome", async () => {
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
        finishRun = resolve;
    });
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
        releaseRun = resolve;
    });
    const store = new ScheduleStore(join(tempDir, "schedules"));
    const legacy = await store.create({
        name: null,
        prompt: "finish/update race",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                model: "test-model",
                cwd: tempDir
            }
        },
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        nextRunAt: now.toISOString(),
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
        runs: []
    });
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => {
            releaseRun?.();
            await runBlocked;
            return {
                agentId: null,
                output: "finished while updating"
            };
        }
    });
    const tickPromise = service.tick();
    await runStarted;
    const updatePromise = service.update({
        id: legacy.id,
        newAgentConfig: { modeId: "full-access" }
    });
    finishRun?.();
    await Promise.all([tickPromise, updatePromise]);
    const inspected = await service.inspect(legacy.id);
    expect(inspected.target).toMatchObject({
        type: "new-agent",
        config: {
            modeId: "full-access"
        }
    });
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
        status: "succeeded",
        output: "finished while updating",
        error: null
    });
});

test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service1.create({
        prompt: "Periodic check",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        },
        runOnCreate: false
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
    await service1.stop();
    // Simulate daemon restart 10 minutes later
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    await service2.start();
    const inspected = await service2.inspect(created.id);
    expect(new Date(inspected.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    await service2.stop();
});

test("startup recovery archives an interrupted run workspace with an associated agent", async () => {
    const service1 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service1.create({
        prompt: "Interrupted after creating an agent",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir, archiveOnFinish: true }
        },
        runOnCreate: false
    });
    await service1.stop();
    const interruptedAt = now.toISOString();
    const associatedAgentId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "wks_interrupted_with_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"));
    await store.update(created.id, (schedule) => ({
        ...schedule,
        runs: [
            ...schedule.runs,
            {
                id: "run-interrupted-with-agent",
                scheduledFor: interruptedAt,
                startedAt: interruptedAt,
                endedAt: null,
                status: "running",
                agentId: associatedAgentId,
                workspaceId,
                output: null,
                error: null
            },
        ]
    }));
    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" }),
        archiveWorkspace: async (archivedWorkspaceId) => {
            archiveCalls.push(archivedWorkspaceId);
        }
    });
    await service2.start();
    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
        status: "failed",
        agentId: associatedAgentId,
        error: "Daemon restarted before the scheduled run completed"
    });
    await service2.stop();
});

test("startup recovery archives an interrupted run workspace even before agent association", async () => {
    const service1 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service1.create({
        prompt: "Interrupted before creating an agent",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir, archiveOnFinish: false }
        },
        runOnCreate: false
    });
    await service1.stop();
    const interruptedAt = now.toISOString();
    const workspaceId = "wks_interrupted_without_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"));
    await store.update(created.id, (schedule) => ({
        ...schedule,
        runs: [
            ...schedule.runs,
            {
                id: "run-interrupted-without-agent",
                scheduledFor: interruptedAt,
                startedAt: interruptedAt,
                endedAt: null,
                status: "running",
                agentId: null,
                workspaceId,
                output: null,
                error: null
            },
        ]
    }));
    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" }),
        archiveWorkspace: async (archivedWorkspaceId) => {
            archiveCalls.push(archivedWorkspaceId);
        }
    });
    await service2.start();
    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
        status: "failed",
        agentId: null,
        error: "Daemon restarted before the scheduled run completed"
    });
    await service2.stop();
});

test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
        releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
        finishRun = resolve;
    });
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => {
            releaseRun?.();
            await runBlocked;
            return {
                agentId: null,
                output: "finished"
            };
        }
    });
    const created = await service.create({
        prompt: "Check status",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir
            }
        }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    const tickPromise = service.tick();
    await runStarted;
    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();
    finishRun?.();
    await tickPromise;
    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("paused");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
});

test("defaults --every schedules to fire immediately on creation", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "every default",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        }
    });
    expect(created.nextRunAt).toBe(now.toISOString());
});

test("--every with runOnCreate=false waits the full interval", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "wait interval",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        },
        runOnCreate: false
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
});

test("--cron defaults to the next cron slot", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "cron default",
        cadence: { type: "cron", expression: "30 9 * * *" },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        }
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
});

test("--cron with runOnCreate=true fires immediately on creation", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "cron run-now",
        cadence: { type: "cron", expression: "30 9 * * *" },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        },
        runOnCreate: true
    });
    expect(created.nextRunAt).toBe(now.toISOString());
});

test("runOnce records a run without changing nextRunAt or completing the schedule", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async (schedule) => ({
            agentId: "00000000-0000-0000-0000-000000000099",
            output: `manual:${schedule.prompt}`
        })
    });
    const created = await service.create({
        prompt: "manual fire",
        cadence: { type: "cron", expression: "30 9 * * *" },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        },
        maxRuns: 1
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    const after = await service.runOnce(created.id);
    expect(after.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(after.status).toBe("active");
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
        status: "succeeded",
        agentId: "00000000-0000-0000-0000-000000000099",
        output: "manual:manual fire"
    });
});

test("update mutates cadence, prompt, name, and target fields in place", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        name: "morning",
        prompt: "first prompt",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir, modeId: "default" }
        }
    });
    expect(created.runs).toEqual([]);
    now = new Date("2026-01-01T00:00:30.000Z");
    const nextCwd = join(tempDir, "new-path");
    await mkdir(nextCwd, { recursive: true });
    const updated = await service.update({
        id: created.id,
        prompt: "second prompt",
        name: "renamed",
        cadence: { type: "every", everyMs: 5 * 60000 },
        newAgentConfig: {
            provider: "codex",
            model: "gpt-5",
            modeId: "full-access",
            thinkingOptionId: "deep-thought",
            archiveOnFinish: false,
            isolation: "worktree",
            cwd: nextCwd
        }
    });
    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60000 });
    expect(updated.target).toEqual({
        type: "new-agent",
        config: {
            provider: "codex",
            cwd: nextCwd,
            model: "gpt-5",
            modeId: "full-access",
            thinkingOptionId: "deep-thought",
            archiveOnFinish: false,
            isolation: "worktree"
        }
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
});

test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:00:00.000Z");
    const cron = await service.update({
        id: created.id,
        cadence: { type: "cron", expression: "30 9 * * *" }
    });
    expect(cron.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(cron.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    const back = await service.update({
        id: created.id,
        cadence: { type: "every", everyMs: 2 * 60000 }
    });
    expect(back.cadence).toEqual({ type: "every", everyMs: 2 * 60000 });
    expect(back.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
});

test("update preserves a cron cadence timezone when the new cadence omits it", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "p",
        cadence: {
            type: "cron",
            expression: "0 9 * * *",
            timezone: "America/New_York"
        },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    const updated = await service.update({
        id: created.id,
        cadence: { type: "cron", expression: "30 9 * * *" }
    });
    expect(updated.cadence).toEqual({
        type: "cron",
        expression: "30 9 * * *",
        timezone: "America/New_York"
    });
});

test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ran" })
    });
    const created = await service.create({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const after = await service.inspect(created.id);
    expect(after.runs).toHaveLength(1);
    now = new Date("2026-01-01T00:01:30.000Z");
    const updated = await service.update({ id: created.id, prompt: "new prompt" });
    expect(updated.prompt).toBe("new prompt");
    expect(updated.cadence).toEqual(created.cadence);
    expect(updated.nextRunAt).toBe(after.nextRunAt);
    expect(updated.runs).toEqual(after.runs);
    expect(updated.lastRunAt).toBe(after.lastRunAt);
});

test("update clears the schedule name when given an empty string", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        name: "named",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    expect(created.name).toBe("named");
    const cleared = await service.update({ id: created.id, name: "" });
    expect(cleared.name).toBeNull();
    const renamed = await service.update({ id: created.id, name: "again" });
    expect(renamed.name).toBe("again");
});

test("update rejects new-agent fields on agent-target schedules", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "agent target",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000005" }
    });
    await expect(service.update({
        id: created.id,
        newAgentConfig: { provider: "codex" }
    })).rejects.toThrow("only valid for new-agent target schedules");
});

test("update changes individual new-agent fields independently", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir, model: "sonnet", modeId: "default" }
        }
    });
    const modeOnly = await service.update({
        id: created.id,
        newAgentConfig: { modeId: "bypassPermissions" }
    });
    expect(modeOnly.target).toMatchObject({
        type: "new-agent",
        config: {
            provider: "claude",
            cwd: tempDir,
            model: "sonnet",
            modeId: "bypassPermissions"
        }
    });
    const clearModel = await service.update({
        id: created.id,
        newAgentConfig: { model: null }
    });
    if (clearModel.target.type !== "new-agent") {
        throw new Error("target type changed unexpectedly");
    }
    expect(clearModel.target.config.model).toBeUndefined();
    expect(clearModel.target.config.modeId).toBe("bypassPermissions");
});

test("update returns a schedule that round-trips through the store", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    await service.update({
        id: created.id,
        cadence: { type: "cron", expression: "0 9 * * *" },
        newAgentConfig: { provider: "codex", modeId: "full-access" }
    });
    const reloaded = await service.inspect(created.id);
    expect(reloaded.cadence).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(reloaded.target).toEqual({
        type: "new-agent",
        config: {
            provider: "codex",
            cwd: tempDir,
            modeId: "full-access"
        }
    });
});

test("runOnce rejects completed schedules", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const created = await service.create({
        prompt: "one-shot",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        },
        maxRuns: 1
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    await expect(service.runOnce(created.id)).rejects.toThrow("already completed");
});

test("completeForAgent completes only schedules targeting that agent", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const targetAgentId = "11111111-1111-4111-8111-111111111111";
    const otherAgentId = "22222222-2222-4222-8222-222222222222";
    const targeted = await service.create({
        prompt: "ping the doomed agent",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: targetAgentId }
    });
    const otherTargeted = await service.create({
        prompt: "ping the other agent",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: otherAgentId }
    });
    const newAgentSchedule = await service.create({
        prompt: "spawn a fresh agent",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: { provider: "claude", cwd: tempDir }
        }
    });
    now = new Date("2026-01-01T00:05:00.000Z");
    const completed = await service.completeForAgent(targetAgentId);
    expect(completed).toBe(1);
    const remaining = await service.list();
    expect(remaining.map((schedule) => schedule.id).sort()).toEqual([targeted.id, otherTargeted.id, newAgentSchedule.id].sort());
    const doomed = await service.inspect(targeted.id);
    expect(doomed.status).toBe("completed");
    expect(doomed.nextRunAt).toBeNull();
    expect(doomed.updatedAt).toBe("2026-01-01T00:05:00.000Z");
    expect((await service.inspect(otherTargeted.id)).status).toBe("active");
    expect((await service.inspect(newAgentSchedule.id)).status).toBe("active");
});

test("startup sweep completes agent-target schedules whose agent is gone", async () => {
    const missingAgentId = "44444444-4444-4444-8444-444444444444";
    const archivedAgentId = "55555555-5555-4555-8555-555555555555";
    const liveAgentId = "66666666-6666-4666-8666-666666666666";
    await agentStorage.upsert(buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z"
    }));
    await agentStorage.upsert(buildAgentRecord({ id: liveAgentId, cwd: tempDir, iso: now.toISOString() }));
    const service1 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const missing = await service1.create({
        prompt: "ping missing",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: missingAgentId }
    });
    const archived = await service1.create({
        prompt: "ping archived",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: archivedAgentId }
    });
    const live = await service1.create({
        prompt: "ping live",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: liveAgentId }
    });
    const newAgent = await service1.create({
        prompt: "spawn fresh",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    const pausedMissing = await service1.create({
        prompt: "paused ping missing",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" }
    });
    await service1.pause(pausedMissing.id);
    const pausedLive = await service1.create({
        prompt: "paused ping live",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: liveAgentId }
    });
    await service1.pause(pausedLive.id);
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    await service2.start();
    await service2.stop();
    expect((await service2.inspect(missing.id)).status).toBe("completed");
    expect((await service2.inspect(missing.id)).nextRunAt).toBeNull();
    expect((await service2.inspect(archived.id)).status).toBe("completed");
    expect((await service2.inspect(live.id)).status).toBe("active");
    expect((await service2.inspect(newAgent.id)).status).toBe("active");
    // Paused schedules are swept too when their agent is gone, but survive when it lives.
    expect((await service2.inspect(pausedMissing.id)).status).toBe("completed");
    expect((await service2.inspect(pausedLive.id)).status).toBe("paused");
});

test("completes the schedule when a scheduled run reports the target is gone", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => {
            throw new ScheduleTargetGoneError("Agent 77777777-7777-4777-8777-777777777777 is archived");
        }
    });
    const created = await service.create({
        prompt: "ping gone target",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: "77777777-7777-4777-8777-777777777777" }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("Agent 77777777-7777-4777-8777-777777777777 is archived");
});

test("does not resurrect nextRunAt when the schedule completes during an in-flight run", async () => {
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let service!: ScheduleService;
    service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => {
            // Simulate the agent being archived mid-run: the archive callback
            // completes the schedule before this run finishes.
            await service.completeForAgent(agentId);
            return { agentId: null, output: "ok" };
        }
    });
    const created = await service.create({
        prompt: "ping",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("succeeded");
});

test("keeps the schedule active when a run fails for a transient reason", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => {
            throw new Error("network blip");
        }
    });
    const created = await service.create({
        prompt: "ping flaky target",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("network blip");
});

test("createOrReplace updates the matching schedule in place instead of duplicating", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
        name: "babysit-pr PR 1112",
        prompt: "watch the build",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId }
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(first.id)).runs).toHaveLength(1);
    await service.pause(first.id);
    now = new Date("2026-01-01T00:02:00.000Z");
    const second = await service.createOrReplace({
        name: "babysit-pr PR 1112",
        prompt: "watch the build v2",
        cadence: { type: "cron", expression: "30 9 * * *" },
        target: { type: "agent", agentId }
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.prompt).toBe("watch the build v2");
    expect(second.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(second.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.runs).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
});

test("createOrReplace preserves an existing cron timezone when replacement omits timezone", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
        name: "timezone-aware cron",
        prompt: "watch the build",
        cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
        target: { type: "agent", agentId }
    });
    const second = await service.createOrReplace({
        name: "timezone-aware cron",
        prompt: "watch the build v2",
        cadence: { type: "cron", expression: "30 9 * * *" },
        target: { type: "agent", agentId }
    });
    expect(second.id).toBe(first.id);
    expect(second.cadence).toEqual({
        type: "cron",
        expression: "30 9 * * *",
        timezone: "America/New_York"
    });
    expect(await service.list()).toHaveLength(1);
});

test("createOrReplace creates a sibling when name, target, or completion differ", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const agentA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const agentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await service.createOrReplace({
        name: "dup",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: agentA }
    });
    await service.createOrReplace({
        name: "other",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: agentA }
    });
    await service.createOrReplace({
        name: "dup",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: agentB }
    });
    const done = await service.createOrReplace({
        name: "done",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: agentA },
        maxRuns: 1
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(done.id)).status).toBe("completed");
    const redone = await service.createOrReplace({
        name: "done",
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId: agentA }
    });
    expect(redone.id).not.toBe(done.id);
    expect(await service.list()).toHaveLength(5);
});

test("createOrReplace never dedups anonymous schedules", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const agentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await service.createOrReplace({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId }
    });
    await service.createOrReplace({
        prompt: "p",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId }
    });
    expect(await service.list()).toHaveLength(2);
});

test("createOrReplace matches new-agent targets by config", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const first = await service.createOrReplace({
        name: "nightly",
        prompt: "audit",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    const second = await service.createOrReplace({
        name: "nightly",
        prompt: "audit v2",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
    const subCwd = join(tempDir, "sub");
    await mkdir(subCwd, { recursive: true });
    const third = await service.createOrReplace({
        name: "nightly",
        prompt: "audit elsewhere",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: subCwd } }
    });
    expect(third.id).not.toBe(first.id);
    expect(await service.list()).toHaveLength(2);
});

test("concurrent createOrReplace first creates share one schedule", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const firstPromise = service.createOrReplace({
        name: "nightly race",
        prompt: "audit",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    const secondPromise = service.createOrReplace({
        name: "nightly race",
        prompt: "audit",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } }
    });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
});

test("createOrReplace dedups new-agent targets regardless of config key order", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    // The stored config is round-tripped through the Zod schema (schema key
    // order); this incoming literal deliberately uses a different key order.
    const first = await service.createOrReplace({
        name: "nightly",
        prompt: "audit",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir,
                providerOptions: { allowedTools: ["Read"] },
                title: "nightly job"
            }
        }
    });
    const second = await service.createOrReplace({
        name: "nightly",
        prompt: "audit v2",
        cadence: { type: "every", everyMs: 60000 },
        target: {
            type: "new-agent",
            config: {
                provider: "claude",
                cwd: tempDir,
                providerOptions: { allowedTools: ["Read"] },
                title: "nightly job"
            }
        }
    });
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
});

test("completeForAgent skips schedules that are already completed", async () => {
    const service = createScheduleService({
        dataDirectory: tempDir,
        logger: createTestLogger(),
        now: () => now,
        runner: async () => ({ agentId: null, output: "ok" })
    });
    const agentId = "33333333-3333-4333-8333-333333333333";
    await service.create({
        prompt: "already done",
        cadence: { type: "every", everyMs: 60000 },
        target: { type: "agent", agentId },
        maxRuns: 1
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    expect(await service.completeForAgent(agentId)).toBe(1);
    expect(await service.completeForAgent(agentId)).toBe(0);
});
});
