import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, Download, Pencil, Plus, QrCode, Trash2, X } from 'lucide-react-native';
import type { z } from 'zod';
import { listKey, type AccessSchema } from '../state.ts';
import type { StatusSchema } from '../rpc.ts';
import type { PairPurpose } from '../shared/pairing-protocol.ts';
import {
  ActionButton,
  Badge,
  InlineBanner,
  SectionCard,
  SegmentedControl,
  SettingRow,
  TextField,
  usePalette,
} from './primitives.tsx';

type AccessState = z.infer<typeof AccessSchema>;
type StatusSnapshot = z.infer<typeof StatusSchema>;

const ACCESS_MODE_OPTIONS = [
  { value: 'open', label: '所有人' },
  { value: 'allowlist', label: '仅名单' },
  { value: 'disabled', label: '关闭' },
] as const;

export function AccessSection({
  mode,
  access,
  challenges,
  busy,
  compact,
  purpose,
  entries,
  exportText,
  onChangePurpose,
  onChangeEntries,
  onClearExport,
  onChangeAccessMode,
  onManualAdd,
  onIssuePair,
  onEndPair,
  onExportList,
  onRevokeMember,
  onRenameMember,
}: {
  mode: 'manage' | 'active';
  access: AccessState;
  challenges: StatusSnapshot['challenges'];
  busy: boolean;
  compact: boolean;
  purpose: PairPurpose;
  entries: string;
  exportText: string;
  onChangePurpose: (next: PairPurpose) => void;
  onChangeEntries: (next: string) => void;
  onClearExport: () => void;
  onChangeAccessMode: (field: 'c2cMode' | 'groupMode' | 'commandMode', mode: 'open' | 'allowlist' | 'disabled') => void;
  onManualAdd: () => void;
  onIssuePair: () => void;
  onEndPair: (code: string) => void;
  onExportList: () => void;
  onRevokeMember: (openid: string) => void;
  onRenameMember: (openid: string, nickname: string) => void;
}) {
  const p = usePalette();
  const [manualOpen, setManualOpen] = useState(false);
  const [editingOpenid, setEditingOpenid] = useState<string | null>(null);
  const [editingNickname, setEditingNickname] = useState('');

  const members = access[listKey(purpose)];
  const activeChallenges = challenges.filter(ch => ch.purpose === purpose);

  return (
    <View style={{ gap: 20 }} testID="qqbot-section-access">
      <SectionCard
        title="访问策略"
        subtitle="控制谁可以与机器人对话以及使用管理斜杠命令"
        trailing={<Badge label={`修订 v${access.revision}`} mono />}
      >
        <SettingRow
          title="私聊消息"
          hint="允许私聊与机器人对话的范围"
          stacked={compact}
        >
          <SegmentedControl
            value={access.c2cMode}
            disabled={busy}
            options={ACCESS_MODE_OPTIONS}
            onChange={next => onChangeAccessMode('c2cMode', next)}
            testID="qqbot-access-c2c"
          />
        </SettingRow>

        <SettingRow
          title="群聊消息"
          hint="允许在群内触发机器人的范围"
          bordered
          stacked={compact}
        >
          <SegmentedControl
            value={access.groupMode}
            disabled={busy}
            options={ACCESS_MODE_OPTIONS}
            onChange={next => onChangeAccessMode('groupMode', next)}
            testID="qqbot-access-group"
          />
        </SettingRow>

        <SettingRow
          title="管理命令"
          hint="控制 /model、/preset、/new、/compact 等管理指令与权限审批"
          bordered
          stacked={compact}
        >
          <SegmentedControl
            value={access.commandMode}
            disabled={busy}
            options={ACCESS_MODE_OPTIONS}
            onChange={next => onChangeAccessMode('commandMode', next)}
            testID="qqbot-access-command"
          />
        </SettingRow>
      </SectionCard>

      <SectionCard
        title="白名单与配对"
        subtitle="通过限时配对码或 OpenID 维护允许访问的私聊、群与管理员"
      >
        <View style={{ paddingHorizontal: 16, paddingVertical: 13, gap: 12 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
            }}
          >
            <SegmentedControl
              value={purpose}
              onChange={next => {
                onChangePurpose(next);
                setEditingOpenid(null);
              }}
              options={[
                { value: 'allow-c2c', label: '私聊名单', badge: access.allowC2c.length },
                { value: 'allow-group', label: '群名单', badge: access.allowGroup.length },
                { value: 'owner', label: '管理员名单', badge: access.owners.length },
              ]}
              testID="qqbot-whitelist-tabs"
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {mode === 'active' ? (
                <ActionButton
                  icon={QrCode}
                  label="生成配对码"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onPress={onIssuePair}
                  testID="qqbot-generate-pair"
                />
              ) : null}
              <ActionButton
                icon={Plus}
                label={manualOpen ? '收起添加' : '手动添加'}
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => setManualOpen(v => !v)}
                testID="qqbot-manual-toggle"
              />
              <ActionButton
                icon={Download}
                label="导出名单"
                variant="outline"
                size="sm"
                disabled={busy}
                onPress={onExportList}
                testID="qqbot-export-list"
              />
            </View>
          </View>

          {mode === 'manage' ? (
            <InlineBanner
              tone="info"
              message="插件未运行时不可生成配对码，但仍可手动添加、重命名、撤销或导出名单。"
            />
          ) : null}

          {purpose === 'owner' ? (
            <InlineBanner
              tone="info"
              message="管理员审批校验精确身份；群内配对绑定本群 member_openid，不可用昵称或私聊身份替代。"
            />
          ) : null}

          {activeChallenges.map(challenge => (
            <View
              key={challenge.code}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                padding: 13,
                borderRadius: 8,
                backgroundColor: p.surface2,
                borderWidth: 1,
                borderColor: p.accent,
              }}
            >
              <View style={{ gap: 3 }}>
                <Text
                  selectable
                  style={{
                    fontSize: 20,
                    fontWeight: '700',
                    letterSpacing: 3,
                    fontFamily: p.monoFont,
                    color: p.foreground,
                  }}
                >
                  {challenge.code}
                </Text>
                <Text style={{ fontSize: 12, color: p.foregroundMuted }}>
                  在目标 QQ 对话内发送该码 · {new Date(challenge.expiresAt).toLocaleTimeString()} 过期 · 已认领{' '}
                  {challenge.claims.length}
                </Text>
              </View>
              <ActionButton
                label="结束配对"
                variant="outline"
                size="sm"
                disabled={busy}
                onPress={() => onEndPair(challenge.code)}
              />
            </View>
          ))}

          {manualOpen || entries.length > 0 ? (
            <View
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor: p.surface2,
                borderWidth: 1,
                borderColor: p.border,
                gap: 10,
              }}
            >
              <TextField
                label="批量添加或更新昵称"
                accessibilityLabel="OpenID 与昵称名单"
                multiline
                placeholder="每行一条，格式：OpenID:昵称（可省略昵称）"
                value={entries}
                editable={!busy}
                mono
                onChangeText={onChangeEntries}
                style={{ minHeight: 72 }}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <ActionButton
                  label="添加／修改昵称"
                  variant="primary"
                  size="sm"
                  disabled={busy || !entries.trim()}
                  onPress={onManualAdd}
                  testID="qqbot-manual-submit"
                />
                {entries ? (
                  <ActionButton
                    label="清空"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => onChangeEntries('')}
                  />
                ) : null}
              </View>
            </View>
          ) : null}

          {exportText ? (
            <View
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor: p.surface2,
                borderWidth: 1,
                borderColor: p.border,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: p.foregroundMuted }}>导出的名单</Text>
                <ActionButton icon={X} variant="ghost" size="xs" accessibilityLabel="关闭导出" onPress={onClearExport} />
              </View>
              <TextField
                accessibilityLabel="导出的名单"
                multiline
                editable={false}
                mono
                value={exportText}
                style={{ minHeight: 72 }}
              />
            </View>
          ) : null}
        </View>

        {members.length === 0 ? (
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 18,
              borderTopWidth: 1,
              borderTopColor: p.border,
              alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 13, color: p.foregroundMuted }}>
              当前名单为空，点击「生成配对码」或「手动添加」录入成员。
            </Text>
          </View>
        ) : (
          members.map(member => {
            const memberKey = JSON.stringify([member.scene, member.groupOpenid, member.openid]);
            const isEditing = editingOpenid === memberKey;
            return (
              <View
                key={memberKey}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: 1,
                  borderTopColor: p.border,
                  gap: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={{ fontSize: 14, fontWeight: '500', color: p.foreground }}>
                        {member.nickname || member.sceneName || '未命名'}
                      </Text>
                      <Badge label={member.scene === 'group' ? '群聊' : '私聊'} tone="neutral" />
                      {member.groupOpenid ? <Badge label={`群 ${member.groupOpenid.slice(-6)}`} mono /> : null}
                    </View>
                    <Text
                      selectable
                      numberOfLines={1}
                      style={{ fontSize: 12, fontFamily: p.monoFont, color: p.foregroundMuted }}
                    >
                      {member.openid}
                    </Text>
                  </View>

                  {!isEditing ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <ActionButton
                        icon={Pencil}
                        variant="ghost"
                        size="xs"
                        accessibilityLabel={`修改 ${member.nickname || member.openid} 昵称`}
                        disabled={busy}
                        onPress={() => {
                          setEditingOpenid(memberKey);
                          setEditingNickname(member.nickname);
                        }}
                      />
                      <ActionButton
                        icon={Trash2}
                        label="撤销"
                        variant="dangerOutline"
                        size="xs"
                        disabled={busy}
                        onPress={() => onRevokeMember(member.openid)}
                      />
                    </View>
                  ) : null}
                </View>

                {isEditing ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <TextField
                        accessibilityLabel="修改成员昵称"
                        placeholder="输入新昵称"
                        value={editingNickname}
                        onChangeText={setEditingNickname}
                        compact
                      />
                    </View>
                    <ActionButton
                      icon={Check}
                      label="保存"
                      variant="primary"
                      size="xs"
                      disabled={busy}
                      onPress={() => {
                        onRenameMember(member.openid, editingNickname);
                        setEditingOpenid(null);
                      }}
                    />
                    <ActionButton
                      icon={X}
                      variant="ghost"
                      size="xs"
                      accessibilityLabel="取消重命名"
                      onPress={() => setEditingOpenid(null)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </SectionCard>
    </View>
  );
}
