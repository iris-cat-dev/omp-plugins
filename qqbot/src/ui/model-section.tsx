import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  Brain,
  Check,
  Cpu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react-native';
import type { Config } from '../state.ts';
import {
  addPresetToDraft,
  deletePresetFromDraft,
  editConfigDraft,
  getPreset,
  parseProviderModelSelection,
  renamePresetInDraft,
  setDefaultPresetInDraft,
  setPresetProviderModelInDraft,
  setPresetQqPromptInDraft,
  setPresetSystemPromptInDraft,
  setPresetThinkingInDraft,
} from '../shared/config-draft.ts';
import {
  ActionButton,
  Badge,
  CollapsibleRow,
  InlineBanner,
  ModalSheet,
  NumberSettingRow,
  SectionCard,
  SegmentedControl,
  SettingRow,
  SwitchControl,
  TextField,
  usePalette,
} from './primitives.tsx';
import {
  findProviderModel,
  formatThinkingLabel,
  resolveThinkingOptions,
  selectableModels,
  selectableProviderEntries,
  type HostProvidersState,
} from './providers.ts';

export function ModelAndChatSection({
  configDraft,
  configText,
  busy,
  compact,
  providers,
  onUpdateConfigText,
  onReportError,
  onJumpToJson,
}: {
  configDraft: Config | null;
  configText: string;
  busy: boolean;
  compact: boolean;
  providers: HostProvidersState;
  onUpdateConfigText: (nextText: string) => void;
  onReportError: (message: string) => void;
  onJumpToJson: () => void;
}) {
  const p = usePalette();
  const [selectedPresetName, setSelectedPresetName] = useState<string>(configDraft?.defaultPreset ?? 'default');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [presetMode, setPresetMode] = useState<'none' | 'create' | 'rename'>('none');
  const [presetNameInput, setPresetNameInput] = useState('');
  const [globalPromptsOpen, setGlobalPromptsOpen] = useState(false);
  const [moreParamsOpen, setMoreParamsOpen] = useState(false);
  const [manualProviderInput, setManualProviderInput] = useState('omp');
  const [manualProviderFocused, setManualProviderFocused] = useState(false);
  const [manualModelInput, setManualModelInput] = useState('');
  const [manualModelFocused, setManualModelFocused] = useState(false);

  useEffect(() => {
    if (!configDraft) return;
    if (!configDraft.presets.some(item => item.name === selectedPresetName)) {
      setSelectedPresetName(configDraft.defaultPreset);
    }
  }, [configDraft, selectedPresetName]);

  const currentPresetSelection = useMemo(() => {
    if (!configDraft) return { provider: 'omp', model: '' };
    return parseProviderModelSelection(getPreset(configDraft, selectedPresetName).config.provider);
  }, [configDraft, selectedPresetName]);

  useEffect(() => {
    if (!manualProviderFocused) setManualProviderInput(currentPresetSelection.provider);
  }, [currentPresetSelection.provider, manualProviderFocused]);

  useEffect(() => {
    if (!manualModelFocused) setManualModelInput(currentPresetSelection.model);
  }, [currentPresetSelection.model, manualModelFocused]);

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
        message="当前配置 JSON 存在语法或校验错误，请先在「会话与高级」中修复后再编辑模型与对话参数。"
        action={<ActionButton label="前往 JSON" variant="outline" size="xs" onPress={onJumpToJson} />}
      />
    );
  }

  const preset = getPreset(configDraft, selectedPresetName);
  const isDefaultPreset = preset.name === configDraft.defaultPreset;
  const { provider: providerId, model: modelId } = parseProviderModelSelection(preset.config.provider);
  const providerEntries = useMemo(() => selectableProviderEntries(providers.entries), [providers.entries]);
  const liveProvider = providerEntries.find(item => item.provider === providerId);
  const liveModel = findProviderModel(providerEntries, providerId, modelId);
  const providerLabel = liveProvider?.label ?? providerId;
  const modelDisplayLabel = modelId
    ? liveModel?.label
      ? `${providerLabel} · ${liveModel.label}`
      : `${providerId}/${modelId}`
    : `${providerLabel} · 默认模型`;

  const sandboxProviderWarning = configDraft.sandboxEnabled && providerId !== 'omp';
  const { options: thinkingOptions, source: thinkingSource } = useMemo(
    () => resolveThinkingOptions(providerEntries, providerId, modelId, preset.config.thinkingOptionId),
    [providerEntries, providerId, modelId, preset.config.thinkingOptionId],
  );
  const currentThinking = preset.config.thinkingOptionId ?? '';

  const filteredProviders = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return providerEntries.map(entry => {
      const models = selectableModels(entry.models);
      const label = entry.label ?? entry.provider;
      const filteredModels = query
        ? models.filter(model =>
            `${label} ${entry.provider} ${model.label} ${model.id} ${model.description ?? ''}`
              .toLowerCase()
              .includes(query),
          )
        : models;
      const showDefaultRow =
        !query || `${label} ${entry.provider} 默认 default`.toLowerCase().includes(query);
      return {
        entry,
        label,
        models: filteredModels,
        showDefaultRow,
        blockedBySandbox: configDraft.sandboxEnabled && entry.provider !== 'omp',
      };
    });
  }, [providerEntries, pickerQuery, configDraft.sandboxEnabled]);

  const handleSelectModel = (nextProvider: string, nextModel: string) => {
    applyDraft(() => {
      let updated = setPresetProviderModelInDraft(configText, preset.name, nextProvider, nextModel);
      const chosenModel = findProviderModel(providerEntries, nextProvider, nextModel);
      if (chosenModel && preset.config.thinkingOptionId) {
        const supported = chosenModel.thinkingOptions?.some(opt => opt.id === preset.config.thinkingOptionId);
        if (!supported) {
          updated = setPresetThinkingInDraft(updated, preset.name, '');
        }
      }
      return updated;
    });
    setPickerOpen(false);
  };

  const handleCreatePreset = () => {
    const targetName = presetNameInput.trim();
    if (!targetName) return;
    applyDraft(() => addPresetToDraft(configText, targetName, preset.name));
    setSelectedPresetName(targetName);
    setPresetNameInput('');
    setPresetMode('none');
  };

  const handleRenamePreset = () => {
    const targetName = presetNameInput.trim();
    if (!targetName) return;
    applyDraft(() => renamePresetInDraft(configText, preset.name, targetName));
    setSelectedPresetName(targetName);
    setPresetNameInput('');
    setPresetMode('none');
  };

  const handleDeletePreset = () => {
    const remaining = configDraft.presets.find(item => item.name !== preset.name);
    applyDraft(() => deletePresetFromDraft(configText, preset.name));
    if (remaining) setSelectedPresetName(remaining.name);
  };

  return (
    <View style={{ gap: 20 }} testID="qqbot-section-model">
      <SectionCard
        title="模型与 Preset"
        subtitle="新对话（/new 或 /reset）使用默认 Preset；对话中可通过 /model 或 /preset 临时切换"
        trailing={
          providers.mode === 'active' ? (
            <ActionButton
              icon={RefreshCw}
              label={providers.loading ? '加载中…' : '刷新模型'}
              variant="ghost"
              size="xs"
              disabled={busy || providers.loading}
              onPress={providers.refresh}
              testID="qqbot-refresh-models"
            />
          ) : null
        }
      >
        <View style={{ paddingHorizontal: 16, paddingVertical: 13, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: p.foregroundMuted }}>Preset 模板</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {!isDefaultPreset ? (
                <ActionButton
                  label="设为默认"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onPress={() => applyDraft(() => setDefaultPresetInDraft(configText, preset.name))}
                  testID="qqbot-preset-set-default"
                />
              ) : null}
              <ActionButton
                icon={Plus}
                label="新建"
                variant="outline"
                size="xs"
                disabled={busy}
                onPress={() => {
                  setPresetMode(presetMode === 'create' ? 'none' : 'create');
                  setPresetNameInput('');
                }}
                testID="qqbot-preset-add"
              />
              <ActionButton
                icon={Pencil}
                label="重命名"
                variant="ghost"
                size="xs"
                disabled={busy}
                onPress={() => {
                  setPresetMode(presetMode === 'rename' ? 'none' : 'rename');
                  setPresetNameInput(preset.name);
                }}
                testID="qqbot-preset-rename"
              />
              {configDraft.presets.length > 1 ? (
                <ActionButton
                  icon={Trash2}
                  variant="dangerOutline"
                  size="xs"
                  accessibilityLabel="删除当前 Preset"
                  disabled={busy}
                  onPress={handleDeletePreset}
                  testID="qqbot-preset-delete"
                />
              ) : null}
            </View>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {configDraft.presets.map(item => {
              const active = item.name === preset.name;
              const isDef = item.name === configDraft.defaultPreset;
              return (
                <Pressable
                  key={item.name}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setSelectedPresetName(item.name);
                    setPresetMode('none');
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 11,
                    paddingVertical: 6,
                    borderRadius: 7,
                    borderWidth: 1,
                    borderColor: active ? p.accent : p.borderAccent,
                    backgroundColor: active ? p.surface2 : p.surface0,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: active ? '600' : '400', color: p.foreground }}>
                    {item.name}
                  </Text>
                  {isDef ? <Badge label="默认" tone="accent" /> : null}
                </Pressable>
              );
            })}
          </View>

          {presetMode !== 'none' ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                padding: 10,
                borderRadius: 8,
                backgroundColor: p.surface2,
                borderWidth: 1,
                borderColor: p.border,
              }}
            >
              <View style={{ flex: 1 }}>
                <TextField
                  accessibilityLabel={presetMode === 'create' ? '新建 Preset 名称' : '重命名 Preset'}
                  placeholder={presetMode === 'create' ? '输入新 Preset 名称（如 coding）' : '输入新名称'}
                  value={presetNameInput}
                  onChangeText={setPresetNameInput}
                  compact
                  autoCapitalize="none"
                />
              </View>
              <ActionButton
                icon={Check}
                label={presetMode === 'create' ? '创建' : '保存'}
                variant="primary"
                size="sm"
                disabled={busy || !presetNameInput.trim()}
                onPress={presetMode === 'create' ? handleCreatePreset : handleRenamePreset}
                testID="qqbot-preset-confirm"
              />
              <ActionButton
                icon={X}
                variant="ghost"
                size="sm"
                accessibilityLabel="取消"
                onPress={() => {
                  setPresetMode('none');
                  setPresetNameInput('');
                }}
              />
            </View>
          ) : null}
        </View>

        <SettingRow
          title="默认模型"
          hint={
            modelId
              ? liveModel?.description || `标识：${providerId}/${modelId}`
              : '未指定具体模型，将使用主机 Provider 默认模型'
          }
          badge={isDefaultPreset ? <Badge label="新对话生效" tone="neutral" /> : undefined}
          bordered
          stacked={compact}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {providers.mode === 'active' && providerEntries.length > 0 ? (
              <ActionButton
                icon={Cpu}
                label={modelDisplayLabel}
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => {
                  setPickerQuery('');
                  setPickerOpen(true);
                }}
                testID="qqbot-model-picker-trigger"
              />
            ) : null}
            <ActionButton
              label={
                providers.mode === 'active' && providerEntries.length > 0
                  ? manualModelOpen
                    ? '收起手动输入'
                    : '手动输入'
                  : manualModelOpen
                    ? '收起'
                    : modelDisplayLabel
              }
              variant={providers.mode === 'active' && providerEntries.length > 0 ? 'ghost' : 'secondary'}
              size="sm"
              disabled={busy}
              onPress={() => setManualModelOpen(v => !v)}
              testID="qqbot-model-manual-toggle"
            />
          </View>
        </SettingRow>

        {sandboxProviderWarning ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <InlineBanner
              tone="warning"
              message={`QQ 沙箱开启时仅支持 omp provider（当前为 ${providerId}）。请切换为 omp 模型或在「沙箱与扩展」关闭沙箱。`}
            />
          </View>
        ) : null}

        {providers.error ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <InlineBanner
              tone="warning"
              message={`读取主机模型列表失败：${providers.error}。你仍可手动填写 Provider 与模型 ID。`}
            />
          </View>
        ) : null}

        {providers.mode === 'manage' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <InlineBanner
              tone="info"
              message="插件未运行时无法读取主机实时模型目录，可直接手动填写 Provider 与模型 ID。"
            />
          </View>
        ) : null}

        {manualModelOpen || providers.mode !== 'active' || providerEntries.length === 0 ? (
          <View
            style={{
              paddingHorizontal: 16,
              paddingBottom: 14,
              gap: 10,
              flexDirection: compact ? 'column' : 'row',
            }}
          >
            <View style={{ flex: 1 }}>
              <TextField
                label="Provider"
                accessibilityLabel="Preset Provider"
                placeholder="omp"
                value={manualProviderInput}
                editable={!busy}
                mono
                compact
                autoCapitalize="none"
                autoCorrect={false}
                onFocus={() => setManualProviderFocused(true)}
                onBlur={() => {
                  setManualProviderFocused(false);
                  const next = manualProviderInput.trim() || 'omp';
                  setManualProviderInput(next);
                  if (next !== providerId) {
                    applyDraft(() => setPresetProviderModelInDraft(configText, preset.name, next, modelId));
                  }
                }}
                onChangeText={nextProvider => {
                  setManualProviderInput(nextProvider);
                  const trimmed = nextProvider.trim();
                  if (trimmed && !trimmed.includes('/')) {
                    applyDraft(() =>
                      setPresetProviderModelInDraft(configText, preset.name, trimmed, modelId),
                    );
                  }
                }}
              />
            </View>
            <View style={{ flex: 2 }}>
              <TextField
                label="模型 ID（留空则跟随 Provider 默认模型）"
                accessibilityLabel="Preset 模型 ID"
                placeholder="例如 anthropic/claude-sonnet-4-6"
                value={manualModelInput}
                editable={!busy}
                mono
                compact
                autoCapitalize="none"
                autoCorrect={false}
                onFocus={() => setManualModelFocused(true)}
                onBlur={() => {
                  setManualModelFocused(false);
                  setManualModelInput(modelId);
                }}
                onChangeText={nextModel => {
                  setManualModelInput(nextModel);
                  applyDraft(() =>
                    setPresetProviderModelInDraft(configText, preset.name, providerId, nextModel),
                  );
                }}
              />
            </View>
          </View>
        ) : null}

        <SettingRow
          title="思考强度 (Thinking)"
          hint={
            thinkingOptions.length === 0 && thinkingSource === 'model'
              ? '当前所选模型不支持思考强度调节'
              : '控制推理深度；留空为「跟随默认」'
          }
          bordered
          stacked
        >
          {thinkingOptions.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} testID="qqbot-thinking-options">
              {[{ id: '', label: '跟随默认' }, ...thinkingOptions.map(opt => ({ id: opt.id, label: formatThinkingLabel(opt) }))].map(
                option => {
                  const selected = currentThinking === option.id;
                  return (
                    <Pressable
                      key={option.id || '__default__'}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: busy }}
                      disabled={busy}
                      onPress={() =>
                        applyDraft(() => setPresetThinkingInDraft(configText, preset.name, option.id))
                      }
                      style={{
                        paddingHorizontal: 11,
                        paddingVertical: 6,
                        borderRadius: 7,
                        borderWidth: 1,
                        borderColor: selected ? p.accent : p.borderAccent,
                        backgroundColor: selected ? p.surface2 : p.surface0,
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: selected ? '600' : '400',
                          color: selected ? p.foreground : p.foregroundMuted,
                        }}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                },
              )}
            </View>
          ) : (
            <Badge label="该模型无思考选项" tone="neutral" />
          )}
        </SettingRow>
      </SectionCard>

      <SectionCard
        title={`提示词（Preset：${preset.name}）`}
        subtitle="新对话自动附加，模式固定为 ask，不会绕过顶层沙箱限制"
      >
        <View style={{ padding: 16, gap: 14 }}>
          <TextField
            label="系统提示词 (systemPrompt)"
            accessibilityLabel="Preset 系统提示词"
            placeholder="可选：为该 Preset 指定系统级人设或工作原则"
            value={preset.config.systemPrompt ?? ''}
            editable={!busy}
            multiline
            onChangeText={value =>
              applyDraft(() => setPresetSystemPromptInDraft(configText, preset.name, value))
            }
          />
          <TextField
            label="QQ 对话附加提示词 (qq.prompt)"
            accessibilityLabel="Preset QQ 提示词"
            placeholder="可选：补充 QQ 聊天格式、称呼或回复风格"
            value={preset.qq.prompt}
            editable={!busy}
            multiline
            onChangeText={value => applyDraft(() => setPresetQqPromptInDraft(configText, preset.name, value))}
          />
        </View>
        <CollapsibleRow
          title="全局场景提示词"
          hint="分别应用于所有私聊或群聊会话"
          badge={
            configDraft.directPrompt || configDraft.groupPrompt ? <Badge label="已配置" tone="accent" /> : undefined
          }
          open={globalPromptsOpen}
          onToggle={() => setGlobalPromptsOpen(v => !v)}
          bordered
          testID="qqbot-global-prompts-toggle"
        >
          <View style={{ padding: 16, gap: 14 }}>
            <TextField
              label="私聊全局提示词 (directPrompt)"
              accessibilityLabel="私聊全局提示词"
              placeholder="可选：仅私聊会话生效"
              value={configDraft.directPrompt}
              editable={!busy}
              multiline
              onChangeText={value =>
                applyDraft(() => editConfigDraft(configText, config => ({ ...config, directPrompt: value })))
              }
            />
            <TextField
              label="群聊全局提示词 (groupPrompt)"
              accessibilityLabel="群聊全局提示词"
              placeholder="可选：仅群聊会话生效"
              value={configDraft.groupPrompt}
              editable={!busy}
              multiline
              onChangeText={value =>
                applyDraft(() => editConfigDraft(configText, config => ({ ...config, groupPrompt: value })))
              }
            />
          </View>
        </CollapsibleRow>
      </SectionCard>

      <SectionCard title="对话与消息参数" subtitle="常用行为参数；修改后点击上方「保存配置」生效">
        <SettingRow
          title="群聊需 @ 机器人"
          hint="开启后，群内消息必须 @ 机器人才会触发回复"
        >
          <SwitchControl
            accessibilityLabel="群聊需 @ 机器人"
            value={configDraft.requireMention}
            disabled={busy}
            onValueChange={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, requireMention: next })))
            }
            testID="qqbot-require-mention-switch"
          />
        </SettingRow>

        <SettingRow
          title="私聊流式回复"
          hint="私聊中边生成边更新消息；群聊保持整段缓冲发送"
          bordered
        >
          <SwitchControl
            accessibilityLabel="私聊流式回复"
            value={configDraft.streaming}
            disabled={busy}
            onValueChange={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, streaming: next })))
            }
            testID="qqbot-streaming-switch"
          />
        </SettingRow>

        <SettingRow
          title="显示工具完成通知"
          hint="工具执行成功后向 QQ 发送简短完成提示"
          bordered
        >
          <SwitchControl
            accessibilityLabel="显示工具完成通知"
            value={configDraft.showToolResults}
            disabled={busy}
            onValueChange={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, showToolResults: next })))
            }
            testID="qqbot-show-tools-switch"
          />
        </SettingRow>

        <SettingRow
          title="外部回合同步到 QQ"
          hint="在 Desktop 直接对 QQ 映射的 Agent 发消息时，是否把回复同步发到 QQ"
          bordered
          stacked={compact}
        >
          <SegmentedControl
            value={configDraft.externalTurns}
            disabled={busy}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'c2c', label: '仅私聊' },
              { value: 'all', label: '全部' },
            ]}
            onChange={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, externalTurns: next })))
            }
            testID="qqbot-external-turns"
          />
        </SettingRow>

        <SettingRow
          title="投递后台服务回合"
          hint="允许定时任务或子 Agent 触发的回复同步投递到对应 QQ 对话"
          bordered
        >
          <SwitchControl
            accessibilityLabel="投递后台服务回合"
            value={configDraft.serviceTurns}
            disabled={busy}
            onValueChange={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, serviceTurns: next })))
            }
          />
        </SettingRow>

        <NumberSettingRow
          title="群聊上下文条数"
          hint="附带在群消息前的近期群聊缓冲条数（0–100）"
          accessibilityLabel="群聊上下文条数"
          value={configDraft.historyLimit}
          min={0}
          max={100}
          unit="条"
          disabled={busy}
          onCommit={next =>
            applyDraft(() => editConfigDraft(configText, config => ({ ...config, historyLimit: next })))
          }
        />

        <NumberSettingRow
          title="自动压缩阈值"
          hint="上下文达到该 token 数时自动执行原生压缩（0 表示关闭）"
          accessibilityLabel="自动压缩阈值"
          value={configDraft.autoCompactTokens}
          min={0}
          max={2000000}
          unit="tok"
          disabled={busy}
          onCommit={next =>
            applyDraft(() => editConfigDraft(configText, config => ({ ...config, autoCompactTokens: next })))
          }
        />

        <CollapsibleRow
          title="更多消息、超时与媒体参数"
          hint="分片字数、队列上限、超时、视觉输入、附件缓存与文件投递"
          open={moreParamsOpen}
          onToggle={() => setMoreParamsOpen(v => !v)}
          bordered
          testID="qqbot-more-params-toggle"
        >
          <NumberSettingRow
            title="单条分片字数上限"
            hint="超长回复自动分段发送（200–4500）"
            accessibilityLabel="单条分片字数上限"
            value={configDraft.textChunkLimit}
            min={200}
            max={4500}
            unit="字"
            disabled={busy}
            bordered={false}
            onCommit={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, textChunkLimit: next })))
            }
          />
          <NumberSettingRow
            title="单会话最大队列"
            hint="同一会话同时排队等待处理的上限（1–100）"
            accessibilityLabel="单会话最大队列"
            value={configDraft.maxQueue}
            min={1}
            max={100}
            unit="条"
            disabled={busy}
            onCommit={next =>
              applyDraft(() => editConfigDraft(configText, config => ({ ...config, maxQueue: next })))
            }
          />
          <NumberSettingRow
            title="回合处理超时"
            hint="单轮 Agent 响应的最长等待时间（1–3600 秒）"
            accessibilityLabel="回合处理超时（秒）"
            value={Math.round(configDraft.processingTimeoutMs / 1000)}
            min={1}
            max={3600}
            unit="秒"
            disabled={busy}
            onCommit={seconds =>
              applyDraft(() =>
                editConfigDraft(configText, config => ({ ...config, processingTimeoutMs: seconds * 1000 })),
              )
            }
          />
          <NumberSettingRow
            title="审批与问答超时"
            hint="权限卡与交互问答的等待时间（1–3600 秒）"
            accessibilityLabel="审批与问答超时（秒）"
            value={Math.round(configDraft.askTimeoutMs / 1000)}
            min={1}
            max={3600}
            unit="秒"
            disabled={busy}
            onCommit={seconds =>
              applyDraft(() =>
                editConfigDraft(configText, config => ({ ...config, askTimeoutMs: seconds * 1000 })),
              )
            }
          />
          <SettingRow
            title="视觉图片输入"
            hint="下载 QQ 消息中的图片并作为视觉内容传给模型"
            bordered
          >
            <SwitchControl
              accessibilityLabel="视觉图片输入"
              value={configDraft.vision.enabled}
              disabled={busy}
              onValueChange={next =>
                applyDraft(() =>
                  editConfigDraft(configText, config => ({
                    ...config,
                    vision: { ...config.vision, enabled: next },
                  })),
                )
              }
            />
          </SettingRow>
          {configDraft.vision.enabled ? (
            <NumberSettingRow
              title="单张视觉图片上限"
              hint="超过该大小的图片不传入视觉输入（1–20 MB）"
              accessibilityLabel="单张视觉图片上限（MB）"
              value={Math.max(1, Math.round(configDraft.vision.maxBytes / (1024 * 1024)))}
              min={1}
              max={20}
              unit="MB"
              disabled={busy}
              onCommit={mb =>
                applyDraft(() =>
                  editConfigDraft(configText, config => ({
                    ...config,
                    vision: { ...config.vision, maxBytes: mb * 1024 * 1024 },
                  })),
                )
              }
            />
          ) : null}
          <SettingRow
            title="媒体附件下载"
            hint="将 QQ 附件下载到专用目录的 .qqbot-media 中"
            bordered
          >
            <SwitchControl
              accessibilityLabel="媒体附件下载"
              value={configDraft.media.enabled}
              disabled={busy}
              onValueChange={next =>
                applyDraft(() =>
                  editConfigDraft(configText, config => ({
                    ...config,
                    media: { ...config.media, enabled: next },
                  })),
                )
              }
            />
          </SettingRow>
          {configDraft.media.enabled ? (
            <>
              <NumberSettingRow
                title="媒体单文件上限"
                hint="允许下载的单个附件大小（1–200 MB）"
                accessibilityLabel="媒体单文件上限（MB）"
                value={configDraft.media.maxMB}
                min={1}
                max={200}
                unit="MB"
                disabled={busy}
                onCommit={maxMB =>
                  applyDraft(() =>
                    editConfigDraft(configText, config => ({
                      ...config,
                      media: { ...config.media, maxMB },
                    })),
                  )
                }
              />
              <NumberSettingRow
                title="媒体缓存保留时间"
                hint="到期自动清理下载与生成的媒体文件（0–720 小时）"
                accessibilityLabel="媒体缓存保留时间（小时）"
                value={configDraft.media.ttlHours}
                min={0}
                max={720}
                unit="小时"
                disabled={busy}
                onCommit={ttlHours =>
                  applyDraft(() =>
                    editConfigDraft(configText, config => ({
                      ...config,
                      media: { ...config.media, ttlHours },
                    })),
                  )
                }
              />
            </>
          ) : null}
          <SettingRow
            title="投递 Agent 展示的文件"
            hint="仅显式开启后，自动发送专用目录内被展示的文件"
            bordered
          >
            <SwitchControl
              accessibilityLabel="投递 Agent 展示的文件"
              value={configDraft.sendFile.sendPresentedFiles}
              disabled={busy}
              onValueChange={next =>
                applyDraft(() =>
                  editConfigDraft(configText, config => ({
                    ...config,
                    sendFile: { ...config.sendFile, sendPresentedFiles: next },
                  })),
                )
              }
            />
          </SettingRow>
          {configDraft.sendFile.sendPresentedFiles ? (
            <NumberSettingRow
              title="单轮最多投递文件数"
              hint="限制单次回复自动上传的文件数量（1–20）"
              accessibilityLabel="单轮最多投递文件数"
              value={configDraft.sendFile.maxFiles}
              min={1}
              max={20}
              unit="个"
              disabled={busy}
              onCommit={maxFiles =>
                applyDraft(() =>
                  editConfigDraft(configText, config => ({
                    ...config,
                    sendFile: { ...config.sendFile, maxFiles },
                  })),
                )
              }
            />
          ) : null}
        </CollapsibleRow>
      </SectionCard>

      {pickerOpen ? (
        <ModalSheet
          title={`选择模型 · Preset「${preset.name}」`}
          subtitle={configDraft.sandboxEnabled ? '沙箱已开启，仅可选择 OMP 模型' : '选择主机已配置的可用模型'}
          onClose={() => setPickerOpen(false)}
          testID="qqbot-model-picker-modal"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Search size={15} color={p.foregroundMuted} />
            <View style={{ flex: 1 }}>
              <TextField
                accessibilityLabel="搜索模型"
                placeholder="按模型名、ID 或说明搜索…"
                value={pickerQuery}
                onChangeText={setPickerQuery}
                compact
                autoFocus
              />
            </View>
          </View>

          {filteredProviders.map(({ entry, label, models, showDefaultRow, blockedBySandbox }) => {
            if (!showDefaultRow && models.length === 0) return null;
            return (
              <View key={entry.provider} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Sparkles size={13} color={p.foregroundMuted} />
                    <Text style={{ fontSize: 12, fontWeight: '600', color: p.foregroundMuted }}>
                      {label} ({entry.provider})
                    </Text>
                  </View>
                  {blockedBySandbox ? <Badge label="需先关闭沙箱" tone="warning" /> : null}
                </View>

                <View
                  style={{
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: p.border,
                    backgroundColor: p.surface0,
                    overflow: 'hidden',
                  }}
                >
                  {showDefaultRow ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={blockedBySandbox}
                      onPress={() => handleSelectModel(entry.provider, '')}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        backgroundColor:
                          providerId === entry.provider && !modelId ? p.surface2 : 'transparent',
                        opacity: blockedBySandbox ? 0.4 : pressed ? 0.75 : 1,
                      })}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: 13, fontWeight: '500', color: p.foreground }}>
                          使用 {label} 默认模型
                        </Text>
                        <Text style={{ fontSize: 11, color: p.foregroundMuted }}>
                          跟随宿主默认模型设置，不固定具体模型 ID
                        </Text>
                      </View>
                      {providerId === entry.provider && !modelId ? <Check size={15} color={p.accent} /> : null}
                    </Pressable>
                  ) : null}

                  {models.map((model, index) => {
                    const selected = providerId === entry.provider && modelId === model.id;
                    return (
                      <Pressable
                        key={model.id}
                        accessibilityRole="button"
                        disabled={blockedBySandbox}
                        onPress={() => handleSelectModel(entry.provider, model.id)}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          borderTopWidth: showDefaultRow || index > 0 ? 1 : 0,
                          borderTopColor: p.border,
                          backgroundColor: selected ? p.surface2 : 'transparent',
                          opacity: blockedBySandbox ? 0.4 : pressed ? 0.75 : 1,
                        })}
                      >
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text style={{ fontSize: 13, fontWeight: '500', color: p.foreground }}>
                              {model.label}
                            </Text>
                            {model.isDefault ? <Badge label="默认" tone="accent" /> : null}
                            {model.thinkingOptions?.length ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                                <Brain size={11} color={p.foregroundMuted} />
                                <Text style={{ fontSize: 11, color: p.foregroundMuted }}>思考</Text>
                              </View>
                            ) : null}
                          </View>
                          <Text
                            numberOfLines={1}
                            style={{ fontSize: 11, fontFamily: p.monoFont, color: p.foregroundMuted }}
                          >
                            {model.id}
                          </Text>
                          {model.description ? (
                            <Text numberOfLines={2} style={{ fontSize: 11, color: p.foregroundExtraMuted }}>
                              {model.description}
                            </Text>
                          ) : null}
                        </View>
                        {selected ? <Check size={15} color={p.accent} /> : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}

          {filteredProviders.every(group => !group.showDefaultRow && group.models.length === 0) ? (
            <Text style={{ fontSize: 13, color: p.foregroundMuted, textAlign: 'center', paddingVertical: 16 }}>
              未找到匹配的模型
            </Text>
          ) : null}
        </ModalSheet>
      ) : null}
    </View>
  );
}
