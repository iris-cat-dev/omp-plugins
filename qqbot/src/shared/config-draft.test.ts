import { expect, it } from 'vitest';
import { ConfigSchema } from '../state.ts';
import {
  addPresetToDraft,
  deletePresetFromDraft,
  editGameEnabled,
  editGameEngineDirectory,
  editSandboxCapability,
  editSandboxEnabled,
  editSandboxPath,
  formatProviderModelSelection,
  isConfigDraftDirty,
  parseConfigDraft,
  parseConfigDraftResult,
  parseProviderModelSelection,
  renamePresetInDraft,
  setDefaultPresetInDraft,
  setPresetProviderModelInDraft,
  setPresetQqPromptInDraft,
  setPresetSystemPromptInDraft,
  setPresetThinkingInDraft,
} from './config-draft.ts';

it('edits the one JSON draft without changing account, prompt or model config', () => {
  const before = ConfigSchema.parse({
    appId: 'saved-app',
    cwd: '/legacy-root',
    presets: [{ name: 'default', config: { provider: 'omp/provider/model', thinkingOptionId: 'high', systemPrompt: 'Keep this' } }],
  });
  const text = editSandboxPath(JSON.stringify(before), '/new-root');
  expect(parseConfigDraft(text)).toEqual({ ...before, sandboxPath: '/new-root' });
  expect(JSON.parse(text)).not.toHaveProperty('cwd');
  expect(parseConfigDraft(editSandboxPath(text, ''))?.sandboxPath).toBe('');
});

it('keeps sandbox enabled for old drafts and saves both toggle directions in the same JSON', () => {
  const before = ConfigSchema.parse({
    appId: 'saved-app',
    sandboxPath: '/qq-root',
    sandboxCapabilities: { javascript: true, network: true, imageGeneration: true },
    presets: [{ name: 'default', config: { provider: 'omp/provider/model', thinkingOptionId: 'high', systemPrompt: 'Keep this' } }],
  });
  expect(before.sandboxEnabled).toBe(true);
  const disabled = editSandboxEnabled(JSON.stringify(before), false);
  expect(parseConfigDraft(disabled)).toEqual({ ...before, sandboxEnabled: false });
  expect(parseConfigDraft(editSandboxEnabled(disabled, true))).toEqual(before);
  expect(() => editSandboxEnabled('{broken', false)).toThrow();
  expect(parseConfigDraft('{"sandboxEnabled":"false"}')).toBeNull();
});

it('does not replace an invalid JSON draft with a default config', () => {
  expect(parseConfigDraft('{broken')).toBeNull();
  expect(parseConfigDraftResult('{broken').error).toBeTruthy();
  expect(() => editSandboxPath('{broken', '/new-root')).toThrow();
  expect(parseConfigDraft('{"presets":[{"name":"default","config":{"provider":"omp","mcpServers":{}}}]}')).toBeNull();
});

it('keeps image generation opt-in and synchronizes capability controls with JSON', () => {
  const before = ConfigSchema.parse({
    appId: 'saved-app',
    sandboxCapabilities: { javascript: true, network: false },
    presets: [{ name: 'default', config: { provider: 'omp/provider/model', systemPrompt: 'Keep this' } }],
  });
  expect(before.sandboxCapabilities.imageGeneration).toBe(false);
  const enabled = editSandboxCapability(JSON.stringify(before), 'imageGeneration', true);
  expect(parseConfigDraft(enabled)).toEqual({
    ...before,
    sandboxCapabilities: { ...before.sandboxCapabilities, imageGeneration: true },
  });
  const manual = JSON.stringify({
    ...JSON.parse(enabled),
    sandboxCapabilities: { javascript: false, network: true, imageGeneration: false },
  });
  expect(parseConfigDraft(manual)?.sandboxCapabilities).toEqual({
    javascript: false,
    network: true,
    imageGeneration: false,
  });
  expect(parseConfigDraft(editSandboxCapability(enabled, 'imageGeneration', false))).toEqual(before);
  expect(() => editSandboxCapability('{broken', 'imageGeneration', true)).toThrow();
  expect(parseConfigDraft('{broken')).toBeNull();
});

