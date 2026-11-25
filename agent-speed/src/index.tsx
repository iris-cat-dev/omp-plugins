import { Zap } from "lucide-react-native";
import React from "react";
import { Platform, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { PluginClientContext, PluginSettingsPageProps, PluginTurnMetricProps } from "@omp-desktop/plugin";
import { calculateCompletedOutputRate } from "./completed";
import { formatOutputTokenSpeed } from "./metrics";
import { turnMetricKey, useOutputRate } from "./use-output-rate";
import { AgentSpeedSettings } from "./settings.js";

type MetricTheme = { colors: { foregroundMuted: string }; spacing: { 1: number } };

export default function setup(ctx: PluginClientContext) {
  function Settings(props: PluginSettingsPageProps) {
    return <AgentSpeedSettings {...props} context={ctx} />;
  }
  ctx.addSettingsPage({ id: "monitor", title: "Agent Speed", icon: "Gauge", Component: Settings });
  if (ctx.mode !== "active") return;
  function AgentSpeedMetric(props: PluginTurnMetricProps) {
    const { t, i18n } = useTranslation();
    const { theme } = useUnistyles();
    const rate = useOutputRate(
      turnMetricKey(props.hostId, props.agentId, props.turnId),
      props.visible && props.active && !props.cancelling,
      props.recordedUsage?.scope === "session" ? null : props.recordedUsage?.nativeMetrics,
      ctx.signal,
    );
    if (!props.visible || props.cancelling || ctx.signal.aborted) return null;
    const value = props.active
      ? rate?.output ?? null
      : calculateCompletedOutputRate(props.recordedUsage, props.replayedUsage);
    if (value === null) return null;
    const zh = i18n.language.startsWith("zh");
    const estimated = props.active && (rate?.estimated ?? 0) > 0;
    const source = estimated ? (zh ? "估算" : "Estimated") : (zh ? "实测" : "Measured");
    const speed = formatOutputTokenSpeed(value);
    const label = t("agentStream.turnMetadata.tokensPerSecond", { speed });
    const tooltip = estimated
      ? `${source}: ${label}; ${zh ? "实测" : "Measured"} ${formatOutputTokenSpeed(rate!.measured)} t/s + ${zh ? "估算" : "Estimated"} ${formatOutputTokenSpeed(rate!.estimated)} t/s (${rate!.reference === "agent" ? (zh ? "自身请求参考" : "own-agent reference") : (zh ? "同模型自身请求参考" : "same-model own-agent reference")})`
      : `${source}: ${label}; ${zh ? "有效自身 output / 实测请求时长" : "valid own output / measured request duration"}`;
    const text = (
      <Text style={styles.text} accessibilityLabel={`${label}, ${source}`} accessibilityHint={tooltip} testID={props.active ? "turn-token-output-speed" : "turn-avg-speed"}>
        {props.active ? `${speed} t/s` : `${label} · ${source}`}
      </Text>
    );
    return (
      <View style={props.active ? styles.live : undefined}>
        {props.active ? <Zap size={13} color={(theme as MetricTheme).colors.foregroundMuted} aria-hidden /> : null}
        {Platform.OS === "web" ? React.createElement("span", { title: tooltip }, text) : text}
      </View>
    );
  }
  return ctx.addTurnMetric({ id: "output-speed", component: AgentSpeedMetric });
}

const styles = StyleSheet.create((theme: MetricTheme) => ({
  live: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
}));
