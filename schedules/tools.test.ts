import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OmpAgent } from "@omp-desktop/client";
import { ScheduleService } from "./engine.js";
import { createApiHarness } from "./fixtures.test-support.js";
import { buildScheduleUpdateInput, registerScheduleTools, updateScheduleToolInput } from "./tools.js";

const callerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
describe("installation-owned scheduling agent tools", () => {
  let dir: string;
  let harness: ReturnType<typeof createApiHarness>;
  let service: ScheduleService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schedule-tools-"));
    harness = createApiHarness(dir);
    harness.agents.set(callerId, { id: callerId, provider: "omp", cwd: dir, currentModeId: "auto", archivedAt: null } as OmpAgent);
    harness.configurations.set(callerId, { provider: "omp/anthropic/sonnet", model: "anthropic/sonnet", cwd: dir, thinkingOptionId: "high", options: { endpoint: "custom" }, featureValues: { fast_mode: true }, systemPrompt: "system", mcpServers: { docs: { command: "docs" } } });
    service = new ScheduleService({ dataDirectory: dir, api: harness.api, native: harness.context.native, logger: harness.logger });
    registerScheduleTools(harness.context, service);
  });
  afterEach(async () => { await service.stop(); await rm(dir, { recursive: true, force: true }); });
  async function call(name: string, input: unknown, agentId = callerId) {
    const definition = harness.toolDefinitions.get(name)!;
    return await definition.handler(await definition.input.parseAsync(input), { agentId, turnId: "turn", signal: new AbortController().signal }) as { structuredContent: Record<string, unknown> };
  }
  const cadence = { prompt: "watch", cron: "*/5 * * * *" };
  test("inherits every caller config field and authenticates caller identity", async () => {
    const result = await call("create_schedule", { ...cadence, name: "nightly" });
    expect(result.structuredContent.target).toEqual({ type: "new-agent", config: { provider: "omp", model: "anthropic/sonnet", cwd: dir, modeId: "auto", thinkingOptionId: "high", providerOptions: { endpoint: "custom" }, featureValues: { fast_mode: true }, systemPrompt: "system", mcpServers: { docs: { command: "docs" } } } });
    await expect(call("create_schedule", { ...cadence, callerAgentId: otherId })).rejects.toThrow();
  });
  test("explicit provider/model overrides use real provider validation and retain slash model IDs", async () => {
    const result = await call("create_schedule", { ...cadence, provider: "omp/openai/gpt", cwd: "/another", isolation: "worktree" });
    expect(result.structuredContent.target).toMatchObject({ config: { provider: "omp", model: "openai/gpt", cwd: "/another", isolation: "worktree" } });
    harness.resolveCreateConfig.mockRejectedValueOnce(new Error("Invalid model selection"));
    await expect(call("create_schedule", { ...cadence, provider: "omp/invalid" })).rejects.toThrow("Invalid model selection");
    expect(await service.list()).toHaveLength(1);
  });
  test("provider overrides retain inherited thinking/features without validating provider-specific fields early", async () => {
    harness.resolveCreateConfig.mockImplementation(async (config) => {
      if ("modeId" in config || "thinkingOptionId" in config || "featureValues" in config) throw new Error("Provider-specific validation belongs to execution");
      return config;
    });
    const result = await call("create_schedule", { ...cadence, provider: "codex/gpt" });
    expect(result.structuredContent.target).toEqual({ type: "new-agent", config: { provider: "codex", model: "gpt", cwd: dir, thinkingOptionId: "high", featureValues: { fast_mode: true }, systemPrompt: "system", mcpServers: { docs: { command: "docs" } } } });
  });
  test.each(["/model", "omp/", " "])("rejects malformed provider syntax %j", async (provider) => {
    await expect(call("create_schedule", { ...cadence, provider })).rejects.toThrow();
    expect(await service.list()).toEqual([]);
  });
  test("heartbeat uses context.agentId and rejects deleting another agent's heartbeat", async () => {
    const heartbeat = await call("create_heartbeat", { ...cadence, timezone: "America/New_York", name: "watch", maxRuns: 2, expiresIn: "1h" });
    const id = String(heartbeat.structuredContent.id);
    expect(heartbeat.structuredContent.target).toEqual({ type: "agent", agentId: callerId });
    expect(heartbeat.structuredContent.cadence).toEqual({ type: "cron", expression: cadence.cron, timezone: "America/New_York" });
    await expect(call("delete_heartbeat", { id }, otherId)).rejects.toThrow("does not belong to caller");
    expect((await service.inspect(id)).target).toEqual({ type: "agent", agentId: callerId });
    expect((await call("delete_heartbeat", { id })).structuredContent).toEqual({ success: true });
    expect(await service.list()).toEqual([]);
  });
  test("missing caller context cannot create heartbeat or read an inherited configuration", async () => {
    await expect(call("create_heartbeat", cadence, "")).rejects.toThrow("agent-scoped");
    await expect(call("create_schedule", cadence, otherId)).rejects.toThrow("Parent agent");
  });
  test("all public schedule CRUD intents exclude heartbeat records", async () => {
    const heartbeat = await call("create_heartbeat", cadence);
    const id = String(heartbeat.structuredContent.id);
    expect((await call("list_schedules", {})).structuredContent).toEqual({ schedules: [] });
    for (const tool of ["inspect_schedule", "pause_schedule", "resume_schedule", "delete_schedule", "update_schedule", "schedule_logs", "run_schedule_once"]) {
      await expect(call(tool, { id })).rejects.toThrow("Schedule not found");
    }
    await expect(call("delete_heartbeat", { id: String((await call("create_schedule", cadence)).structuredContent.id) })).rejects.toThrow("Heartbeat not found");
  });
  test("create rejects removed every fields, missing cron, blank timezone, and invalid zones", async () => {
    await expect(call("create_schedule", { prompt: "watch", every: "5m" })).rejects.toThrow();
    await expect(call("create_schedule", { ...cadence, every: "5m" })).rejects.toThrow();
    await expect(call("create_schedule", { prompt: "watch" })).rejects.toThrow();
    await expect(call("create_schedule", { ...cadence, timezone: " " })).rejects.toThrow();
    await expect(call("create_schedule", { ...cadence, timezone: "Invalid/Zone" })).rejects.toThrow("Invalid cron time zone");
  });
  test("update preserves cron timezone, merges provider/model patches, validates provider/model before persisting, and rejects conflicts", async () => {
    const result = await call("create_schedule", { ...cadence, timezone: "America/New_York" });
    const id = String(result.structuredContent.id);
    const updated = await call("update_schedule", { id, cron: "0 9 * * *", provider: "omp/openai/gpt", mode: "full", name: null, maxRuns: null, clearExpires: true });
    expect(updated.structuredContent.cadence).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "America/New_York" });
    expect(updated.structuredContent.target).toMatchObject({ config: { model: "openai/gpt", modeId: "full", systemPrompt: "system" } });
    await expect(call("update_schedule", { id, provider: "omp/openai/gpt", model: "different" })).rejects.toThrow("Conflicting model");
    await expect(call("update_schedule", { id, provider: "omp/openai/gpt", model: null })).rejects.toThrow("model is null");
    harness.resolveCreateConfig.mockRejectedValueOnce(new Error("Invalid model"));
    await expect(call("update_schedule", { id, provider: "omp/invalid" })).rejects.toThrow("Invalid model");
    expect((await service.inspect(id)).target).toMatchObject({ config: { modeId: "full" } });
  });
  test("update persists mode and inherited thinking/features without early provider-specific validation", async () => {
    const created = await call("create_schedule", cadence);
    const id = String(created.structuredContent.id);
    harness.resolveCreateConfig.mockClear();
    harness.resolveCreateConfig.mockImplementation(async (config) => {
      if ("modeId" in config || "thinkingOptionId" in config || "featureValues" in config) throw new Error("Provider-specific validation belongs to execution");
      return config;
    });
    const updated = await call("update_schedule", { id, provider: "codex/gpt", mode: "future-provider-mode" });
    expect(updated.structuredContent.target).toMatchObject({ config: { provider: "codex", model: "gpt", modeId: "future-provider-mode", thinkingOptionId: "high", featureValues: { fast_mode: true }, providerOptions: { endpoint: "custom" }, systemPrompt: "system", mcpServers: { docs: { command: "docs" } } } });
  });
  test("update retains original hidden every canonicalization and expiry constraints", () => {
    expect(buildScheduleUpdateInput(updateScheduleToolInput.parse({ id: "x", every: "5m" })).cadence).toEqual({ type: "cron", expression: "*/5 * * * *" });
    expect(() => buildScheduleUpdateInput(updateScheduleToolInput.parse({ id: "x", every: "5m", cron: "0 9 * * *" }))).toThrow("at most one");
    expect(() => buildScheduleUpdateInput(updateScheduleToolInput.parse({ id: "x", timezone: "UTC" }))).toThrow("only be used with cron");
    expect(() => buildScheduleUpdateInput(updateScheduleToolInput.parse({ id: "x", expiresIn: "1h", clearExpires: true }))).toThrow("at most one");
  });
});
