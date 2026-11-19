import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { Config } from '../state.ts';
import {
  editGameEnabled,
  editGameEngineDirectory,
  editSandboxCapability,
  editSandboxEnabled,
  editSandboxPath,
} from '../shared/config-draft.ts';
import {
  ActionButton,
  Badge,
  InlineBanner,
  SectionCard,
  SettingRow,
  SwitchControl,
  TextField,
  usePalette,
} from './primitives.tsx';

export function SandboxAndGameSection({
  configDraft,
  configText,
  busy,
  onUpdateConfigText,
  onReportError,
  onJumpToJson,
}: {
  configDraft: Config | null;
  configText: string;
  busy: boolean;
  onUpdateConfigText: (nextText: string) => void;
  onReportError: (message: string) => void;
  onJumpToJson: () => void;
}) {
  const p = usePalette();
  const [sandboxPathInput, setSandboxPathInput] = useState(configDraft?.sandboxPath ?? '');
  const [sandboxPathFocused, setSandboxPathFocused] = useState(false);
  const [engineDirInput, setEngineDirInput] = useState(configDraft?.game.engineDirectory ?? '~/.omp/qqbot-games');
  const [engineDirFocused, setEngineDirFocused] = useState(false);

  useEffect(() => {
    if (!sandboxPathFocused && configDraft) {
      setSandboxPathInput(configDraft.sandboxPath);
    }
  }, [configDraft?.sandboxPath, sandboxPathFocused]);

  useEffect(() => {
    if (!engineDirFocused && configDraft) {
      setEngineDirInput(configDraft.game.engineDirectory);
    }
  }, [configDraft?.game.engineDirectory, engineDirFocused]);

  const applyDraft = (fn: () => string) => {
    try {
      onUpdateConfigText(fn());
    } catch (error) {
      onReportError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!configDraft) {
    return (
      <InlineBanner
        tone="danger"
        role="alert"
        message="请先在「会话与高级」修正配置 JSON，再编辑沙箱开关、目录与能力。"
        action={<ActionButton label="前往 JSON" variant="outline" size="xs" onPress={onJumpToJson} />}
      />
    );
  }

  const sandboxOn = configDraft.sandboxEnabled;

  return (
    <View style={{ gap: 20 }} testID="qqbot-section-sandbox">
      <SectionCard
        title="QQ 沙箱与隔离"
        subtitle="切换沙箱或修改目录与能力后，点击上方「保存配置」生效；旧 Agent 将停止，Desktop 历史保留"
        trailing={<Badge label={sandboxOn ? '隔离开启' : '宿主模式'} tone={sandboxOn ? 'success' : 'danger'} />}
      >
        <SettingRow
          title="QQ 沙箱"
          hint="开启时仅可读写专用目录，禁用系统命令、宿主工具与外部 Skill（默认开启）"
        >
          <SwitchControl
            testID="qqbot-sandbox-toggle"
            accessibilityLabel="QQ 沙箱"
            value={sandboxOn}
            disabled={busy}
            onValueChange={next => applyDraft(() => editSandboxEnabled(configText, next))}
          />
        </SettingRow>

        {!sandboxOn ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <InlineBanner
              tone="danger"
              message="沙箱已关闭：获准 QQ 用户可使用普通宿主 Agent 工具并访问目录外数据（仍需 ask 审批）。建议先将私聊和群聊限制为「仅名单」。"
            />
          </View>
        ) : null}

        <View style={{ paddingHorizontal: 16, paddingVertical: 13, borderTopWidth: 1, borderTopColor: p.border }}>
          <TextField
            label="专用目录（沙箱路径）"
            accessibilityLabel="QQ 沙箱路径"
            placeholder="留空使用此安装实例的专用私有目录"
            hint="支持绝对路径或 ~/路径；不可使用主目录、根目录或符号链接。附件与投递文件始终隔离于此目录。"
            value={sandboxPathInput}
            editable={!busy}
            mono
            autoCapitalize="none"
            autoCorrect={false}
            onFocus={() => setSandboxPathFocused(true)}
            onBlur={() => {
              setSandboxPathFocused(false);
              setSandboxPathInput(configDraft.sandboxPath);
            }}
            onChangeText={value => {
              setSandboxPathInput(value);
              applyDraft(() => editSandboxPath(configText, value));
            }}
          />
        </View>

        <SettingRow
          title="JavaScript 执行"
          hint="在隔离的 QuickJS 沙箱中执行脚本（无 Node 全局对象与宿主导入）"
          badge={!sandboxOn ? <Badge label="仅沙箱模式生效" tone="neutral" /> : undefined}
          bordered
        >
          <SwitchControl
            testID="qqbot-cap-javascript"
            accessibilityLabel="沙箱 JavaScript 执行"
            value={configDraft.sandboxCapabilities.javascript}
            disabled={busy}
            onValueChange={next => applyDraft(() => editSandboxCapability(configText, 'javascript', next))}
          />
        </SettingRow>

        <SettingRow
          title="公网请求"
          hint="允许访问公网 URL；仍禁止私网、localhost、云元数据与宿主凭据"
          badge={!sandboxOn ? <Badge label="仅沙箱模式生效" tone="neutral" /> : undefined}
          bordered
        >
          <SwitchControl
            testID="qqbot-cap-network"
            accessibilityLabel="沙箱公网请求"
            value={configDraft.sandboxCapabilities.network}
            disabled={busy}
            onValueChange={next => applyDraft(() => editSandboxCapability(configText, 'network', next))}
          />
        </SettingRow>

        <SettingRow
          title="主机生图"
          hint="使用 Desktop 已配置的生图模型与凭据生成图片，产物自动发回当前 QQ 对话"
          bordered
        >
          <SwitchControl
            testID="qqbot-cap-image"
            accessibilityLabel="主机生图"
            value={configDraft.sandboxCapabilities.imageGeneration}
            disabled={busy}
            onValueChange={next =>
              applyDraft(() => editSandboxCapability(configText, 'imageGeneration', next))
            }
          />
        </SettingRow>
      </SectionCard>

      <SectionCard
        title="宿主游戏"
        subtitle="加载受信任的外部独立引擎；切换开关会新建对话，旧历史与存档均保留"
        trailing={<Badge label={configDraft.game.enabled ? '已开启' : '已关闭'} tone={configDraft.game.enabled ? 'accent' : 'neutral'} />}
      >
        <SettingRow
          title="启用宿主游戏"
          hint="游戏指令、规则与场景由外部引擎提供，与沙箱目录隔离"
        >
          <SwitchControl
            testID="qqbot-game-toggle"
            accessibilityLabel="启用宿主游戏"
            value={configDraft.game.enabled}
            disabled={busy}
            onValueChange={next => applyDraft(() => editGameEnabled(configText, next))}
          />
        </SettingRow>

        <View style={{ paddingHorizontal: 16, paddingVertical: 13, borderTopWidth: 1, borderTopColor: p.border }}>
          <TextField
            label="引擎目录"
            accessibilityLabel="宿主游戏引擎目录"
            placeholder="~/.omp/qqbot-games"
            hint="填写 QQ 沙箱之外的绝对路径或 ~/路径；留空恢复默认 ~/.omp/qqbot-games。"
            value={engineDirInput}
            editable={!busy}
            mono
            autoCapitalize="none"
            autoCorrect={false}
            onFocus={() => setEngineDirFocused(true)}
            onBlur={() => {
              setEngineDirFocused(false);
              const trimmed = engineDirInput.trim();
              if (!trimmed) {
                applyDraft(() => editGameEngineDirectory(configText, ''));
                setEngineDirInput('~/.omp/qqbot-games');
              } else {
                setEngineDirInput(configDraft.game.engineDirectory);
              }
            }}
            onChangeText={value => {
              setEngineDirInput(value);
              if (value.trim()) {
                applyDraft(() => editGameEngineDirectory(configText, value));
              }
            }}
          />
        </View>
      </SectionCard>
    </View>
  );
}