it('parses and formats provider/model strings including nested model slashes', () => {
  expect(parseProviderModelSelection('omp')).toEqual({ provider: 'omp', model: '' });
  expect(parseProviderModelSelection('omp/anthropic/claude-sonnet-4-6')).toEqual({
    provider: 'omp',
    model: 'anthropic/claude-sonnet-4-6',
  });
  expect(formatProviderModelSelection('omp', '')).toBe('omp');
  expect(formatProviderModelSelection('omp', 'anthropic/claude-sonnet-4-6')).toBe('omp/anthropic/claude-sonnet-4-6');
});

it('edits preset model, thinking, prompts, and manages preset CRUD safely in one JSON draft', () => {
  const initial = JSON.stringify(ConfigSchema.parse({ appId: 'bot-1' }), null, 2);
  let draft = setPresetProviderModelInDraft(initial, 'default', 'omp', 'anthropic/claude-sonnet-4-6');
  draft = setPresetThinkingInDraft(draft, 'default', 'high');
  draft = setPresetSystemPromptInDraft(draft, 'default', 'Be concise');
  draft = setPresetQqPromptInDraft(draft, 'default', 'Use short replies');
  const parsed = parseConfigDraft(draft)!;
  expect(parsed.presets[0]).toEqual({
    name: 'default',
    config: { provider: 'omp/anthropic/claude-sonnet-4-6', thinkingOptionId: 'high', systemPrompt: 'Be concise' },
    qq: { prompt: 'Use short replies', skills: [], tools: [] },
  });

  // Clear thinking and systemPrompt cleanly removes optional keys
  draft = setPresetThinkingInDraft(draft, 'default', '');
  draft = setPresetSystemPromptInDraft(draft, 'default', '');
  expect(parseConfigDraft(draft)!.presets[0]!.config).toEqual({ provider: 'omp/anthropic/claude-sonnet-4-6' });

  // Add, rename, set default, and delete presets
  draft = addPresetToDraft(draft, 'coding', 'default');
  expect(parseConfigDraft(draft)!.presets.map(p => p.name)).toEqual(['default', 'coding']);
  expect(() => addPresetToDraft(draft, 'coding')).toThrow('已存在');

  draft = setDefaultPresetInDraft(draft, 'coding');
  expect(parseConfigDraft(draft)!.defaultPreset).toBe('coding');

  draft = renamePresetInDraft(draft, 'coding', 'review');
  expect(parseConfigDraft(draft)!.defaultPreset).toBe('review');
  expect(parseConfigDraft(draft)!.presets.map(p => p.name)).toEqual(['default', 'review']);

  draft = deletePresetFromDraft(draft, 'review');
  expect(parseConfigDraft(draft)!.defaultPreset).toBe('default');
  expect(parseConfigDraft(draft)!.presets.map(p => p.name)).toEqual(['default']);
  expect(() => deletePresetFromDraft(draft, 'default')).toThrow('至少需要保留一个');
});

it('edits host game toggle and engine directory and detects unsaved draft changes accurately', () => {
  const saved = ConfigSchema.parse({ appId: 'bot-1' });
  const initial = JSON.stringify(saved, null, 2);
  expect(isConfigDraftDirty(initial, saved)).toBe(false);
  expect(isConfigDraftDirty(JSON.stringify(saved), saved)).toBe(false);

  const toggled = editGameEnabled(initial, true);
  expect(isConfigDraftDirty(toggled, saved)).toBe(true);
  expect(parseConfigDraft(toggled)?.game.enabled).toBe(true);

  const customDir = editGameEngineDirectory(toggled, '~/my-games');
  expect(parseConfigDraft(customDir)?.game.engineDirectory).toBe('~/my-games');
  expect(parseConfigDraft(editGameEngineDirectory(customDir, ''))?.game.engineDirectory).toBe('~/.omp/qqbot-games');
  expect(isConfigDraftDirty('{invalid', saved)).toBe(true);
});
