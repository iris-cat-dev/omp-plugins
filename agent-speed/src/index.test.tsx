// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginTurnMetricProps, PluginTurnMetricContribution } from "@omp-desktop/plugin";
import setup from "./index";

vi.mock("lucide-react-native", () => ({ Zap: () => null }));
vi.mock("react-native-unistyles", () => {
  const theme = { colors: { foregroundMuted: "gray" }, spacing: { 1: 4 } };
  return {
    StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory(theme) },
    useUnistyles: () => ({ theme }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (_key: string, values: { speed: string }) => `${values.speed} t/s` }),
}));
afterEach(cleanup);

function context() {
  const addTurnMetric = vi.fn((_contribution: PluginTurnMetricContribution) => vi.fn());
  const addSettingsPage = vi.fn(() => vi.fn());
  const ctx = { mode: "active", signal: new AbortController().signal, addTurnMetric, addSettingsPage } as unknown as PluginClientContext;
  return { ctx, addTurnMetric, addSettingsPage };
}
function props(active = false): PluginTurnMetricProps {
  const now = Date.now();
  return {
    hostId: "host", agentId: "agent", turnId: "turn", visible: true, active, cancelling: false,
    replayedUsage: null,
    recordedUsage: { scope: "turn", inputTokens: 10, outputTokens: 150, nativeMetrics: {
      generation: 1, phase: active ? "generating" : "idle", inFlightStartMs: active ? now - 3000 : null,
      lastActivityMs: now, latestEndMs: null, measuredOutputTokens: 120, measuredDurationMs: 3000,
      recentRequests: [], modelReferences: [],
      agentReferences: [{ startMs: now - 10000, endMs: now - 7000, outputTokens: 120 }],
    } },
  };
}

describe("builtin speed contribution", () => {
  it("renders completed measured value and source in the value and tooltip", () => {
    const running = context();
    setup(running.ctx);
    const Metric = running.addTurnMetric.mock.calls[0][0].component;
    render(<Metric {...props()} />);
    expect(screen.getByText("40.0 t/s · Measured")).toBeTruthy();
    expect(screen.getByTitle(/^Measured: 40\.0 t\/s/)).toBeTruthy();
  });
  it("labels generation estimates honestly and removes hidden/cancelling projections", () => {
    const running = context();
    setup(running.ctx);
    const Metric = running.addTurnMetric.mock.calls[0][0].component;
    const input = props(true);
    const view = render(<Metric {...input} />);
    expect(screen.getByTestId("turn-token-output-speed").getAttribute("aria-label")).toBe(
      "40.0 t/s, Estimated",
    );
    expect(screen.getByTitle(/^Estimated: 40\.0 t\/s/)).toBeTruthy();
    view.rerender(<Metric {...input} visible={false} />);
    expect(screen.queryByText(/t\/s/)).toBeNull();
    view.rerender(<Metric {...input} cancelling />);
    expect(screen.queryByText(/t\/s/)).toBeNull();
  });
});
