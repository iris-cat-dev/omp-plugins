// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginClientContext, PluginHostProps, PluginSettingsPageContribution } from '@omp-desktop/plugin';
import type { ProviderSnapshotEntry } from '@omp-desktop/protocol/agent-types';
import { StateSchema } from './state.ts';
import { action, exportAccess, status } from './rpc.ts';
import setup from './client.tsx';

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        surface0: '#181818',
        surface1: '#232323',
        surface2: '#2e2e2e',
        surface3: '#454545',
        border: '#282828',
        borderAccent: '#383838',
        foreground: '#f0f0f0',
        foregroundMuted: '#afafaf',
        foregroundExtraMuted: '#707070',
        accent: '#00dbe4',
        accentForeground: '#000000',
        destructive: '#c64f43',
        destructiveForeground: '#ffffff',
        statusSuccess: '#6cb17b',
        statusWarning: '#c09664',
        statusDanger: '#d8847b',
        statusDotSuccess: '#35c264',
        statusDotWarning: '#db932e',
        statusDotDanger: '#f7796d',
        statusDotRunning: '#5caaf6',
      },
      fontFamily: { mono: 'monospace' },
    },
  }),
}));

vi.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    AlertTriangle: Icon,
    Bot: Icon,
    Brain: Icon,
    Check: Icon,
    CheckCircle2: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    Code: Icon,
    Cpu: Icon,
    Download: Icon,
    ExternalLink: Icon,
    Info: Icon,
    Pencil: Icon,
    Plus: Icon,
    QrCode: Icon,
    RefreshCw: Icon,
    RotateCw: Icon,
    Search: Icon,
    Settings2: Icon,
    Shield: Icon,
    SlidersHorizontal: Icon,
    Sparkles: Icon,
    Terminal: Icon,
    Trash2: Icon,
    Unlink: Icon,
    Upload: Icon,
    X: Icon,
  };
});

vi.mock('react-native', () => {
  const { createElement } = React;
  type Props = React.PropsWithChildren<{
    testID?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean; expanded?: boolean };
    disabled?: boolean;
    onPress?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    value?: string;
    editable?: boolean;
    placeholder?: string;
    multiline?: boolean;
    onChangeText?: (value: string) => void;
    source?: { uri: string };
    visible?: boolean;
  }>;
  return {
    View: ({ children, testID }: Props) => createElement('div', { 'data-testid': testID }, children),
    ScrollView: ({ children, testID }: Props) => createElement('div', { 'data-testid': testID }, children),
    Text: ({ children, testID, accessibilityRole }: Props) =>
      createElement('span', { 'data-testid': testID, role: accessibilityRole }, children),
    Pressable: ({ children, testID, disabled, onPress, accessibilityRole, accessibilityLabel, accessibilityState }: Props) =>
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': testID,
          role: accessibilityRole === 'switch' ? 'switch' : 'button',
          disabled,
          onClick: onPress,
          'aria-label': accessibilityLabel,
          'aria-selected': accessibilityState?.selected,
          'aria-checked': accessibilityState?.checked,
          'aria-expanded': accessibilityState?.expanded,
        },
        children,
      ),
    TextInput: ({ value, editable, onChangeText, onFocus, onBlur, accessibilityLabel, placeholder, multiline }: Props) =>
      createElement(multiline ? 'textarea' : 'input', {
        value: value ?? '',
        disabled: editable === false,
        placeholder,
        'aria-label': accessibilityLabel,
        onFocus,
        onBlur,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          onChangeText?.(event.target.value),
      }),
    Image: ({ source, accessibilityLabel }: Props) =>
      createElement('img', { src: source?.uri, alt: accessibilityLabel }),
    Modal: ({ visible, children }: Props) => (visible ? createElement('div', { role: 'dialog' }, children) : null),
    Linking: { openURL: vi.fn(async () => {}) },
  };
});

afterEach(cleanup);

