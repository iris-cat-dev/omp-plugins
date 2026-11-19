import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Code, Upload } from 'lucide-react-native';
import { peerKey, type Config, type Peer } from '../state.ts';
import {
  ActionButton,
  Badge,
  CollapsibleRow,
  InlineBanner,
  SectionCard,
  SettingRow,
  SwitchControl,
  TextField,
  usePalette,
} from './primitives.tsx';

export function PeerAgentsCard({
  peers,
  modelSelections,
  presetSelections,
  title = '活跃会话（Desktop Peer Agents）',
}: {
  peers: readonly Peer[];
  modelSelections: Record<string, string | null>;
  presetSelections: Record<string, string>;
  title?: string;
}) {
  const p = usePalette();
  return (
    <SectionCard
      title={title}
      subtitle="每个 QQ 私聊或群聊对应独立的 Desktop Agent，可在 Desktop 中继续查看与恢复"
      trailing={<Badge label={`${peers.length} 个会话`} />}
    >
      {peers.length === 0 ? (
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 13, color: p.foregroundMuted }}>
            首条获准 QQ 消息将在 Desktop 创建可恢复的真实 Agent。
          </Text>
        </View>
      ) : (
        peers.map((peer, index) => {
          const key = peerKey(peer.appId, peer.scope, peer.openid);
          const modelOverride = modelSelections[key];
          const nextPreset = presetSelections[key];
          return (
            <View
              key={peer.agentId}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                gap: 6,
                ...(index > 0 ? { borderTopWidth: 1, borderTopColor: p.border } : null),
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Badge label={peer.scope === 'group' ? '群聊' : '私聊'} tone={peer.scope === 'group' ? 'accent' : 'neutral'} />
                <Text selectable style={{ fontSize: 13, fontWeight: '500', fontFamily: p.monoFont, color: p.foreground }}>
                  {peer.openid}
                </Text>
                <Badge label={`preset: ${peer.preset}`} />
                {nextPreset && nextPreset !== peer.preset ? (
                  <Badge label={`下次: ${nextPreset}`} tone="warning" />
                ) : null}
                {modelOverride ? <Badge label={`模型: ${modelOverride}`} tone="accent" mono /> : null}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                <Text selectable style={{ fontSize: 11, fontFamily: p.monoFont, color: p.foregroundMuted }}>
                  主机 {peer.hostId}
                </Text>
                <Text selectable style={{ fontSize: 11, fontFamily: p.monoFont, color: p.foregroundMuted }}>
                  工作区 {peer.workspaceId}
                </Text>
                <Text selectable style={{ fontSize: 11, fontFamily: p.monoFont, color: p.foregroundMuted }}>
                  Agent {peer.agentId}
                </Text>
              </View>
            </View>
          );
        })
      )}
    </SectionCard>
  );
}

