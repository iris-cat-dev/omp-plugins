import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginClientContext } from '@omp-desktop/plugin';
import type { AgentModelDefinition, AgentSelectOption, ProviderSnapshotEntry } from '@omp-desktop/protocol/agent-types';

export interface HostProvidersState {
  readonly mode: 'active' | 'manage' | 'no-capability';
  readonly loading: boolean;
  readonly entries: readonly ProviderSnapshotEntry[];
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useHostProviders(ctx: PluginClientContext): HostProvidersState {
  const canRead =
    ctx.installation.declaredCapabilities.includes('agents.events') &&
    ctx.installation.grantedCapabilities.includes('agents.events');
  const [entries, setEntries] = useState<readonly ProviderSnapshotEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const seqRef = useRef(0);

  const refresh = useCallback(() => {
    setRefreshTick(value => value + 1);
  }, []);

  useEffect(() => {
    if (ctx.mode !== 'active' || !canRead) {
      setEntries([]);
      setLoading(false);
      setError(null);
      return;
    }
    let disposed = false;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    let snapshotReady = false;
    let pending: readonly ProviderSnapshotEntry[] | null = null;
    const apply = (next: readonly ProviderSnapshotEntry[]) => {
      if (disposed || ctx.signal.aborted || seq !== seqRef.current) return;
      setEntries(next);
      setLoading(next.some(entry => entry.status === 'loading'));
    };

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = ctx.omp.providers.subscribe(update => {
        if (!snapshotReady) {
          pending = update.entries;
        } else {
          apply(update.entries);
        }
      });
    } catch {
      unsubscribe = undefined;
    }

    const request =
      refreshTick > 0
        ? ctx.omp.providers.refresh({}).then(() => ctx.omp.providers.snapshot({}))
        : ctx.omp.providers.snapshot({});

    void request.then(
      result => {
        if (disposed || ctx.signal.aborted || seq !== seqRef.current) return;
        snapshotReady = true;
        apply(pending ?? result.entries);
        pending = null;
      },
      failure => {
        if (disposed || ctx.signal.aborted || seq !== seqRef.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [ctx, canRead, refreshTick]);

  return {
    mode: ctx.mode !== 'active' ? 'manage' : !canRead ? 'no-capability' : 'active',
    loading,
    entries,
    error,
    refresh,
  };
}

export function selectableProviderEntries(entries: readonly ProviderSnapshotEntry[]): ProviderSnapshotEntry[] {
  return entries.filter(entry => entry.enabled && (entry.provider === 'omp' || (entry.modes?.length ?? 0) > 0));
}

export function selectableModels(models: readonly AgentModelDefinition[] | undefined): AgentModelDefinition[] {
  return (models ?? []).filter(model => model.isSelectable !== false);
}

export function findProviderModel(
  entries: readonly ProviderSnapshotEntry[],
  providerId: string,
  modelId: string,
): AgentModelDefinition | null {
  const entry = entries.find(item => item.provider === providerId);
  if (!entry?.models?.length) return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  return (
    entry.models.find(model => model.id === trimmed) ??
    entry.models.find(model => model.aliases?.includes(trimmed)) ??
    null
  );
}

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

export const FALLBACK_THINKING_OPTIONS: readonly AgentSelectOption[] = [
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
];

export function formatThinkingLabel(option: { id: string; label?: string | null }): string {
  const normalized = option.id.replace(/[\s_-]+/g, '').toLowerCase();
  if (THINKING_LABELS[normalized]) return THINKING_LABELS[normalized]!;
  return option.label?.trim() || option.id;
}

export function resolveThinkingOptions(
  entries: readonly ProviderSnapshotEntry[],
  providerId: string,
  modelId: string,
  currentThinkingId?: string,
): { options: AgentSelectOption[]; source: 'model' | 'fallback' } {
  const model = findProviderModel(entries, providerId, modelId);
  const base =
    model?.thinkingOptions && model.thinkingOptions.length > 0
      ? model.thinkingOptions
      : model
        ? []
        : [...FALLBACK_THINKING_OPTIONS];
  const options = [...base];
  const trimmed = currentThinkingId?.trim();
  if (trimmed && !options.some(option => option.id === trimmed)) {
    options.push({ id: trimmed, label: formatThinkingLabel({ id: trimmed }) });
  }
  return {
    options,
    source: model ? 'model' : 'fallback',
  };
}
