import type { TFunction } from "i18next";
import type { ScheduleCadence, ScheduleSummary } from "@omp-desktop/protocol/schedule/types";
import { validateCronExpression } from "@omp-desktop/protocol/schedule/cron-expression";

export type IntervalUnit = "minutes" | "hours" | "days";
export type ScheduleProductKind = "schedule" | "heartbeat";
type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = MS_PER_MINUTE * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: MS_PER_MINUTE,
  hours: MS_PER_HOUR,
  days: MS_PER_DAY,
};

const CRON_DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const CRON_FIELD_KEYS: Record<string, string> = {
  minute: "schedules.cadence.fields.minute",
  hour: "schedules.cadence.fields.hour",
  "day-of-month": "schedules.cadence.fields.dayOfMonth",
  month: "schedules.cadence.fields.month",
  "day-of-week": "schedules.cadence.fields.dayOfWeek",
};

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export function scheduleProductKind(schedule: ScheduleSummary): ScheduleProductKind {
  return schedule.target.type === "agent" ? "heartbeat" : "schedule";
}

export function scheduleProductName(schedule: ScheduleSummary): "Heartbeat" | "Schedule" {
  return scheduleProductKind(schedule) === "heartbeat" ? "Heartbeat" : "Schedule";
}

export function scheduleProductLabel(schedule: ScheduleSummary, t: TFunction): string {
  return t(`schedules.product.${scheduleProductKind(schedule)}`);
}

/** Derivation/form sentinels. Localize at display with `localizeScheduleTargetLabel`. */
export const UNTITLED_AGENT_LABEL = "Untitled agent";
export const AGENT_UNAVAILABLE_LABEL = "Agent unavailable";

export function localizeScheduleTargetLabel(label: string, t: TFunction): string {
  if (label === UNTITLED_AGENT_LABEL) {
    return t("schedules.target.untitledAgent");
  }
  if (label === AGENT_UNAVAILABLE_LABEL) {
    return t("schedules.target.agentUnavailable");
  }
  return label;
}

export function resolveScheduleTitle(schedule: ScheduleSummary, t: TFunction): string {
  const name = schedule.name?.trim();
  if (name) {
    return name;
  }
  if (schedule.target.type === "new-agent") {
    const configTitle = schedule.target.config.title?.trim();
    if (configTitle) {
      return configTitle;
    }
  }
  const firstPromptLine = schedule.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstPromptLine || t(`schedules.untitled.${scheduleProductKind(schedule)}`);
}

export function everyMsToParts(ms: number): { value: number; unit: IntervalUnit } {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { value: 1, unit: "hours" };
  }
  if (ms % MS_PER_DAY === 0) {
    return { value: ms / MS_PER_DAY, unit: "days" };
  }
  if (ms % MS_PER_HOUR === 0) {
    return { value: ms / MS_PER_HOUR, unit: "hours" };
  }
  return { value: Math.max(1, Math.round(ms / MS_PER_MINUTE)), unit: "minutes" };
}

export function partsToEveryMs(value: number, unit: IntervalUnit): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  return normalized * UNIT_MS[unit];
}

function formatEvery(everyMs: number, t: TFunction): string {
  const { value, unit } = everyMsToParts(everyMs);
  const unitKey = unit === "minutes" ? "minute" : unit === "hours" ? "hour" : "day";
  if (value === 1) {
    return t(`schedules.cadence.every.${unitKey}One`);
  }
  return t(`schedules.cadence.every.${unitKey}Other`, { count: value });
}

export function formatCadence(cadence: ScheduleCadence, t: TFunction): string {
  if (cadence.type === "every") {
    return formatEvery(cadence.everyMs, t);
  }
  return describeCron(cadence, t) ?? cadence.expression;
}

/**
 * Humanize a handful of common 5-field cron shapes. Returns null when the
 * expression is valid but not one of the recognized patterns (callers fall
 * back to showing the raw expression).
 */
export function describeCron(cadence: CronCadence, t: TFunction): string | null {
  const trimmed = cadence.expression.trim();
  if (validateCron(trimmed, t) !== null) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = trimmed.split(/\s+/);

  // Only humanize the simple "fixed time" family: literal minute/hour with the
  // date fields either wildcarded or a recognized day-of-week constraint.
  const minuteNum = Number.parseInt(minute, 10);
  const isLiteralMinute = /^\d+$/.test(minute);
  const isWildcardMonth = month === "*";
  const isWildcardDom = dayOfMonth === "*";

  if (minute === "*" && hour === "*" && isWildcardMonth && isWildcardDom && dayOfWeek === "*") {
    return t("schedules.cadence.everyMinute");
  }

  if (!isLiteralMinute || !isWildcardMonth || !isWildcardDom) {
    return null;
  }

  // "Every hour" / "Every hour at :MM"
  if (hour === "*") {
    if (dayOfWeek !== "*") {
      return null;
    }
    return minuteNum === 0
      ? t("schedules.cadence.everyHour")
      : t("schedules.cadence.everyHourAt", { minute: pad2(minuteNum) });
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  const dayLabel = describeCronDay(dayOfWeek, t);
  return dayLabel ? t("schedules.cadence.atTime", { day: dayLabel, time, timezone }) : null;
}

function describeCronDay(dayOfWeek: string, t: TFunction): string | null {
  if (dayOfWeek === "*") {
    return t("schedules.cadence.days.daily");
  }
  if (dayOfWeek === "1-5") {
    return t("schedules.cadence.days.weekdays");
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return t("schedules.cadence.days.weekends");
  }
  if (/^\d$/.test(dayOfWeek)) {
    const dayKey = CRON_DAY_KEYS[Number.parseInt(dayOfWeek, 10)];
    return dayKey ? t(`schedules.cadence.days.${dayKey}`) : null;
  }
  return null;
}

export function validateCron(expr: string, t: TFunction): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return t("schedules.cadence.errors.enterExpression");
  }

  const error = validateCronExpression(trimmed);
  if (!error) {
    return null;
  }
  if (error === "Cron expressions must have 5 fields") {
    return t("schedules.cadence.errors.fiveFields");
  }
  const match = error.match(/^Invalid cron (.+) (step|field|range|value)$/);
  if (!match) {
    return t("schedules.cadence.errors.invalidExpression");
  }
  const [, fieldName, kind] = match;
  const field = t(CRON_FIELD_KEYS[fieldName] ?? fieldName);
  if (kind === "step") {
    return t("schedules.cadence.errors.invalidStep", { field });
  }
  if (kind === "field") {
    return t("schedules.cadence.errors.invalidField", { field });
  }
  if (kind === "range") {
    return t("schedules.cadence.errors.invalidRange", { field });
  }
  return t("schedules.cadence.errors.invalidValue", { field });
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Forward-relative description of the next run, e.g. "in 3h", "in 2d", "soon".
 * Returns "" when there is no scheduled next run.
 */
export function formatNextRun(iso: string | null, t: TFunction): string {
  if (!iso) {
    return "";
  }
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return "";
  }

  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return t("schedules.next.soon");
  }
  if (diffMs < MS_PER_MINUTE) {
    return t("schedules.next.soon");
  }
  if (diffMs < MS_PER_HOUR) {
    return t("schedules.next.inMinutes", { count: Math.round(diffMs / MS_PER_MINUTE) });
  }
  if (diffMs < MS_PER_DAY) {
    return t("schedules.next.inHours", { count: Math.round(diffMs / MS_PER_HOUR) });
  }
  return t("schedules.next.inDays", { count: Math.round(diffMs / MS_PER_DAY) });
}