export function AdvancedSection({
  showPeers = true,
  peers,
  modelSelections,
  presetSelections,
  configDraft,
  configError,
  configText,
  hasUnsavedConfig,
  busy,
  jsonOpen,
  onToggleJsonOpen,
  onChangeConfigText,
  onSaveConfig,
  importDocument,
  importSecret,
  importReport,
  onChangeImportDocument,
  onToggleImportSecret,
  onImportDsh,
}: {
  showPeers?: boolean;
  peers: readonly Peer[];
  modelSelections: Record<string, string | null>;
  presetSelections: Record<string, string>;
  configDraft: Config | null;
  configError: string | null;
  configText: string;
  hasUnsavedConfig: boolean;
  busy: boolean;
  jsonOpen: boolean;
  onToggleJsonOpen: () => void;
  onChangeConfigText: (nextText: string) => void;
  onSaveConfig: () => void;
  importDocument: string;
  importSecret: boolean;
  importReport: readonly string[];
  onChangeImportDocument: (value: string) => void;
  onToggleImportSecret: (value: boolean) => void;
  onImportDsh: () => void;
}) {
  const p = usePalette();
  const [importOpen, setImportOpen] = useState(importReport.length > 0);
  const effectiveJsonOpen = jsonOpen || !configDraft;

  return (
    <View style={{ gap: 20 }} testID="qqbot-section-advanced">
      {showPeers ? (
        <PeerAgentsCard
          peers={peers}
          modelSelections={modelSelections}
          presetSelections={presetSelections}
        />
      ) : null}

      <SectionCard title="原始配置与数据迁移">
        <CollapsibleRow
          title="原始配置 JSON"
          hint="与图形界面共享同一份配置草稿，适合批量检查或复制配置"
          badge={
            configDraft ? (
              <Badge label={hasUnsavedConfig ? '有未保存更改' : 'JSON 有效'} tone={hasUnsavedConfig ? 'warning' : 'success'} />
            ) : (
              <Badge label="JSON 有误" tone="danger" />
            )
          }
          open={effectiveJsonOpen}
          onToggle={onToggleJsonOpen}
          testID="qqbot-json-toggle"
        >
          <View style={{ padding: 16, gap: 12 }}>
            {configError ? <InlineBanner tone="danger" role="alert" message={`JSON 校验未通过：${configError}`} /> : null}
            <TextField
              accessibilityLabel="QQ 配置 JSON"
              multiline
              mono
              value={configText}
              editable={!busy}
              onChangeText={onChangeConfigText}
              style={{ minHeight: 260 }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <ActionButton
                label="保存配置"
                variant="primary"
                size="sm"
                disabled={busy || !configDraft}
                onPress={onSaveConfig}
                testID="qqbot-json-save"
              />
              {configDraft ? (
                <ActionButton
                  icon={Code}
                  label="格式化 JSON"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onPress={() => onChangeConfigText(JSON.stringify(configDraft, null, 2))}
                />
              ) : null}
            </View>
          </View>
        </CollapsibleRow>

        <CollapsibleRow
          title="显式导入 DSH QQ 设置"
          hint="粘贴旧 cordis.patch.yml、im-qqbot 配置或成员 JSON 迁移；原文件与历史保持原样"
          badge={importReport.length > 0 ? <Badge label={`上次报告 ${importReport.length} 条`} tone="neutral" /> : undefined}
          open={importOpen}
          onToggle={() => setImportOpen(v => !v)}
          bordered
          testID="qqbot-dsh-import-toggle"
        >
          <View style={{ padding: 16, gap: 12 }}>
            <TextField
              label="DSH 配置文档（YAML / JSON）"
              accessibilityLabel="DSH QQ 配置 YAML"
              placeholder="粘贴 cordis.patch.yml、im-qqbot 配置或 {config, members, preferences, desktopPresets}"
              multiline
              mono
              value={importDocument}
              editable={!busy}
              onChangeText={onChangeImportDocument}
              style={{ minHeight: 120 }}
            />

            <View
              style={{
                borderRadius: 8,
                borderWidth: 1,
                borderColor: p.border,
                backgroundColor: p.surface0,
              }}
            >
              <SettingRow
                title="一并导入凭据（AppSecret）"
                hint="通过专用 secret 操作安全提交；关闭则仅导入非密钥配置"
              >
                <SwitchControl
                  accessibilityLabel="一并导入 DSH 凭据"
                  value={importSecret}
                  disabled={busy}
                  onValueChange={onToggleImportSecret}
                />
              </SettingRow>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <ActionButton
                icon={Upload}
                label="导入选择的 DSH 数据"
                variant="secondary"
                size="sm"
                disabled={busy || !importDocument.trim()}
                onPress={onImportDsh}
                testID="qqbot-dsh-import-submit"
              />
            </View>

            {importReport.length > 0 ? (
              <View
                style={{
                  padding: 12,
                  borderRadius: 8,
                  backgroundColor: p.surface2,
                  borderWidth: 1,
                  borderColor: p.border,
                  gap: 4,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '600', color: p.foreground }}>导入报告</Text>
                {importReport.map((line, i) => (
                  <Text key={i} style={{ fontSize: 12, lineHeight: 17, color: p.foregroundMuted }}>
                    • {line}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </CollapsibleRow>
      </SectionCard>
    </View>
  );
}
