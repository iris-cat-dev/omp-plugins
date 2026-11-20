import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PluginClientContext, PluginHostProps } from '@omp-desktop/plugin';
import { Bot, CheckCircle2, RefreshCw, RotateCw, Settings2, Shield, SlidersHorizontal, Terminal } from 'lucide-react-native';
import { z } from 'zod';
import { status, action, exportAccess, StatusSchema } from './rpc.ts';
import { StateSchema, ConfigSchema, AccessSchema, type Peer, type State } from './state.ts';
import type { PairPurpose } from './shared/pairing-protocol.ts';
import { prepareDshImport } from './importer.ts';
import {
  getPreset,
  isConfigDraftDirty,
  parseConfigDraftResult,
  parseProviderModelSelection,
} from './shared/config-draft.ts';
import { useQQPalette } from './ui/palette.ts';
import {
  ActionButton,
  Badge,
  InlineBanner,
  PaletteContext,
  SegmentedControl,
  StatusPill,
} from './ui/primitives.tsx';
import { useHostProviders } from './ui/providers.ts';
import { ModelAndChatSection } from './ui/model-section.tsx';
import { AccountSection } from './ui/account-section.tsx';
import { AccessSection } from './ui/access-section.tsx';
import { SandboxAndGameSection } from './ui/sandbox-section.tsx';
import { AdvancedSection, PeerAgentsCard } from './ui/advanced-section.tsx';

type SectionTab = 'model' | 'account' | 'access' | 'sandbox' | 'advanced';

const connectionLabels = {
  waiting: '等待连接',
  connecting: '正在连接',
  ready: '已连接',
  failed: '连接失败',
} as const;

function isPeerRecoveryReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /History is unavailable without activating this session|OMP session file no longer exists|OMP session file is missing a valid session header/i.test(
    reason,
  )
    || reason.includes('QQ peer 映射属于另一 daemon')
    || reason.includes('持久 QQ peer 映射属于另一 daemon')
    || reason.includes('Desktop agent 未确认当前 QQ 沙箱');
}

function formatConnectionReason(reason: string, canRecoverPeers: boolean): string {
  const suffix = canRecoverPeers
    ? '可点击右侧「重置会话并重连」清理旧映射并重建连接（账号、名单、模型偏好与游戏存档不受影响）。'
    : '请前往「会话与高级」重置损坏会话映射，或恢复对应的 OMP 会话文件后重启连接。';
  if (
    /History is unavailable without activating this session|OMP session file no longer exists|OMP session file is missing a valid session header/i.test(
      reason,
    )
  ) {
    return `检测到已有 QQ 会话的历史文件丢失或无法读取，导致网关启动失败。${suffix}\n原始错误：${reason}`;
  }
  if (reason.includes('QQ peer 映射属于另一 daemon') || reason.includes('持久 QQ peer 映射属于另一 daemon')) {
    return `检测到已有 QQ 会话映射属于另一台主机或 daemon。${suffix}\n原始错误：${reason}`;
  }
  return reason;
}

export default function setup(ctx: PluginClientContext) {
  const Page = (props: PluginHostProps) => <QQPage context={ctx} {...props} />;
  ctx.addSettingsPage({ id: 'qqbot.settings', title: 'QQ 连接', icon: 'message-circle', Component: Page });
  ctx.addSurface('qqbot', Page);
  ctx.addSidebarItem({ id: 'qqbot', title: 'QQ 连接', icon: 'message-circle', surface: 'qqbot' });
  ctx.addWorkspacePanel({
    id: 'qqbot.peer',
    title: 'QQ 连接',
    icon: 'message-circle',
    context: 'agent',
    Component: props => <QQPage {...props} context={ctx} filterAgentId={props.agentId} />,
  });
  ctx.addCommandCenterItem({
    id: 'qqbot.open',
    title: 'QQ 连接设置',
    icon: 'message-circle',
    context: 'global',
    onSelect: command => command.openSurface('qqbot'),
  });
}

