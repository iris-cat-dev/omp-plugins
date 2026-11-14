import type { ScheduleCadence } from "@omp-desktop/protocol/schedule/types";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export interface CadencePresetOption {
  id: string;
  expression: string;
}

export const CUSTOM_CRON_PRESET_ID = "custom";

export const CADENCE_PRESET_OPTIONS: CadencePresetOption[] = [
  { id: "every-minute", expression: "* * * * *" },
  { id: "every-hour", expression: "0 * * * *" },
  { id: "daily-9", expression: "0 9 * * *" },
  { id: "weekdays-9", expression: "0 9 * * 1-5" },
  { id: "mondays-9", expression: "0 9 * * 1" },
];

export function resolveCronPresetId(cadence: CronCadence): string {
  const expression = cadence.expression.trim();
  return (
    CADENCE_PRESET_OPTIONS.find((option) => option.expression === expression)?.id ??
    CUSTOM_CRON_PRESET_ID
  );
}

export function cadencePresetLabelKey(presetId: string): string {
  return `schedules.cadence.presets.${presetId}`;
}

export function normalizeScheduleFormCadence(
  cadence: ScheduleCadence,
  timezone: string,
): ScheduleCadence {
  if (cadence.type === "cron") {
    return { ...cadence, timezone: cadence.timezone ?? timezone };
  }

  return cadence;
}

