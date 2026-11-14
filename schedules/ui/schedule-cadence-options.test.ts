import { describe, expect, it } from "vitest";
import { CADENCE_PRESET_OPTIONS, normalizeScheduleFormCadence, resolveCronPresetId } from "./schedule-cadence-options";

describe("schedule cadence choices", () => {
  it("matches known presets and treats arbitrary cron as custom", () => {
    for (const preset of CADENCE_PRESET_OPTIONS) expect(resolveCronPresetId({ type: "cron", expression: ` ${preset.expression} ` })).toBe(preset.id);
    expect(resolveCronPresetId({ type: "cron", expression: "*/7 * * * *" })).toBe("custom");
  });
  it("preserves exact every cadence instead of approximating it with cron", () => {
    const cadence = { type: "every" as const, everyMs: 90_001 };
    expect(normalizeScheduleFormCadence(cadence, "Europe/Madrid")).toEqual(cadence);
  });
  it("keeps explicit cron timezone and defaults newly selected cron timezone", () => {
    expect(normalizeScheduleFormCadence({ type: "cron", expression: "0 9 * * *", timezone: "UTC" }, "Europe/Madrid")).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "UTC" });
    expect(normalizeScheduleFormCadence({ type: "cron", expression: "0 9 * * *" }, "Europe/Madrid")).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "Europe/Madrid" });
  });
});
