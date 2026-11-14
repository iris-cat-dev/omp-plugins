import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OmpAgent } from "@omp-desktop/client";
import { ScheduleService } from "./engine.js";
import { ScheduleStore } from "./store.js";
import { createApiHarness } from "./fixtures.test-support.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ScheduleService public execution", () => {
  let dir: string;
  let now: Date;
  let harness: ReturnType<typeof createApiHarness>;
  let service: ScheduleService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schedules-plugin-execution-"));
    now = new Date("2026-01-01T00:00:00.000Z");
    harness = createApiHarness(dir);
    service = new ScheduleService({ dataDirectory: dir, api: harness.api, native: harness.context.native, logger: harness.logger, now: () => now });
  });
  afterEach(async () => { await service.stop(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
  const create = (config = {}) => service.create({ prompt: "Audit flaky checkout flow", cadence: { type: "every" as const, everyMs: 60_000 }, target: { type: "new-agent" as const, config: { provider: "omp", cwd: dir, ...config } } });

  test("records create no workspace until execution and every retained run has its own workspace", async () => {
    const schedule = await create();
    expect(harness.workspaces).toEqual([]);
    await service.tick();
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const record = await service.inspect(schedule.id);
    expect(record.runs).toHaveLength(2);
    expect(record.runs[0].workspaceId).not.toBe(record.runs[1].workspaceId);
    expect(harness.workspaces.every((item) => !item.archived)).toBe(true);
  });

  test("resolves historical relative paths on the daemon without rewriting the stored target", async () => {
    harness.native.invoke.mockImplementation(async (operation) => operation === "files.resolve-path" ? dir : undefined);
    const schedule = await create({ cwd: "historic-project" });
    await service.tick();
    expect(harness.native.invoke).toHaveBeenCalledWith("files.resolve-path", { path: "historic-project" });
    expect(harness.createWorkspace).toHaveBeenCalledWith({ source: { kind: "directory", path: dir }, firstAgentContext: { prompt: schedule.prompt } });
    expect((await service.inspect(schedule.id)).target).toMatchObject({ config: { cwd: "historic-project" } });
  });

  test.each(["local", "worktree"] as const)("preserves %s placement and every persisted agent config field", async (isolation) => {
    const schedule = await create({ isolation, model: "anthropic/sonnet", modeId: "auto", thinkingOptionId: "high", archiveOnFinish: false, title: "Explicit title", providerOptions: { endpoint: "test" }, featureValues: { fast_mode: true }, systemPrompt: "A system prompt", mcpServers: { docs: { command: "docs" } } });
    await service.tick();
    expect(harness.createWorkspace).toHaveBeenCalledWith({ source: isolation === "worktree" ? { kind: "worktree", cwd: dir, action: "branch-off" } : { kind: "directory", path: dir }, firstAgentContext: { prompt: schedule.prompt } });
    expect(harness.createAgent.mock.calls[0][0]).toMatchObject({
      config: { provider: "omp/anthropic/sonnet", modeId: "auto", thinkingOptionId: "high", options: { endpoint: "test" }, featureValues: { fast_mode: true }, systemPrompt: "A system prompt", mcpServers: { docs: { command: "docs" } } },
      title: "Explicit title", unattended: true, background: true, notifyOnFinish: false,
      labels: { "paseo.schedule-id": schedule.id, "paseo.schedule-run": expect.any(String) },
    });
    expect(harness.run.mock.calls[0][1]).toMatchObject({ sourceKind: "service", requireIdle: true, timeoutMs: 0 });
    expect((await service.inspect(schedule.id)).runs[0]).toMatchObject({ status: "succeeded", agentId: expect.any(String), workspaceId: "wks_1", output: "done" });
  });

  test("uses the original prompt-derived title and sends slash prompts as normal service turns", async () => {
    const schedule = await service.create({ prompt: "/compact\nthen inspect", cadence: { type: "every", everyMs: 1000 }, target: { type: "new-agent", config: { provider: "omp", cwd: dir } } });
    await service.tick();
    expect(harness.createAgent.mock.calls[0][0].title).toBe("/compact");
    expect(harness.run.mock.calls[0][0]).toBe(schedule.prompt);
  });

  test.each([
    { lastMessage: "  ", finalText: " final answer ", output: "timeline", expected: "final answer" },
    { lastMessage: null, finalText: "", output: " timeline ", expected: "timeline" },
    { lastMessage: "answer", finalText: "other", output: "timeline", expected: "answer" },
  ])("retains last-message/final-text/timeline output precedence $expected", async ({ expected, ...result }) => {
    harness.run.mockResolvedValue({ status: "idle", final: null, error: null, ...result });
    const schedule = await create();
    await service.tick();
    expect((await service.logs(schedule.id))[0].output).toBe(expected);
  });

  test.each([
    { status: "idle" as const, canceled: true, error: null, expected: "was canceled" },
    { status: "permission" as const, canceled: false, error: null, expected: "waiting for permission" },
    { status: "error" as const, canceled: false, error: "provider failure", expected: "provider failure" },
  ])("records actual canceled/permission/error outcomes ($status, $canceled)", async ({ expected, ...result }) => {
    harness.run.mockResolvedValue({ final: null, lastMessage: null, ...result });
    const schedule = await create({ archiveOnFinish: true });
    await service.tick();
    const record = await service.inspect(schedule.id);
    expect(record.status).toBe("active");
    expect(record.runs[0].status).toBe("failed");
    expect(record.runs[0].error).toContain(expected);
    expect(record.runs[0].agentId).toBeTruthy();
    expect(harness.workspaces[0].archived).toBe(true);
  });

  test("archives a workspace even with archive opt-out when agent creation fails", async () => {
    harness.createAgent.mockRejectedValue(new Error("provider misconfigured"));
    const schedule = await create({ archiveOnFinish: false });
    await service.tick();
    expect(harness.workspaces[0].archived).toBe(true);
    expect((await service.logs(schedule.id))[0]).toMatchObject({ status: "failed", agentId: null, workspaceId: "wks_1", error: "provider misconfigured" });
  });

  test("preserves the run error when workspace archive also fails", async () => {
    harness.run.mockRejectedValue(new Error("run exploded"));
    harness.archive.mockRejectedValue(new Error("archive exploded"));
    const schedule = await create({ archiveOnFinish: true });
    await service.tick();
    expect((await service.logs(schedule.id))[0].error).toBe("run exploded");
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "wks_1" }), "Failed to archive scheduled workspace after run");
  });

  test.each(["missing", "file"] as const)("checks a %s cwd at run time and ends the schedule without allocating a workspace", async (kind) => {
    const cwd = join(dir, kind);
    if (kind === "file") await writeFile(cwd, "not a directory");
    const schedule = await create({ cwd });
    await service.update({ id: schedule.id, newAgentConfig: { cwd } });
    await service.tick();
    const record = await service.inspect(schedule.id);
    expect(record.status).toBe("completed");
    expect(record.runs[0].error).toContain(kind === "file" ? "not a directory" : "no longer exists");
    expect(harness.createWorkspace).not.toHaveBeenCalled();
  });

  test.each(["missing", "archived"] as const)("ends a heartbeat whose target is %s before running it", async (kind) => {
    const id = "11111111-1111-4111-8111-111111111111";
    if (kind === "archived") harness.agents.set(id, { id, cwd: dir, archivedAt: now.toISOString() } as OmpAgent);
    const schedule = await service.create({ prompt: "ping", cadence: { type: "every", everyMs: 1000 }, target: { type: "agent", agentId: id } });
    await service.tick();
    expect((await service.inspect(schedule.id)).status).toBe("completed");
    expect(harness.run).not.toHaveBeenCalled();
  });

  test("heartbeat uses authenticated existing target and original system notification wrapping", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    harness.agents.set(id, { id, cwd: dir, archivedAt: null } as OmpAgent);
    const schedule = await service.create({ name: "watch", prompt: "ping", cadence: { type: "every", everyMs: 1000 }, target: { type: "agent", agentId: id } });
    await service.tick();
    expect(harness.run.mock.calls[0][0]).toMatch(/^<paseo-system>\nSchedule "watch" fired .*\nping\n<\/paseo-system>$/);
    expect(harness.run.mock.calls[0][1]).toMatchObject({ requireIdle: true, sourceKind: "service" });
    expect((await service.logs(schedule.id))[0].agentId).toBe(id);
  });

  test("deleting an in-flight record never recreates it after a late result", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    harness.run.mockImplementation(async () => { started.resolve(); await finish.promise; return { status: "idle", final: null, error: null, lastMessage: "late" }; });
    const schedule = await create();
    const tick = service.tick();
    await started.promise;
    await service.delete(schedule.id);
    finish.resolve();
    await tick;
    expect(await service.list()).toEqual([]);
    await expect(new ScheduleStore(join(dir, "schedules")).get(schedule.id)).resolves.toBeNull();
  });

  test("deleting while workspace creation is in flight archives the orphan without creating an agent", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const original = harness.createWorkspace.getMockImplementation()!;
    harness.createWorkspace.mockImplementation(async (options) => { started.resolve(); await finish.promise; return original(options); });
    const schedule = await create();
    const tick = service.tick();
    await started.promise;
    await service.delete(schedule.id);
    finish.resolve();
    await tick;
    expect(harness.createAgent).not.toHaveBeenCalled();
    expect(harness.archive).toHaveBeenCalledWith("wks_1");
    expect(await service.list()).toEqual([]);
  });

  test("disable stops cadence, aborts only waiting, preserves running state, and activation recovers without replay", async () => {
    const started = deferred<void>();
    harness.run.mockImplementation(async (_prompt, options) => {
      started.resolve();
      return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("disabled")), { once: true }));
    });
    const schedule = await create({ archiveOnFinish: true });
    const tick = service.tick();
    await started.promise;
    await service.stop();
    await tick;
    expect((await service.logs(schedule.id))[0].status).toBe("running");
    expect(harness.archive).not.toHaveBeenCalled();
    await service.tick();
    expect(harness.run).toHaveBeenCalledTimes(1);
    now = new Date("2026-01-01T00:10:00.000Z");
    service = new ScheduleService({ dataDirectory: dir, api: harness.api, native: harness.context.native, logger: harness.logger, now: () => now });
    await service.start();
    const recovered = await service.inspect(schedule.id);
    expect(recovered.runs[0].status).toBe("failed");
    expect(harness.archive).toHaveBeenCalledWith("wks_1");
    expect(recovered.nextRunAt).toBe("2026-01-01T00:11:00.000Z");
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  test("expiry and failed completed runs consume the original terminal limits", async () => {
    harness.run.mockRejectedValue(new Error("transient failure"));
    const limited = await service.create({ prompt: "limited", cadence: { type: "every", everyMs: 1000 }, target: { type: "new-agent", config: { provider: "omp", cwd: dir } }, maxRuns: 1 });
    const expired = await service.create({ prompt: "expired", cadence: { type: "every", everyMs: 1000 }, target: { type: "new-agent", config: { provider: "omp", cwd: dir } }, expiresAt: now.toISOString() });
    await service.tick();
    expect((await service.inspect(limited.id)).status).toBe("completed");
    expect((await service.inspect(expired.id)).runs).toEqual([]);
    expect((await service.inspect(expired.id)).status).toBe("completed");
  });
});
