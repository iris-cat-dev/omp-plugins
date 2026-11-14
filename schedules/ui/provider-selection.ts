import type { AgentModelDefinition, ProviderSnapshotEntry } from "@omp-desktop/protocol/agent-types";
import { filterSelectableModels } from "./model-catalog";
import { i18n } from "./i18n";

export interface ProviderSelectorProvider {
  id: string;
  label: string;
  modelSelection:
    | { kind: "models"; rows: { modelId: string; modelLabel: string; description?: string }[]; error?: string }
    | { kind: "loading" }
    | { kind: "error"; message: string };
}

function rows(models: AgentModelDefinition[] | null) {
  const selectable = filterSelectableModels(models) ?? [];
  return selectable.length ? selectable.map(model => ({ modelId: model.id, modelLabel: model.label, description: model.description ?? model.id })) : [{ modelId: "", modelLabel: i18n.t("defaultModel") }];
}

export function buildSelectableProviderSelectorProviders(entries: ProviderSnapshotEntry[] | undefined): ProviderSelectorProvider[] {
  return (entries ?? []).filter(entry => entry.enabled && (entry.provider === "omp" || (entry.modes?.length ?? 0) > 0)).map(entry => {
    const label = entry.label ?? entry.provider;
    if ((entry.models?.length ?? 0) > 0) return { id: entry.provider, label, modelSelection: { kind: "models" as const, rows: rows(entry.models ?? null), ...(entry.status === "error" ? { error: entry.error ?? i18n.t("providerError") } : {}) } };
    if (entry.status === "ready" && entry.models != null) return { id: entry.provider, label, modelSelection: { kind: "models" as const, rows: rows(entry.models) } };
    if (entry.status === "loading" || entry.status === "ready") return { id: entry.provider, label, modelSelection: { kind: "loading" as const } };
    return { id: entry.provider, label, modelSelection: { kind: "error" as const, message: entry.error ?? i18n.t("providerError") } };
  });
}
