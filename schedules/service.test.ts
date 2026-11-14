import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginServiceContext } from "@omp-desktop/plugin/server";
import type { PluginCleanup } from "@omp-desktop/plugin";
import type { PluginRpcContract } from "@omp-desktop/plugin/server";
import type { OmpAgent } from "@omp-desktop/client";
import type { ZodType } from "zod";
import setup from "./service.js";
import { createApiHarness } from "./fixtures.test-support.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("scheduling plugin worker lifecycle", () => {
  let dir: string;
  let harness: ReturnType<typeof createApiHarness>;
  let controller: AbortController;
  let owned: PluginCleanup[];
  let handlers: Map<string, (input: unknown) => Promise<unknown>>;
  let ctx: PluginServiceContext;
  let nextChange: ReturnType<typeof deferred> | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schedule-service-"));
    harness = createApiHarness(dir);
    controller = new AbortController();
    owned = [];
    handlers = new Map();
    nextChange = undefined;
    const own = (cleanup: PluginCleanup): PluginCleanup => {
      let live = true;
      const release = () => { if (!live) return; live = false; return cleanup(); };
      owned.push(release);
      return release;
    };
    ctx = {
      ...harness.context,
      signal: controller.signal,
      installation: { id: "schedules", packageId: "schedules", owner: "daemon", version: "0.7.0", generation: 1, enabled: true, declaredCapabilities: [], grantedCapabilities: [] },
      own,
      native: { invoke: vi.fn(async (operation: string) => {
        if (operation === "files.data-directory") return join(dir, "plugins", "schedules");
        if (operation === "events.changed") nextChange?.resolve();
        return undefined;
      }) },
      handle: (contract: PluginRpcContract<ZodType, ZodType>, handler: (value: unknown) => unknown) => {
        handlers.set(contract.name, async (value) => contract.output.parseAsync(await handler(await contract.input.parseAsync(value))));
      },
    } as unknown as PluginServiceContext;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    controller.abort();
    for (const cleanup of owned.reverse()) await cleanup();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });
  test("registers complete named RPC contract and emits existing plugin notifications after durable changes", async () => {
    const cleanup = await setup(ctx);
    if (cleanup) owned.push(cleanup);
    expect([...handlers.keys()].sort()).toEqual(["schedules.create", "schedules.create-or-replace", "schedules.list", "schedules.inspect", "schedules.logs", "schedules.pause", "schedules.resume", "schedules.run-once", "schedules.delete", "schedules.update", "schedules.complete-for-agent"].sort());
    const schedule = await handlers.get("schedules.create")!({ prompt: "watch", cadence: { type: "cron", expression: "0 9 * * *" }, target: { type: "new-agent", config: { provider: "omp", cwd: dir } } }) as { id: string };
    expect(ctx.native.invoke).toHaveBeenCalledWith("events.changed", {});
    expect(await handlers.get("schedules.list")!({})).toMatchObject([{ id: schedule.id }]);
    expect(await handlers.get("schedules.delete")!({ id: schedule.id })).toEqual({ deleted: true });
    expect(await handlers.get("schedules.list")!({})).toEqual([]);
  });
  test("disable removes cadence timer and releases the dedicated agent observation lease", async () => {
    const cleanup = await setup(ctx);
    if (cleanup) owned.push(cleanup);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.agentListeners.size).toBe(1);
    controller.abort();
    for (const release of owned) await release();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.agentListeners.size).toBe(0);
  });
  test.each(["archive", "delete"] as const)("enabled plugin completes even paused heartbeats on target %s", async (operation) => {
    const id = "11111111-1111-4111-8111-111111111111";
    harness.agents.set(id, { id, cwd: dir, archivedAt: null } as OmpAgent);
    const cleanup = await setup(ctx);
    if (cleanup) owned.push(cleanup);
    const schedule = await handlers.get("schedules.create")!({ prompt: "watch", cadence: { type: "cron", expression: "0 9 * * *" }, target: { type: "agent", agentId: id } }) as { id: string };
    await handlers.get("schedules.pause")!({ id: schedule.id });
    nextChange = deferred();
    for (const listener of harness.agentListeners) listener(operation === "delete" ? { kind: "remove", agentId: id } : { kind: "upsert", agent: { id, archivedAt: new Date().toISOString() } });
    await nextChange.promise;
    expect(await handlers.get("schedules.inspect")!({ id: schedule.id })).toMatchObject({ status: "completed", nextRunAt: null, pausedAt: null });
  });
});