function QQPage({
  context: ctx,
  theme,
  layout,
  filterAgentId,
}: PluginHostProps & { context: PluginClientContext; filterAgentId?: string }) {
  const palette = useQQPalette(theme);
  const providers = useHostProviders(ctx);

  const [snapshot, setSnapshot] = useState<z.infer<typeof StatusSchema> | null>(null);
  const [state, setState] = useState<State>(() => StateSchema.parse({}));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [activeTab, setActiveTab] = useState<SectionTab>(filterAgentId ? 'advanced' : 'account');
  const [jsonOpen, setJsonOpen] = useState(false);

  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [configText, setConfigText] = useState('');
  const [purpose, setPurpose] = useState<PairPurpose>('allow-c2c');
  const [entries, setEntries] = useState('');
  const [exportText, setExportText] = useState('');
  const [importDocument, setImportDocument] = useState('');
  const [importSecret, setImportSecret] = useState(false);

  const dirty = useRef({ account: false, config: false });
  const initialTabResolved = useRef(Boolean(filterAgentId));
  const userSwitchedTab = useRef(false);

  const load = useCallback(
    async (updateDraft = false) => {
      const stored = await ctx.storage.get();
      if (ctx.signal.aborted) return;
      const parsed = StateSchema.parse(stored.values);
      setState(parsed);
      const live = await ctx.rpc(status, {});
      if (ctx.signal.aborted) return;
      setSnapshot(live);
      setConnectionError(null);
      if (updateDraft) dirty.current = { account: false, config: false };
      if (!dirty.current.config) setConfigText(JSON.stringify(live.config, null, 2));
      if (!dirty.current.account) setAppId(live.appId);
      if (!initialTabResolved.current) {
        initialTabResolved.current = true;
        if (!userSwitchedTab.current) {
          setActiveTab(live.appId ? 'model' : 'account');
        }
      }
    },
    [ctx],
  );

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await load(false);
      } catch (failure) {
        if (!closed && !ctx.signal.aborted) {
          setConnectionError(failure instanceof Error ? failure.message : String(failure));
        }
      }
      if (!closed && !ctx.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void load(true).then(
      () => {
        if (!closed && !ctx.signal.aborted) timer = setTimeout(poll, 2000);
      },
      failure => {
        if (!closed && !ctx.signal.aborted) {
          setConnectionError(failure instanceof Error ? failure.message : String(failure));
          timer = setTimeout(poll, 2000);
        }
      },
    );
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [ctx, load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = (fn: () => Promise<unknown>, successMessage?: string) => {
    if (busy || ctx.signal.aborted) return;
    setBusy(true);
    setError(null);
    void fn()
      .then(() => load(false))
      .then(() => {
        if (!ctx.signal.aborted && successMessage) setNotice(successMessage);
      })
      .catch(failure => {
        if (!ctx.signal.aborted) {
          setError(
            failure instanceof Error && failure.message.includes('CONFLICT')
              ? '账号或访问权限已被修改。请刷新后重新确认，未覆盖新设置。'
              : failure instanceof Error
                ? failure.message
                : String(failure),
          );
        }
      })
      .finally(() => {
        if (!ctx.signal.aborted) setBusy(false);
      });
  };

  const invoke = (value: z.input<typeof action.input>, successMessage?: string) =>
    run(async () => {
      const result = await ctx.rpc(action, value);
      if (!ctx.signal.aborted) setSnapshot(result);
    }, successMessage);

  const selectTab = (next: SectionTab) => {
    userSwitchedTab.current = true;
    setActiveTab(next);
  };

  const updateConfigText = (nextText: string) => {
    dirty.current.config = true;
    setError(null);
    setNotice(null);
    setConfigText(nextText);
  };

  const savedConfig = snapshot?.config ?? null;
  const draftResult = useMemo(() => parseConfigDraftResult(configText), [configText]);
  const configDraft = draftResult.config;
  const configError = configText.trim() ? draftResult.error : null;
  const hasUnsavedConfig = useMemo(
    () => Boolean(savedConfig && configText.trim() && isConfigDraftDirty(configText, savedConfig)),
    [configText, savedConfig],
  );

  const allPeers = snapshot?.peers ?? Object.values(state.peers);
  const currentAppId = snapshot?.appId ?? state.config.appId;
  const peers = allPeers.filter(
    peer => !filterAgentId || peer.agentId === filterAgentId,
  );
  const currentAppPeers = currentAppId
    ? allPeers.filter(peer => peer.appId === currentAppId)
    : [];
  const access = snapshot?.access ?? state.access;

  const connectionLabel =
    ctx.mode === 'manage'
      ? '执行已禁用'
      : connectionError
        ? '读取失败'
        : snapshot
          ? connectionLabels[snapshot.connection]
          : '正在读取';

  const connectionTone: 'ready' | 'connecting' | 'waiting' | 'failed' | 'disabled' =
    ctx.mode === 'manage'
      ? 'disabled'
      : connectionError || snapshot?.connection === 'failed'
        ? 'failed'
        : snapshot?.connection === 'ready'
          ? 'ready'
          : snapshot?.connection === 'connecting'
            ? 'connecting'
            : 'waiting';

  const defaultPresetSummary = useMemo(() => {
    const activeConfig = configDraft ?? savedConfig;
    if (!activeConfig) return null;
    const preset = getPreset(activeConfig, activeConfig.defaultPreset);
    const { provider, model } = parseProviderModelSelection(preset.config.provider);
    return model ? `${provider}/${model}` : `${provider} 默认`;
  }, [configDraft, savedConfig]);

  const handleSaveConfig = () => {
    run(async () => {
      const config = ConfigSchema.parse(JSON.parse(configText));
      const result = await ctx.rpc(action, {
        kind: 'configure',
        config,
        accessRevision: access.revision,
      });
      if (!ctx.signal.aborted) {
        dirty.current.config = false;
        setSnapshot(result);
        setConfigText(JSON.stringify(result.config, null, 2));
      }
    }, '配置已保存');
  };

  const handleDiscardConfig = () => {
    if (!savedConfig) return;
    dirty.current.config = false;
    setError(null);
    setConfigText(JSON.stringify(savedConfig, null, 2));
  };

  const handleSaveAccount = () => {
    run(async () => {
      if (!appId.trim()) throw new Error('请填写 AppID');
      const credentialKey = secret ? `credential-draft:${crypto.randomUUID()}` : undefined;
      try {
        if (credentialKey) {
          await ctx.secrets.set(credentialKey, secret);
          setSecret('');
        }
        const result = await ctx.rpc(action, {
          kind: 'replace',
          appId: appId.trim(),
          credentialKey,
          accessRevision: access.revision,
        });
        if (!ctx.signal.aborted) {
          dirty.current.account = false;
          setSnapshot(result);
        }
      } finally {
        if (credentialKey) await ctx.secrets.delete(credentialKey);
      }
    }, '账号凭据已更新');
  };

  const handleAccessMode = (
    field: 'c2cMode' | 'groupMode' | 'commandMode',
    modeValue: 'open' | 'allowlist' | 'disabled',
  ) => {
    const updated = AccessSchema.parse({ ...access, [field]: modeValue });
    invoke({ kind: 'access', access: updated, accessRevision: access.revision });
  };

  const handleImportDsh = () => {
    run(async () => {
      const prepared = prepareDshImport(importDocument);
      const credentialKey =
        importSecret && prepared.secret ? `credential-draft:${crypto.randomUUID()}` : undefined;
      try {
        if (credentialKey) {
          if (!prepared.appId) throw new Error('所选凭据缺少 AppID');
          await ctx.secrets.set(credentialKey, prepared.secret!);
        }
        const result = await ctx.rpc(action, {
          kind: 'import',
          source: 'dsh-qqbot',
          document: prepared.document,
          credentialKey,
          accessRevision: access.revision,
        });
        if (!ctx.signal.aborted) {
          dirty.current.config = false;
          dirty.current.account = false;
          setImportDocument('');
          setSnapshot(result);
          setConfigText(JSON.stringify(result.config, null, 2));
          setAppId(result.appId);
        }
      } finally {
        if (credentialKey) await ctx.secrets.delete(credentialKey);
      }
    }, 'DSH 数据已导入');
  };

  const handleResetPeer = (peer: Peer) =>
    invoke(
      {
        kind: 'reset-peer',
        scope: peer.scope,
        openid: peer.openid,
        accessRevision: access.revision,
      },
      '已重置该 QQ 会话映射',
    );

  const handleResetAllPeers = () =>
    invoke(
      {
        kind: 'reset-peers',
        accessRevision: access.revision,
      },
      '已重置当前账号的全部 QQ 会话映射并尝试重连',
    );

  const canRecoverPeers = Boolean(
    ctx.mode === 'active'
      && snapshot?.connection === 'failed'
      && currentAppPeers.length > 0
      && isPeerRecoveryReason(snapshot.reason),
  );

  const jumpToJson = () => {
    setJsonOpen(true);
    selectTab('advanced');
  };

  return (
    <PaletteContext.Provider value={palette}>
      <ScrollView
        style={{ flex: 1, backgroundColor: palette.surface0 }}
        contentContainerStyle={{
          padding: layout.compact ? 14 : 20,
          gap: 16,
          maxWidth: 920,
          width: '100%',
          alignSelf: 'center',
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Top Overview & Connection Header */}
        <View
          style={{
            padding: 16,
            borderRadius: 12,
            backgroundColor: palette.surface1,
            borderWidth: 1,
            borderColor: palette.border,
            gap: 12,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  backgroundColor: palette.surface2,
                  borderWidth: 1,
                  borderColor: palette.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Bot size={18} color={palette.accent} />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '700', color: palette.foreground }}>QQ 连接</Text>
              <StatusPill
                testID="qqbot-connection-status"
                label={`连接状态：${connectionLabel}`}
                tone={connectionTone}
              />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <ActionButton
                icon={RefreshCw}
                label="刷新状态"
                variant="outline"
                size="sm"
                disabled={busy}
                onPress={() => run(() => load(true))}
                testID="qqbot-refresh-status"
              />
              {ctx.mode === 'active' ? (
                <ActionButton
                  icon={RotateCw}
                  label="重启 QQ 连接"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onPress={() => invoke({ kind: 'restart' }, '已触发重启 QQ 连接')}
                  testID="qqbot-restart"
                />
              ) : null}
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {snapshot?.appId ? (
              <Badge label={`AppID ${snapshot.appId}`} mono />
            ) : (
              <Badge label="未绑定账号" tone="warning" />
            )}
            {defaultPresetSummary ? <Badge label={`模型 ${defaultPresetSummary}`} mono /> : null}
            {configDraft ? (
              <Badge
                label={configDraft.sandboxEnabled ? '沙箱开启' : '宿主模式'}
                tone={configDraft.sandboxEnabled ? 'success' : 'danger'}
              />
            ) : null}
          </View>

          {ctx.mode === 'active' && snapshot?.reason ? (
            <InlineBanner
              tone={snapshot.connection === 'failed' ? 'danger' : 'info'}
              message={formatConnectionReason(snapshot.reason, canRecoverPeers)}
              action={
                canRecoverPeers ? (
                  <ActionButton
                    icon={RotateCw}
                    label="重置会话并重连"
                    variant="danger"
                    size="xs"
                    disabled={busy}
                    onPress={handleResetAllPeers}
                    testID="qqbot-recover-peers"
                  />
                ) : undefined
              }
            />
          ) : null}
        </View>

        {/* Global Error / Notice Banners */}
        {error || connectionError ? (
          <InlineBanner tone="danger" role="alert" message={error ?? connectionError ?? ''} />
        ) : null}

        {notice ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 13,
              paddingVertical: 9,
              borderRadius: 8,
              backgroundColor: palette.surface2,
              borderWidth: 1,
              borderColor: palette.statusSuccess,
            }}
          >
            <CheckCircle2 size={15} color={palette.statusSuccess} />
            <Text style={{ fontSize: 13, color: palette.foreground }}>{notice}</Text>
          </View>
        ) : null}

        {/* Unsaved Config Action Bar */}
        {hasUnsavedConfig ? (
          <View
            testID="qqbot-unsaved-bar"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: palette.surface1,
              borderWidth: 1,
              borderColor: configDraft ? palette.accent : palette.statusDanger,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '500', color: configDraft ? palette.foreground : palette.statusDanger }}>
              {configDraft ? '配置有未保存的更改' : '配置 JSON 格式有误（已保留草稿，请修复后保存）'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActionButton
                label="放弃修改"
                variant="ghost"
                size="sm"
                disabled={busy}
                onPress={handleDiscardConfig}
                testID="qqbot-discard-config"
              />
              {configDraft ? (
                <ActionButton
                  label="保存配置"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onPress={handleSaveConfig}
                  testID="qqbot-save-config"
                />
              ) : (
                <ActionButton
                  label="前往 JSON 修复"
                  variant="outline"
                  size="sm"
                  onPress={jumpToJson}
                />
              )}
            </View>
          </View>
        ) : null}

        {/* Focused Agent Panel Card (when opened inside an agent workspace panel) */}
        {filterAgentId ? (
          <PeerAgentsCard
            title="当前 Agent 关联的 QQ 会话"
            peers={peers}
            currentAppId={currentAppId}
            modelSelections={state.modelSelections}
            presetSelections={state.presetSelections}
            busy={busy}
            onResetPeer={handleResetPeer}
          />
        ) : null}

        {/* Navigation Tabs */}
        <SegmentedControl<SectionTab>
          value={activeTab}
          onChange={selectTab}
          fullWidth={!layout.compact}
          testID="qqbot-tabs"
          options={[
            { value: 'model', label: '模型与对话', icon: SlidersHorizontal, testID: 'qqbot-tab-model' },
            { value: 'account', label: '账号与绑定', icon: Bot, testID: 'qqbot-tab-account' },
            { value: 'access', label: '访问权限', icon: Shield, testID: 'qqbot-tab-access' },
            { value: 'sandbox', label: '沙箱与扩展', icon: Terminal, testID: 'qqbot-tab-sandbox' },
            {
              value: 'advanced',
              label: '会话与高级',
              icon: Settings2,
              badge: !configDraft && configText.trim() ? '!' : peers.length > 0 ? peers.length : undefined,
              testID: 'qqbot-tab-advanced',
            },
          ]}
        />

        {/* Active Tab Content */}
        {activeTab === 'model' ? (
          <ModelAndChatSection
            configDraft={configDraft}
            configText={configText}
            busy={busy}
            compact={layout.compact}
            providers={providers}
            onUpdateConfigText={updateConfigText}
            onReportError={setError}
            onJumpToJson={jumpToJson}
          />
        ) : null}

        {activeTab === 'account' ? (
          <AccountSection
            mode={ctx.mode}
            snapshot={snapshot}
            appId={appId}
            secret={secret}
            busy={busy}
            onChangeAppId={value => {
              dirty.current.account = true;
              setAppId(value);
            }}
            onChangeSecret={setSecret}
            onSaveAccount={handleSaveAccount}
            onBind={() => invoke({ kind: 'bind' })}
            onRefreshQr={() => invoke({ kind: 'refresh' })}
            onUnbind={() => invoke({ kind: 'unbind', accessRevision: access.revision }, '已解绑账号')}
          />
        ) : null}

        {activeTab === 'access' ? (
          <AccessSection
            mode={ctx.mode}
            access={access}
            challenges={snapshot?.challenges ?? []}
            busy={busy}
            compact={layout.compact}
            purpose={purpose}
            entries={entries}
            exportText={exportText}
            onChangePurpose={setPurpose}
            onChangeEntries={setEntries}
            onClearExport={() => setExportText('')}
            onChangeAccessMode={handleAccessMode}
            onManualAdd={() =>
              run(async () => {
                const result = await ctx.rpc(action, {
                  kind: 'manual',
                  purpose,
                  text: entries,
                  accessRevision: access.revision,
                });
                if (!ctx.signal.aborted) {
                  setSnapshot(result);
                  setEntries('');
                }
              }, '名单已更新')
            }
            onIssuePair={() => invoke({ kind: 'pair', purpose, accessRevision: access.revision })}
            onEndPair={code => invoke({ kind: 'end-pair', code })}
            onExportList={() =>
              run(async () => {
                const result = await ctx.rpc(exportAccess, {
                  purpose,
                  accessRevision: access.revision,
                });
                if (!ctx.signal.aborted) setExportText(result.text);
              })
            }
            onRevokeMember={openid =>
              invoke(
                { kind: 'revoke', purpose, openid, accessRevision: access.revision },
                '已撤销该成员权限',
              )
            }
            onRenameMember={(openid, nickname) =>
              invoke(
                { kind: 'rename', purpose, openid, nickname, accessRevision: access.revision },
                '昵称已更新',
              )
            }
          />
        ) : null}

        {activeTab === 'sandbox' ? (
          <SandboxAndGameSection
            configDraft={configDraft}
            configText={configText}
            busy={busy}
            onUpdateConfigText={updateConfigText}
            onReportError={setError}
            onJumpToJson={jumpToJson}
          />
        ) : null}

        {activeTab === 'advanced' ? (
          <AdvancedSection
            showPeers={!filterAgentId}
            peers={peers}
            currentAppId={currentAppId}
            modelSelections={state.modelSelections}
            presetSelections={state.presetSelections}
            onResetPeer={handleResetPeer}
            onResetAllPeers={handleResetAllPeers}
            configDraft={configDraft}
            configError={configError}
            configText={configText}
            hasUnsavedConfig={hasUnsavedConfig}
            busy={busy}
            jsonOpen={jsonOpen}
            onToggleJsonOpen={() => setJsonOpen(v => !v)}
            onChangeConfigText={updateConfigText}
            onSaveConfig={handleSaveConfig}
            importDocument={importDocument}
            importSecret={importSecret}
            importReport={snapshot?.importReport ?? state.importReport}
            onChangeImportDocument={setImportDocument}
            onToggleImportSecret={setImportSecret}
            onImportDsh={handleImportDsh}
          />
        ) : null}
      </ScrollView>
    </PaletteContext.Provider>
  );
}
