import { describe, expect, it } from "vitest";
import type { ScheduleSummary } from "@omp-desktop/protocol/schedule/types";
import { openScheduleForm } from "./schedule-form-model";
import { buildScheduleCreate, buildScheduleUpdate, validateScheduleDraft } from "./submission";

const schedule: ScheduleSummary = { id: "schedule", name: "Nightly", prompt: "Run", cadence: { type: "every", everyMs: 90 * 60_000 }, target: { type: "new-agent", config: { provider: "omp", cwd: "/repo", isolation: "worktree", archiveOnFinish: true } }, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextRunAt: null, lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null };
function form(value: ScheduleSummary = schedule) {
  return openScheduleForm({ mode: "edit", schedule: { ...value, serverId: "a" }, hosts: [{ serverId: "a", label: "A", supportsWorkspaceMultiplicity: true }], defaults: { projectTargets: [{ optionId: "project:a:repo", serverId: "a", serverName: "A", projectName: "Repo", projectViewKey: "repo", cwd: "/repo", isGit: true }] } });
}
describe("schedule submissions", () => {
  it("preserves exact legacy cadence and stored worktree isolation on an unrelated edit", () => {
    const model = form(); model.setName("Renamed");
    const update = buildScheduleUpdate(model.getState(), schedule, "");
    expect(update).not.toHaveProperty("cadence");
    expect(update.newAgentConfig).toMatchObject({ isolation: "worktree", archiveOnFinish: true, cwd: "/repo" });
  });
  it("supports explicit interval editing without rounding or cron conversion", () => {
    const model = form(); model.setCadence({ type: "every", everyMs: 90_001 });
    expect(buildScheduleUpdate(model.getState(), schedule, "").cadence).toEqual({ type: "every", everyMs: 90_001 });
  });
  it("updates a heartbeat without changing its agent target or prompt", () => {
    const heartbeat: ScheduleSummary = { ...schedule, target: { type: "agent", agentId: "00000000-0000-4000-8000-000000000000" } };
    const model = form(heartbeat); model.setMaxRuns("4");
    const update = buildScheduleUpdate(model.getState(), heartbeat, "2026-12-01T10:00:00+08:00");
    expect(update).toEqual({ id: "schedule", maxRuns: 4, expiresAt: "2026-12-01T02:00:00.000Z" });
  });
  it("validates limits, timezone and interval before sending RPC", () => {
    const model = form(); model.setMaxRuns("0");
    expect(validateScheduleDraft(model.getState(), "")).toBeTruthy();
    model.setMaxRuns("3"); expect(validateScheduleDraft(model.getState(), "bad date")).toBeTruthy();
    model.setCadence({ type: "cron", expression: "0 9 * * *", timezone: "Unknown/Zone" }); expect(validateScheduleDraft(model.getState(), "")).toBeTruthy();
    model.setCadence({ type: "every", everyMs: 1.5 }); expect(validateScheduleDraft(model.getState(), "")).toBeTruthy();
  });
  it("includes all new-agent form fields in creation", () => {
    const state = { ...form().getState(), selectedProvider: "omp", selectedModel: "provider/model", selectedMode: "ask", selectedThinkingOptionId: "high", maxRuns: "3" };
    const create = buildScheduleCreate(state, "2026-12-01T00:00:00Z", true);
    expect(create).toMatchObject({ cadence: schedule.cadence, maxRuns: 3, runOnCreate: true, expiresAt: "2026-12-01T00:00:00.000Z", target: { type: "new-agent", config: { provider: "omp", cwd: "/repo", model: "provider/model", modeId: "ask", thinkingOptionId: "high", isolation: "worktree", archiveOnFinish: true } } });
  });
});
