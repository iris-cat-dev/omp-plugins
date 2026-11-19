import { z } from 'zod';
import { AgentPresetSchema, ConfigSchema, type Config } from '../state.ts';

export type AgentPreset = z.infer<typeof AgentPresetSchema>;

export type ConfigDraftResult =
  | { config: Config; error: null }
  | { config: null; error: string };

export function parseConfigDraftResult(text: string): ConfigDraftResult {
  try {
    const raw: unknown = JSON.parse(text);
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return { config: null, error: `${path}${issue?.message ?? parsed.error.message}` };
    }
    return { config: parsed.data, error: null };
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseConfigDraft(text: string): Config | null {
  return parseConfigDraftResult(text).config;
}

export function editConfigDraft(text: string, updater: (config: Config) => Config): string {
  const current = ConfigSchema.parse(JSON.parse(text));
  const next = ConfigSchema.parse(updater(current));
  return JSON.stringify(next, null, 2);
}

export function editSandboxEnabled(text: string, sandboxEnabled: boolean): string {
  return editConfigDraft(text, config => ({ ...config, sandboxEnabled }));
}

export function editSandboxPath(text: string, sandboxPath: string): string {
  return editConfigDraft(text, config => ({ ...config, sandboxPath }));
}

export function editSandboxCapability(text: string, capability: keyof Config['sandboxCapabilities'], enabled: boolean): string {
  return editConfigDraft(text, config => ({
    ...config,
    sandboxCapabilities: { ...config.sandboxCapabilities, [capability]: enabled },
  }));
}

export function editGameEnabled(text: string, enabled: boolean): string {
  return editConfigDraft(text, config => ({ ...config, game: { ...config.game, enabled } }));
}

export function editGameEngineDirectory(text: string, engineDirectory: string): string {
  return editConfigDraft(text, config => ({ ...config, game: { ...config.game, engineDirectory } }));
}

export function parseProviderModelSelection(providerValue: string): { provider: string; model: string } {
  const trimmed = providerValue.trim();
  const slash = trimmed.indexOf('/');
  if (slash < 0) return { provider: trimmed || 'omp', model: '' };
  return {
    provider: trimmed.slice(0, slash) || 'omp',
    model: trimmed.slice(slash + 1),
  };
}

export function formatProviderModelSelection(provider: string, model: string): string {
  const cleanProvider = provider.trim() || 'omp';
  const cleanModel = model.trim();
  return cleanModel ? `${cleanProvider}/${cleanModel}` : cleanProvider;
}

export function getPreset(config: Config, name: string): AgentPreset {
  return (
    config.presets.find(preset => preset.name === name) ??
    config.presets.find(preset => preset.name === config.defaultPreset) ??
    config.presets[0]!
  );
}

export function editPresetInDraft(
  text: string,
  presetName: string,
  updater: (preset: AgentPreset) => AgentPreset,
): string {
  return editConfigDraft(text, config => {
    const exists = config.presets.some(preset => preset.name === presetName);
    if (!exists) throw new Error(`Preset 不存在：${presetName}`);
    return {
      ...config,
      presets: config.presets.map(preset => (preset.name === presetName ? updater(preset) : preset)),
    };
  });
}

export function setPresetProviderModelInDraft(
  text: string,
  presetName: string,
  provider: string,
  model: string,
): string {
  const combined = formatProviderModelSelection(provider, model);
  return editPresetInDraft(text, presetName, preset => ({
    ...preset,
    config: { ...preset.config, provider: combined },
  }));
}

export function setPresetThinkingInDraft(
  text: string,
  presetName: string,
  thinkingOptionId: string,
): string {
  const normalized = thinkingOptionId.trim();
  return editPresetInDraft(text, presetName, preset => {
    const { thinkingOptionId: _prev, ...rest } = preset.config;
    return {
      ...preset,
      config: normalized ? { ...rest, thinkingOptionId: normalized } : rest,
    };
  });
}

export function setPresetSystemPromptInDraft(
  text: string,
  presetName: string,
  systemPrompt: string,
): string {
  return editPresetInDraft(text, presetName, preset => {
    const { systemPrompt: _prev, ...rest } = preset.config;
    return {
      ...preset,
      config: systemPrompt.length > 0 ? { ...rest, systemPrompt } : rest,
    };
  });
}

export function setPresetQqPromptInDraft(
  text: string,
  presetName: string,
  prompt: string,
): string {
  return editPresetInDraft(text, presetName, preset => ({
    ...preset,
    qq: { ...preset.qq, prompt },
  }));
}

export function addPresetToDraft(text: string, rawName: string, basePresetName?: string): string {
  const name = rawName.trim();
  if (!name) throw new Error('Preset 名称不能为空');
  return editConfigDraft(text, config => {
    if (config.presets.some(preset => preset.name === name)) {
      throw new Error(`Preset 名称已存在：${name}`);
    }
    const base = basePresetName ? config.presets.find(preset => preset.name === basePresetName) : undefined;
    const created: AgentPreset = base
      ? {
          name,
          config: { ...base.config },
          qq: { prompt: base.qq.prompt, skills: [], tools: [] },
        }
      : {
          name,
          config: { provider: 'omp' },
          qq: { prompt: '', skills: [], tools: [] },
        };
    return { ...config, presets: [...config.presets, created] };
  });
}

export function renamePresetInDraft(text: string, oldName: string, rawNewName: string): string {
  const newName = rawNewName.trim();
  if (!newName) throw new Error('Preset 名称不能为空');
  if (newName === oldName) return text;
  return editConfigDraft(text, config => {
    if (!config.presets.some(preset => preset.name === oldName)) {
      throw new Error(`Preset 不存在：${oldName}`);
    }
    if (config.presets.some(preset => preset.name === newName)) {
      throw new Error(`Preset 名称已存在：${newName}`);
    }
    return {
      ...config,
      defaultPreset: config.defaultPreset === oldName ? newName : config.defaultPreset,
      presets: config.presets.map(preset => (preset.name === oldName ? { ...preset, name: newName } : preset)),
    };
  });
}

export function deletePresetFromDraft(text: string, name: string): string {
  return editConfigDraft(text, config => {
    if (config.presets.length <= 1) throw new Error('至少需要保留一个 Preset');
    const remaining = config.presets.filter(preset => preset.name !== name);
    if (remaining.length === config.presets.length) throw new Error(`Preset 不存在：${name}`);
    return {
      ...config,
      defaultPreset: config.defaultPreset === name ? remaining[0]!.name : config.defaultPreset,
      presets: remaining,
    };
  });
}

export function setDefaultPresetInDraft(text: string, name: string): string {
  return editConfigDraft(text, config => {
    if (!config.presets.some(preset => preset.name === name)) {
      throw new Error(`Preset 不存在：${name}`);
    }
    return { ...config, defaultPreset: name };
  });
}

export function isConfigDraftDirty(draftText: string, savedConfig: Config | null): boolean {
  if (!savedConfig) return false;
  const parsed = parseConfigDraft(draftText);
  if (!parsed) return true;
  return JSON.stringify(parsed) !== JSON.stringify(savedConfig);
}
