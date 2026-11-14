import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import type { PluginClientContext } from "@omp-desktop/plugin";
import { createSchedule, updateSchedule } from "../rpc";
import { Button, Dialog, ErrorText, Field, Input, Select, useColors, useText } from "./controls";
import { CADENCE_PRESET_OPTIONS, cadencePresetLabelKey, resolveCronPresetId } from "./schedule-cadence-options";
import { nextCronCadence } from "./schedule-cadence-policy";
import { useScheduleFormModel } from "./use-schedule-form-model";
import { FormPreferencesSchema, selectionPreferences, type FormPreferences } from "./preferences";
import { buildScheduleCreate, buildScheduleUpdate, validateScheduleDraft } from "./submission";
import { formatThinkingOptionLabel } from "./labels";
import { errorMessage, type AggregatedSchedule, type ScheduleDirectory } from "./data";
import type { ScheduleCadence } from "@omp-desktop/protocol/schedule/types";

export function ScheduleForm({ ctx, directory, defaultHostId, schedule, onClose, onSaved }: { ctx: PluginClientContext; directory: ScheduleDirectory; defaultHostId: string | null; schedule?: AggregatedSchedule; onClose(): void; onSaved(): void }) {
  const colors = useColors();
  const t = useText();
  const [preferences, setPreferences] = useState<FormPreferences>();
  const [expiresAt, setExpiresAt] = useState(schedule?.expiresAt ?? "");
  const [runOnCreate, setRunOnCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerRefresh, setProviderRefresh] = useState(0);
  const [providerLoading, setProviderLoading] = useState(false);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const snapshot = useMemo(() => ({ mode: schedule ? "edit" as const : "create" as const, schedule, hosts: directory.hosts, defaults: { serverId: schedule?.serverId ?? defaultHostId, projectTargets: directory.projectTargets, preferences, timezone } }), [schedule, directory.hosts, directory.projectTargets, defaultHostId, preferences, timezone]);
  const model = useScheduleFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    let disposed = false;
    void ctx.storage.get().then(stored => { if (!disposed && !ctx.signal.aborted) { const parsed = FormPreferencesSchema.safeParse(stored.values.uiPreferences); if (parsed.success) setPreferences(parsed.data); } }, error => { if (!disposed && !ctx.signal.aborted) model.setSubmitError(errorMessage(error)); });
    return () => { disposed = true; };
  }, [ctx, model]);
  useEffect(() => {
    if (state.targetKind !== "new-agent" || !state.selectedServerId) return;
    const scoped = ctx.hosts.get(state.selectedServerId);
    if (!scoped) return;
    let disposed = false;
    setProviderLoading(true);
    setProviderError(null);
    type Entries = Parameters<typeof model.applyProviderSnapshot>[1]["entries"];
    const apply = (entries: Entries) => { if (!disposed && !ctx.signal.aborted) { model.applyProviderSnapshot(state.selectedServerId!, { entries }); setProviderLoading(entries.some(entry => entry.status === "loading")); } };
    let snapshotCwd: string | undefined;
    let snapshotReady = false;
    const pendingUpdates = new Map<string | undefined, Entries>();
    const off = scoped.omp.providers.subscribe(update => { if (!snapshotReady) pendingUpdates.set(update.cwd, update.entries); else if (update.cwd === snapshotCwd) apply(update.entries); });
    const options = state.workingDir ? { cwd: state.workingDir } : {};
    const request = providerRefresh ? scoped.omp.providers.refresh(options).then(() => scoped.omp.providers.snapshot(options)) : scoped.omp.providers.snapshot(options);
    void request.then(result => { snapshotCwd = result.cwd; snapshotReady = true; apply(pendingUpdates.get(result.cwd) ?? result.entries); pendingUpdates.clear(); }, error => { if (!disposed && !ctx.signal.aborted) { setProviderError(errorMessage(error)); setProviderLoading(false); } });
    return () => { disposed = true; off(); };
  }, [ctx, model, state.selectedServerId, state.targetKind, state.workingDir, providerRefresh]);
  const validation = validateScheduleDraft(state, expiresAt);
  const heartbeatChanged = !!schedule && (state.submitCadence !== undefined || state.maxRuns !== (schedule.maxRuns == null ? "" : String(schedule.maxRuns)) || expiresAt !== (schedule.expiresAt ?? ""));
  const canSubmit = (state.targetKind === "agent" ? heartbeatChanged : state.canSubmit) && !validation && !busy && !!state.selectedServerId && !!ctx.hosts.get(state.selectedServerId);
  async function submit() {
    if (!canSubmit || !state.selectedServerId) return;
    const scoped = ctx.hosts.get(state.selectedServerId);
    if (!scoped) return;
    setBusy(true); model.setSubmitError(null);
    try {
      if (state.targetKind === "new-agent") {
        const stored = await ctx.storage.get();
        const previous = FormPreferencesSchema.safeParse(stored.values.uiPreferences);
        await ctx.storage.patch({ uiPreferences: selectionPreferences(previous.success ? previous.data : {}, state) }, stored.revision);
      }
      if (schedule) await scoped.rpc(updateSchedule, buildScheduleUpdate(state, schedule, expiresAt));
      else await scoped.rpc(createSchedule, buildScheduleCreate(state, expiresAt, runOnCreate));
      if (!ctx.signal.aborted) onSaved();
    } catch (error) { if (!ctx.signal.aborted) model.setSubmitError(errorMessage(error)); }
    finally { if (!ctx.signal.aborted) setBusy(false); }
  }
  const target = schedule?.target.type === "agent" ? directory.agents.get(`${schedule.serverId}:${schedule.target.agentId}`) : null;
  const title = schedule ? t(state.targetKind === "agent" ? "schedules.form.editHeartbeat" : "schedules.form.editSchedule") : t("schedules.form.newTitle");
  return <Dialog title={title} onClose={onClose} testID="schedule-form-sheet"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 18 }}>
    <Select label={t("schedules.form.host")} value={state.selectedServerId} options={directory.hosts.map(host => ({ value: host.serverId, label: host.label, testID: `schedule-host-option-${host.serverId}` }))} onChange={model.setHost} disabled={!!schedule || busy} testID="schedule-host-trigger" />
    {state.targetKind === "agent" ? <Field label={t("schedules.form.target")}><Text selectable style={{ color: colors.foreground }}>{target?.title?.trim() || t(target ? "schedules.target.untitledAgent" : "schedules.target.agentUnavailable")}{target?.archivedAt ? ` · ${t("agentArchived")}` : ""}</Text></Field> : <>
      <Input label={t("schedules.form.name")} value={state.name} onChangeText={model.setName} testID="schedule-name-input" editable={!busy} placeholder={t("schedules.form.optional")} />
      <Input label={t("schedules.form.prompt")} value={state.prompt} onChangeText={model.setPrompt} multiline testID="schedule-prompt-input" editable={!busy} placeholder={t("schedules.form.promptPlaceholder")} />
      <Select label={t("schedules.form.project")} value={state.selectedProjectOptionId} display={state.projectDisplay?.label} options={state.projectOptions.map(option => ({ ...option }))} onChange={id => { const option = state.projectOptions.find(project => project.id === id); if (option) model.setProject(id, { label: option.label }); }} disabled={busy || !state.selectedServerId} testID="schedule-project-trigger" />
      {state.workingDir ? <Text selectable style={{ color: colors.foregroundMuted }}>{state.workingDir}</Text> : null}
      {state.disclosure.showModelField ? <>
        <Select label={t("schedules.form.model")} value={JSON.stringify([state.selectedProvider, state.selectedModel])} display={state.selectedModelDisplay?.label} options={state.modelSelectorProviders.flatMap(provider => provider.modelSelection.kind === "models" ? provider.modelSelection.rows.map(row => ({ value: JSON.stringify([provider.id, row.modelId]), label: `${provider.label} · ${row.modelLabel}`, description: row.description })) : [])} onChange={value => { const [provider, modelId] = JSON.parse(value) as [string, string]; model.setModel(provider, modelId); }} disabled={busy || providerLoading} testID="schedule-model-trigger" />
        {providerLoading ? <Text style={{ color: colors.foregroundMuted }}>{t("loading")}</Text> : null}
        {providerError ? <ErrorText>{providerError}</ErrorText> : null}
        {state.modelSelectorProviders.map(provider => provider.modelSelection.kind === "error" || (provider.modelSelection.kind === "models" && provider.modelSelection.error) ? <ErrorText key={provider.id}>{`${provider.label}: ${provider.modelSelection.kind === "error" ? provider.modelSelection.message : provider.modelSelection.error}`}</ErrorText> : null)}
        <Button disabled={busy || providerLoading} onPress={() => setProviderRefresh(value => value + 1)} testID="schedule-providers-retry">{t("retryProviders")}</Button>
      </> : null}
      {state.disclosure.showThinkingField ? <Select label={t("schedules.form.thinking")} value={state.selectedThinkingOptionId} options={state.availableThinkingOptions.map(option => ({ value: option.id, label: formatThinkingOptionLabel(option) }))} onChange={model.setThinking} disabled={busy} testID="schedule-thinking-trigger" /> : null}
      {state.disclosure.showModeField ? <Select label={t("schedules.form.mode")} value={state.selectedMode} display={state.selectedMode ? state.selectedModeDisplay.label : t("schedules.form.defaultMode")} options={state.modeOptions.map(option => ({ value: option.id, label: option.label }))} onChange={model.setSessionMode} disabled={busy} testID="schedule-mode-trigger" /> : null}
      {state.disclosure.showIsolationField ? <Select label={t("isolation")} value={state.isolation} options={[{ value: "local", label: t("local") }, { value: "worktree", label: t("worktree"), disabled: !state.canUseWorktreeIsolation }]} onChange={value => model.setIsolation(value as "local" | "worktree")} disabled={busy} testID="schedule-isolation-trigger" searchable={false} /> : null}
      {state.disclosure.showArchiveOnFinishField ? <Field label={t("schedules.form.archiveOnFinish")}><Switch value={state.archiveOnFinish} onValueChange={model.setArchiveOnFinish} disabled={busy} accessibilityLabel={t("schedules.form.archiveOnFinish")} testID="schedule-archive-on-finish-switch" /></Field> : null}
    </>}
    <CadenceFields cadence={state.cadence} onChange={model.setCadence} disabled={busy} timezone={timezone} />
    <Input label={t("schedules.form.maxRuns")} value={state.maxRuns} onChangeText={model.setMaxRuns} placeholder={t("schedules.form.unlimited")} keyboardType="number-pad" editable={!busy} testID="schedule-max-runs-input" />
    <Input label={t("expiresAt")} value={expiresAt} onChangeText={setExpiresAt} placeholder={t("schedules.form.optional")} autoCapitalize="none" editable={!busy} testID="schedule-expires-input" />
    {!schedule ? <Field label={t("runOnCreate")}><Switch accessibilityLabel={t("runOnCreate")} value={runOnCreate} onValueChange={setRunOnCreate} disabled={busy} testID="schedule-run-on-create-switch" /></Field> : null}
    {validation ? <ErrorText>{validation}</ErrorText> : null}{state.submitError ? <ErrorText>{state.submitError}</ErrorText> : null}
  </ScrollView><View style={{ padding: 18, flexDirection: "row", justifyContent: "flex-end", gap: 10 }}><Button disabled={busy} onPress={onClose}>{t("cancel")}</Button><Button disabled={!canSubmit} selected onPress={() => { void submit(); }} testID="schedule-form-submit">{busy ? t("loading") : t(schedule ? "schedules.form.save" : "schedules.form.create")}</Button></View></Dialog>;
}
function CadenceFields({ cadence, onChange, disabled, timezone }: { cadence: ScheduleCadence; onChange(cadence: ScheduleCadence): void; disabled: boolean; timezone: string }) {
  const t = useText();
  const preset = cadence.type === "every" ? "interval" : resolveCronPresetId(cadence);
  const options = [...CADENCE_PRESET_OPTIONS.map(option => ({ value: option.id, label: t(cadencePresetLabelKey(option.id)) })), { value: "custom", label: t("schedules.cadence.presets.custom") }, { value: "interval", label: t("interval") }];
  return <><Select label={t("schedules.cadence.label")} value={preset} options={options} disabled={disabled} searchable={false} testID="schedule-cadence-trigger" onChange={id => { if (id === "interval") onChange({ type: "every", everyMs: cadence.type === "every" ? cadence.everyMs : 3_600_000 }); else onChange(nextCronCadence(cadence, CADENCE_PRESET_OPTIONS.find(option => option.id === id)?.expression ?? (cadence.type === "cron" ? cadence.expression : "0 * * * *"), timezone)); }} />
    {cadence.type === "every" ? <Input label={t("everyMs")} defaultValue={String(cadence.everyMs)} onChangeText={value => onChange({ type: "every", everyMs: Number(value) })} keyboardType="number-pad" editable={!disabled} testID="schedule-interval-input" /> : <><Input label={t("schedules.cadence.cronExpression")} value={cadence.expression} onChangeText={expression => onChange({ ...cadence, expression })} autoCapitalize="none" autoCorrect={false} editable={!disabled} testID="schedule-cron-input" /><Input label={t("timezone")} value={cadence.timezone ?? "UTC"} onChangeText={timezone => onChange({ ...cadence, timezone })} autoCapitalize="none" autoCorrect={false} editable={!disabled} testID="schedule-timezone-input" /></>}
  </>;
}
