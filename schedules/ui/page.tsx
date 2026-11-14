import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { PluginClientContext, PluginSurfaceProps } from "@omp-desktop/plugin";
import type { ScheduleRun } from "@omp-desktop/protocol/schedule/types";
import { deleteSchedule, inspectSchedule, pauseSchedule, resumeSchedule, runScheduleOnce, scheduleLogs } from "../rpc";
import { Button, Dialog, ErrorText, Select, useColors, useText } from "./controls";
import { errorMessage, fetchScheduleDirectory, type AggregatedSchedule, type ScheduleDirectory, type ScheduleHost } from "./data";
import { resolveSchedule, type ScheduleBucket } from "./schedule-derivation";
import { buildProjectNameByCwd } from "./schedule-project-targets";
import { formatCadence, formatNextRun, localizeScheduleTargetLabel, resolveScheduleTitle, scheduleProductLabel } from "./schedule-format";
import { ScheduleForm } from "./form";

export function SchedulesPage({ ctx, host }: PluginSurfaceProps & { ctx: PluginClientContext; language: string }) {
  const colors = useColors();
  const t = useText();
  const [hosts, setHosts] = useState<readonly ScheduleHost[]>(() => ctx.hosts.list());
  const [directory, setDirectory] = useState<ScheduleDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [bucket, setBucket] = useState<ScheduleBucket>("runnable");
  const [form, setForm] = useState<{ schedule?: AggregatedSchedule } | null>(null);
  const [logs, setLogs] = useState<AggregatedSchedule | null>(null);
  const [deleting, setDeleting] = useState<AggregatedSchedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const inFlight = useRef(false);
  const reloadNeeded = useRef(false);
  const reload = useCallback(async () => {
    if (inFlight.current) { reloadNeeded.current = true; return; }
    inFlight.current = true;
    try {
      do {
        reloadNeeded.current = false;
        const sequence = ++request.current;
        try { const result = await fetchScheduleDirectory(ctx, ctx.hosts.list()); if (alive.current && !ctx.signal.aborted && sequence === request.current) { setDirectory(result); setError(null); } }
        catch (error) { if (alive.current && !ctx.signal.aborted && sequence === request.current) setError(errorMessage(error)); }
      } while (reloadNeeded.current && alive.current && !ctx.signal.aborted);
    } finally { inFlight.current = false; }
  }, [ctx]);
  useEffect(() => {
    alive.current = true;
    let connectionOff: (() => void)[] = [];
    function bindHosts() {
      for (const off of connectionOff) off();
      const nextHosts = ctx.hosts.list();
      setHosts(nextHosts);
      connectionOff = nextHosts.flatMap(current => { const connection = ctx.hosts.get(current.id); return connection ? [connection.subscribe(() => { void reload(); }), connection.omp.agents.subscribe(() => { void reload(); }), connection.omp.workspaces.subscribe(() => { void reload(); })] : []; });
      void reload();
    }
    const offHosts = ctx.hosts.subscribe(bindHosts);
    bindHosts();
    return () => { alive.current = false; request.current++; offHosts(); for (const off of connectionOff) off(); };
  }, [ctx, reload]);
  useEffect(() => { if (selectedHost && !hosts.some(current => current.id === selectedHost)) setSelectedHost(null); }, [hosts, selectedHost]);
  const rows = useMemo(() => {
    if (!directory) return [];
    const projectNameByCwd = buildProjectNameByCwd(directory.projectTargets);
    return directory.schedules.map(schedule => ({ schedule, resolved: resolveSchedule({ schedule, serverId: schedule.serverId, now: Date.now(), agentsByKey: directory.agents, projectNameByCwd, agentDataLoaded: directory.agentReadyHosts.has(schedule.serverId) }) })).filter(row => (!selectedHost || row.schedule.serverId === selectedHost) && row.resolved.bucket === bucket);
  }, [directory, selectedHost, bucket]);
  async function mutate(schedule: AggregatedSchedule, action: "pause" | "resume" | "run" | "delete") {
    if (busy || ctx.signal.aborted) return;
    const connection = ctx.hosts.get(schedule.serverId);
    if (!connection) return;
    setBusy(`${schedule.serverId}:${schedule.id}`); setError(null);
    try {
      if (action === "pause") await connection.rpc(pauseSchedule, { id: schedule.id });
      if (action === "resume") await connection.rpc(resumeSchedule, { id: schedule.id });
      if (action === "run") await connection.rpc(runScheduleOnce, { id: schedule.id });
      if (action === "delete") { await connection.rpc(deleteSchedule, { id: schedule.id }); if (alive.current && !ctx.signal.aborted) setDeleting(null); }
      await reload();
    } catch (error) { if (alive.current && !ctx.signal.aborted) setError(errorMessage(error)); }
    finally { if (alive.current && !ctx.signal.aborted) setBusy(null); }
  }
  return <View style={{ flex: 1, backgroundColor: colors.surface0 }} testID="schedules-plugin-page"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, gap: 20, maxWidth: 1100, width: "100%", alignSelf: "center" }} testID="schedules-list">
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}><Text accessibilityRole="header" style={{ fontSize: 26, fontWeight: "700", color: colors.foreground }}>{t("schedules.title")}</Text><View style={{ flexDirection: "row", gap: 8 }}><Button onPress={() => { void reload(); }} testID="schedules-retry">{t("refresh")}</Button><Button selected disabled={!directory?.hosts.length} onPress={() => setForm({})} testID="schedules-new">{t("schedules.new")}</Button></View></View>
    <View style={{ flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
      {hosts.length > 1 ? <Select label={t("schedules.form.host")} value={selectedHost ?? "all"} options={[{ value: "all", label: t("allHosts") }, ...hosts.map(current => ({ value: current.id, label: current.label }))]} onChange={value => setSelectedHost(value === "all" ? null : value)} testID="schedules-host-filter-trigger" /> : null}
      <Button selected={bucket === "runnable"} onPress={() => setBucket("runnable")} testID="schedules-filter-active">{t("schedules.filters.active")}</Button><Button selected={bucket === "ended"} onPress={() => setBucket("ended")} testID="schedules-filter-ended">{t("schedules.filters.ended")}</Button>
    </View>
    {error ? <ErrorText>{error}</ErrorText> : null}
    {directory?.errors.map((error, index) => <ErrorText key={`${error.hostId}:${index}`}>{`${error.label}: ${error.message}`}</ErrorText>)}
    {!directory && !error ? <ActivityIndicator accessibilityLabel={t("loading")} color={colors.accent} /> : null}
    {directory && !directory.connected ? <Text style={{ color: colors.foregroundMuted }}>{t("connecting")}</Text> : null}
    {directory && !rows.length ? <View testID="schedules-empty" style={{ paddingVertical: 32, gap: 8 }}><Text style={{ fontSize: 18, fontWeight: "600", color: colors.foreground }}>{t(bucket === "ended" ? "schedules.endedEmpty" : "schedules.emptyTitle")}</Text>{bucket === "runnable" ? <Text style={{ color: colors.foregroundMuted }}>{t("schedules.emptyDescription")}</Text> : null}</View> : null}
    {rows.map(({ schedule, resolved }) => {
      const runnable = resolved.bucket === "runnable";
      const pending = busy === `${schedule.serverId}:${schedule.id}`;
      const targetAgent = schedule.target.type === "agent" ? directory?.agents.get(`${schedule.serverId}:${schedule.target.agentId}`) : null;
      const disabled = !!busy || !ctx.hosts.get(schedule.serverId);
      const product = scheduleProductLabel(schedule, t);
      return <View key={`${schedule.serverId}:${schedule.id}`} testID={`schedule-row-${schedule.id}`} style={{ padding: 18, gap: 10, borderWidth: 1, borderColor: colors.foregroundMuted, borderRadius: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}><Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.foreground }}>{resolveScheduleTitle(schedule, t)}</Text><Text style={{ fontSize: 13, color: resolved.state === "targetGone" ? colors.statusDanger : colors.foregroundMuted }}>{t(`schedules.status.${resolved.state}`)}</Text></View>
        <Text selectable style={{ color: colors.foreground }}>{product} · {localizeScheduleTargetLabel(resolved.target.label, t)}{targetAgent?.archivedAt ? ` · ${t("agentArchived")}` : ""}</Text>
        <Text style={{ color: colors.foregroundMuted }}>{[hosts.length > 1 ? schedule.serverName : null, resolved.target.provider, schedule.target.type === "new-agent" ? schedule.target.config.model : targetAgent?.model, formatCadence(schedule.cadence, t)].filter(Boolean).join(" · ")}</Text>
        <Text style={{ color: colors.foregroundMuted }}>{t("schedules.meta.created", { time: new Date(schedule.createdAt).toLocaleString() })} · {schedule.lastRunAt ? t("schedules.meta.lastRun", { time: new Date(schedule.lastRunAt).toLocaleString() }) : t("schedules.meta.neverRun")}{resolved.state === "active" && schedule.nextRunAt ? ` · ${t("schedules.meta.nextRun", { time: formatNextRun(schedule.nextRunAt, t) })}` : ""}</Text>
        <Text style={{ color: colors.foregroundMuted }}>{t("runCount")}: {schedule.runs.length}{schedule.maxRuns ? ` / ${schedule.maxRuns}` : ""}{schedule.expiresAt ? ` · ${t("expiry")}: ${new Date(schedule.expiresAt).toLocaleString()}` : ""}</Text>
        {runnable ? <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("pauseHint")}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button disabled={disabled} onPress={() => setForm({ schedule })} testID={`schedule-menu-edit-${schedule.id}`}>{t("edit")}</Button><Button disabled={disabled || !runnable} onPress={() => { void mutate(schedule, schedule.status === "paused" ? "resume" : "pause"); }} testID={`schedule-menu-${schedule.status === "paused" ? "resume" : "pause"}-${schedule.id}`}>{t(schedule.status === "paused" ? "resume" : "pause")}</Button>{schedule.target.type === "new-agent" ? <Button disabled={disabled || !runnable} onPress={() => { void mutate(schedule, "run"); }} testID={`schedule-menu-run-${schedule.id}`}>{t("schedules.actions.runNow")}</Button> : null}<Button disabled={disabled} onPress={() => setLogs(schedule)} testID={`schedule-menu-logs-${schedule.id}`}>{t("logs")}</Button><Button disabled={disabled} danger onPress={() => setDeleting(schedule)} testID={`schedule-menu-delete-${schedule.id}`}>{t("delete")}</Button>{pending ? <ActivityIndicator accessibilityLabel={t("loading")} color={colors.accent} /> : null}</View>
      </View>;
    })}
  </ScrollView>
    {form && directory ? <ScheduleForm ctx={ctx} directory={directory} defaultHostId={selectedHost ?? (hosts.length === 1 ? hosts[0]!.id : host.id)} schedule={form.schedule} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} /> : null}
    {logs ? <RunHistory ctx={ctx} schedule={logs} onClose={() => setLogs(null)} /> : null}
    {deleting ? <Dialog title={t("schedules.deleteConfirm.title", { product: scheduleProductLabel(deleting, t) })} onClose={() => { if (!busy) setDeleting(null); }} testID="schedule-delete-confirm"><View style={{ padding: 20, gap: 18 }}><Text style={{ color: colors.foreground }}>{t("schedules.deleteConfirm.message", { title: resolveScheduleTitle(deleting, t) })}</Text><View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}><Button disabled={!!busy} onPress={() => setDeleting(null)}>{t("cancel")}</Button><Button disabled={!!busy} danger onPress={() => { void mutate(deleting, "delete"); }} testID="schedule-delete-submit">{t("delete")}</Button></View></View></Dialog> : null}
  </View>;
}
function RunHistory({ ctx, schedule, onClose }: { ctx: PluginClientContext; schedule: AggregatedSchedule; onClose(): void }) {
  const colors = useColors();
  const t = useText();
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [prompt, setPrompt] = useState(schedule.prompt);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const connection = ctx.hosts.get(schedule.serverId);
    if (!connection) return;
    let disposed = false;
    let sequence = 0;
    async function load() {
      const current = ++sequence;
      try { const [snapshot, logs] = await Promise.all([connection!.rpc(inspectSchedule, { id: schedule.id }), connection!.rpc(scheduleLogs, { id: schedule.id })]); if (!disposed && !ctx.signal.aborted && current === sequence) { setPrompt(snapshot.prompt); setRuns(logs); setError(null); } }
      catch (error) { if (!disposed && !ctx.signal.aborted && current === sequence) setError(errorMessage(error)); }
    }
    const off = connection.subscribe(() => { void load(); });
    void load();
    return () => { disposed = true; off(); };
  }, [ctx, schedule.serverId, schedule.id, refresh]);
  return <Dialog title={`${t("logs")} · ${resolveScheduleTitle(schedule, t)}`} onClose={onClose} testID="schedule-run-history"><ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}><Text selectable style={{ color: colors.foreground }}>{prompt}</Text><Button onPress={() => setRefresh(value => value + 1)} testID="schedule-logs-refresh">{t("refresh")}</Button>{error ? <ErrorText>{error}</ErrorText> : null}{!runs && !error ? <ActivityIndicator accessibilityLabel={t("loading")} color={colors.accent} /> : null}{runs?.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{t("noRuns")}</Text> : null}{runs?.slice().reverse().map(run => <View key={run.id} testID={`schedule-run-${run.id}`} style={{ borderTopWidth: 1, borderColor: colors.foregroundMuted, paddingTop: 16, gap: 8 }}><Text style={{ color: run.status === "failed" ? colors.statusDanger : colors.foreground, fontWeight: "600" }}>{t(run.status)}</Text><Text selectable style={{ color: colors.foregroundMuted }}>{t("scheduledFor")}: {new Date(run.scheduledFor).toLocaleString()}{"\n"}{t("startedAt")}: {new Date(run.startedAt).toLocaleString()}{run.endedAt ? `\n${t("endedAt")}: ${new Date(run.endedAt).toLocaleString()}` : ""}{run.agentId ? `\n${t("agent")}: ${run.agentId}` : ""}{run.workspaceId ? `\n${t("workspace")}: ${run.workspaceId}` : ""}</Text>{run.output != null ? <View style={{ gap: 4 }}><Text style={{ color: colors.foregroundMuted }}>{t("output")}</Text><Text selectable style={{ color: colors.foreground }}>{run.output}</Text></View> : null}{run.error != null ? <ErrorText>{run.error}</ErrorText> : null}</View>)}</ScrollView></Dialog>;
}
