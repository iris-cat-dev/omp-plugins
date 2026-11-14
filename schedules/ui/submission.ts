import type { CreateScheduleInput, ScheduleCadence, ScheduleSummary, UpdateScheduleInput } from "@omp-desktop/protocol/schedule/types";
import type { ScheduleFormState } from "./schedule-form-model";
import { validateCron } from "./schedule-format";
import { i18n } from "./i18n";

export function validateScheduleDraft(state: ScheduleFormState, expiresAt: string): string | null {
  if (state.cadence.type === "cron") {
    const error = validateCron(state.cadence.expression, i18n.t.bind(i18n));
    if (error) return error;
    try { new Intl.DateTimeFormat("en", { timeZone: state.cadence.timezone ?? "UTC" }); } catch { return i18n.t("invalidTimezone"); }
  } else if (!Number.isSafeInteger(state.cadence.everyMs) || state.cadence.everyMs <= 0) return i18n.t("invalidInterval");
  if (state.maxRuns.trim() && (!/^\d+$/.test(state.maxRuns.trim()) || !Number.isSafeInteger(Number(state.maxRuns)) || Number(state.maxRuns) <= 0)) return i18n.t("invalidMaxRuns");
  if (expiresAt.trim() && !Number.isFinite(Date.parse(expiresAt))) return i18n.t("invalidExpiry");
  return null;
}
function limits(state: ScheduleFormState, expiry: string) {
  return { maxRuns: state.maxRuns.trim() ? Number(state.maxRuns) : null, expiresAt: expiry.trim() ? new Date(expiry).toISOString() : null };
}
function cadence(value: ScheduleCadence): ScheduleCadence {
  return value.type === "cron" ? { ...value, expression: value.expression.trim(), timezone: value.timezone?.trim() || "UTC" } : value;
}
export function buildScheduleCreate(state: ScheduleFormState, expiry: string, runOnCreate: boolean): CreateScheduleInput {
  if (!state.selectedProvider || !state.workingDir.trim()) throw new Error("Schedule creation requires a provider and project path");
  return { name: state.name.trim() || null, prompt: state.prompt.trim(), cadence: cadence(state.cadence), target: { type: "new-agent", config: { provider: state.selectedProvider, cwd: state.workingDir.trim(), model: state.selectedModel || undefined, modeId: state.selectedMode || undefined, thinkingOptionId: state.selectedThinkingOptionId || undefined, title: state.name.trim() || undefined, ...(state.submitArchiveOnFinish !== undefined ? { archiveOnFinish: state.submitArchiveOnFinish } : {}), ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}) } }, ...limits(state, expiry), runOnCreate };
}
export function buildScheduleUpdate(state: ScheduleFormState, schedule: ScheduleSummary, expiry: string): UpdateScheduleInput {
  const update: UpdateScheduleInput = { id: schedule.id, ...(state.submitCadence ? { cadence: cadence(state.submitCadence) } : {}), ...limits(state, expiry) };
  if (schedule.target.type === "agent") return update;
  if (!state.selectedProvider) throw new Error("Schedule editing requires a provider");
  return { ...update, name: state.name.trim() || null, prompt: state.prompt.trim(), newAgentConfig: { provider: state.selectedProvider, cwd: state.workingDir.trim(), model: state.selectedModel || null, modeId: state.selectedMode || null, thinkingOptionId: state.selectedThinkingOptionId || null, ...(state.submitArchiveOnFinish !== undefined ? { archiveOnFinish: state.submitArchiveOnFinish } : {}), ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}) } };
}