function createFixture(options: {
  mode?: 'active' | 'manage';
  appId?: string;
  providers?: ProviderSnapshotEntry[];
} = {}) {
  const mode = options.mode ?? 'active';
  const appId = options.appId ?? '102078234';
  const controller = new AbortController();
  let state = StateSchema.parse({
    config: { appId, sandboxEnabled: true, sandboxPath: '/tmp/qq-sandbox' },
    access: {
      revision: 3,
      c2cMode: 'open',
      groupMode: 'allowlist',
      commandMode: 'allowlist',
      allowC2c: [{ openid: 'OPENID_USER_1', nickname: 'Alice', scene: 'c2c', sceneName: '', claimedAt: 100 }],
      allowGroup: [],
      owners: [],
    },
    peers: appId
      ? {
          peer1: {
            appId,
            scope: 'c2c',
            openid: 'OPENID_USER_1',
            hostId: 'srv_host_1',
            workspaceId: 'wks_1',
            agentId: 'agent_1',
            cwd: '/tmp/qq-sandbox',
            preset: 'default',
            template: { name: 'default', config: { provider: 'omp' }, qq: { prompt: '', skills: [], tools: [] } },
            protocolPrompt: 'QQ',
            lastDeliveredSequence: 0,
          },
        }
      : {},
  });

  const makeStatus = () => ({
    generation: 1,
    connection: (appId ? 'ready' : 'waiting') as 'ready' | 'waiting',
    reason: appId ? null : '等待绑定账号',
    appId: state.config.appId,
    secretConfigured: Boolean(appId),
    binding: { phase: 'idle' as const },
    config: state.config,
    access: state.access,
    peers: Object.values(state.peers),
    challenges: [],
    importReport: state.importReport,
  });

  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  const rpc = vi.fn(async (contract: { name: string }, input: unknown) => {
    rpcCalls.push({ name: contract.name, input });
    if (contract === status) return makeStatus();
    if (contract === exportAccess) return { appId: state.config.appId, revision: state.access.revision, text: 'OPENID_USER_1:Alice' };
    if (contract === action) {
      const payload = input as Record<string, unknown>;
      if (payload.kind === 'configure') {
        state = StateSchema.parse({ ...state, config: payload.config, access: { ...state.access, revision: state.access.revision + 1 } });
      } else if (payload.kind === 'access') {
        state = StateSchema.parse({ ...state, access: { ...(payload.access as object), revision: state.access.revision + 1 } });
      } else if (payload.kind === 'rename') {
        state.access.allowC2c = state.access.allowC2c.map(member =>
          member.openid === payload.openid ? { ...member, nickname: String(payload.nickname) } : member,
        );
        state.access.revision++;
      } else if (payload.kind === 'revoke') {
        state.access.allowC2c = state.access.allowC2c.filter(member => member.openid !== payload.openid);
        state.access.revision++;
      }
      return makeStatus();
    }
    throw new Error(`Unexpected RPC: ${contract.name}`);
  });

  const providerSnapshot = vi.fn(async () => ({
    entries: options.providers ?? [
      {
        provider: 'omp',
        label: 'OMP',
        enabled: true,
        status: 'ready',
        models: [
          {
            provider: 'omp',
            id: 'anthropic/claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
            isDefault: true,
            thinkingOptions: [
              { id: 'off', label: 'Off' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
            ],
          },
          {
            provider: 'omp',
            id: 'openai/gpt-5',
            label: 'GPT-5',
            thinkingOptions: [{ id: 'low', label: 'Low' }],
          },
        ],
      },
      {
        provider: 'codex',
        label: 'Codex',
        enabled: true,
        status: 'ready',
        modes: [{ id: 'ask', label: 'Ask' }],
        models: [{ provider: 'codex', id: 'codex-mini', label: 'Codex Mini' }],
      },
    ],
  }));

  const addSettingsPage = vi.fn((_page: PluginSettingsPageContribution) => () => {});
  const ctx = {
    installation: {
      id: 'qqbot',
      packageId: '@omp-desktop/plugin-qqbot',
      owner: 'daemon',
      version: '0.7.2',
      generation: 1,
      enabled: mode === 'active',
      declaredCapabilities: ['agents.events', 'agents.create'],
      grantedCapabilities: ['agents.events', 'agents.create'],
    },
    signal: controller.signal,
    mode,
    role: 'client',
    storage: {
      get: vi.fn(async () => ({ revision: 1, values: structuredClone(state) })),
      patch: vi.fn(),
    },
    secrets: { configured: vi.fn(), set: vi.fn(), delete: vi.fn() },
    omp: {
      providers: {
        snapshot: providerSnapshot,
        refresh: vi.fn(async () => ({})),
        subscribe: vi.fn(() => () => {}),
      },
    },
    rpc,
    addSettingsPage,
    addSurface: vi.fn(),
    addSidebarItem: vi.fn(),
    addWorkspacePanel: vi.fn(),
    addCommandCenterItem: vi.fn(),
  } as unknown as PluginClientContext;

  const props: PluginHostProps = {
    theme: {
      colors: {
        surface0: '#181818',
        foreground: '#f0f0f0',
        foregroundMuted: '#afafaf',
        accent: '#00dbe4',
        accentForeground: '#000000',
        statusDanger: '#d8847b',
      },
    },
    host: { id: 'local', label: 'Local' },
    layout: { compact: false, platform: 'web' },
  };

  setup(ctx);
  const Page = addSettingsPage.mock.calls[0]![0].Component;
  const renderResult = render(<Page {...props} installation={ctx.installation} mode={mode} />);
  return {
    ...renderResult,
    ctx,
    controller,
    rpc,
    rpcCalls,
    providerSnapshot,
    getState: () => state,
  };
}

describe('QQBot refactored settings UI', () => {
  it('opens account tab by default when unbound and shows AppID/AppSecret controls', async () => {
    const f = createFixture({ appId: '' });
    await screen.findByTestId('qqbot-section-account');
    expect(screen.getByLabelText('QQ AppID')).toBeTruthy();
    expect(screen.getByLabelText('QQ AppSecret')).toBeTruthy();
    expect(screen.getByTestId('qqbot-connection-status').textContent).toContain('等待连接');
    f.controller.abort();
  });

  it('opens model tab when bound, selects live model & thinking level, and saves via configure RPC', async () => {
    const f = createFixture({ appId: '102078234' });
    await screen.findByTestId('qqbot-section-model');
    expect(screen.getByTestId('qqbot-connection-status').textContent).toContain('已连接');

    const trigger = await screen.findByTestId('qqbot-model-picker-trigger');
    fireEvent.click(trigger);

    await screen.findByTestId('qqbot-model-picker-modal');
    // Non-OMP provider is blocked while sandbox is enabled
    const codexOption = screen.getByRole('button', { name: /Codex Mini/ });
    expect(codexOption.hasAttribute('disabled')).toBe(true);

    // Pick Claude Sonnet 4.6
    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet 4.6/ }));
    await waitFor(() => expect(screen.queryByTestId('qqbot-model-picker-modal')).toBeNull());

    // Pick thinking intensity "高"
    fireEvent.click(screen.getByRole('button', { name: '高' }));

    // Toggle requireMention off
    fireEvent.click(screen.getByTestId('qqbot-require-mention-switch'));

    // Unsaved bar appears and saves to daemon
    const saveBtn = await screen.findByTestId('qqbot-save-config');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const configureCall = f.rpcCalls.find(
        call =>
          call.name === 'qqbot.action' &&
          typeof call.input === 'object' &&
          call.input !== null &&
          'kind' in call.input &&
          call.input.kind === 'configure',
      );
      expect(configureCall).toBeTruthy();
      expect(f.getState().config.presets[0]?.config).toEqual({
        provider: 'omp/anthropic/claude-sonnet-4-6',
        thinkingOptionId: 'high',
      });
      expect(f.getState().config.requireMention).toBe(false);
    });
    f.controller.abort();
  });

  it('does not call host providers in manage mode and allows manual model editing', async () => {
    const f = createFixture({ mode: 'manage', appId: '102078234' });
    await screen.findByTestId('qqbot-section-model');
    expect(f.providerSnapshot).not.toHaveBeenCalled();

    const modelInput = screen.getByLabelText('Preset 模型 ID');
    fireEvent.change(modelInput, { target: { value: 'openai/gpt-5' } });
    fireEvent.click(await screen.findByTestId('qqbot-save-config'));

    await waitFor(() => {
      expect(f.getState().config.presets[0]?.config.provider).toBe('omp/openai/gpt-5');
    });
    f.controller.abort();
  });

  it('keeps sandbox controls synchronized with JSON draft and preserves invalid JSON', async () => {
    const f = createFixture({ appId: '102078234' });
    await screen.findByTestId('qqbot-section-model');

    fireEvent.click(screen.getByTestId('qqbot-tab-sandbox'));
    await screen.findByTestId('qqbot-section-sandbox');

    const toggle = screen.getByTestId('qqbot-sandbox-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.change(screen.getByLabelText('QQ 沙箱路径'), { target: { value: '/custom/sandbox' } });
    fireEvent.click(screen.getByTestId('qqbot-cap-image'));

    // Switch to Advanced tab -> open JSON -> verify exact sync
    fireEvent.click(screen.getByTestId('qqbot-tab-advanced'));
    await screen.findByTestId('qqbot-section-advanced');
    fireEvent.click(screen.getByTestId('qqbot-json-toggle'));

    const jsonBox = screen.getByLabelText('QQ 配置 JSON') as HTMLTextAreaElement;
    const parsed = JSON.parse(jsonBox.value);
    expect(parsed.sandboxEnabled).toBe(false);
    expect(parsed.sandboxPath).toBe('/custom/sandbox');
    expect(parsed.sandboxCapabilities.imageGeneration).toBe(true);

    // Break JSON -> draft preserved and sandbox tab reports error instead of resetting
    fireEvent.change(jsonBox, { target: { value: '{broken' } });
    expect(jsonBox.value).toBe('{broken');
    fireEvent.click(screen.getByTestId('qqbot-tab-sandbox'));
    expect(screen.getByRole('alert').textContent).toContain('JSON');
    f.controller.abort();
  });

  it('renders peer agents cleanly without literal \\n and supports access mode + member rename', async () => {
    const f = createFixture({ appId: '102078234' });
    await screen.findByTestId('qqbot-section-model');

    // Verify peer agents have no literal "\n"
    fireEvent.click(screen.getByTestId('qqbot-tab-advanced'));
    const advanced = await screen.findByTestId('qqbot-section-advanced');
    expect(advanced.textContent).toContain('OPENID_USER_1');
    expect(advanced.textContent).toContain('srv_host_1');
    expect(advanced.textContent).not.toContain('\\n');

    // Verify access controls & member rename
    fireEvent.click(screen.getByTestId('qqbot-tab-access'));
    await screen.findByTestId('qqbot-section-access');
    const c2cControl = screen.getByTestId('qqbot-access-c2c');
    const allowlistBtn = Array.from(c2cControl.querySelectorAll('button')).find(btn => btn.textContent === '仅名单')!;
    fireEvent.click(allowlistBtn);
    await waitFor(() => expect(f.getState().access.c2cMode).toBe('allowlist'));

    fireEvent.click(screen.getByLabelText('修改 Alice 昵称'));
    fireEvent.change(screen.getByLabelText('修改成员昵称'), { target: { value: 'Alice Updated' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(f.getState().access.allowC2c[0]?.nickname).toBe('Alice Updated'));
    f.controller.abort();
  });
});
