import React, { useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import { ExternalLink, QrCode, RefreshCw, Unlink } from 'lucide-react-native';
import type { z } from 'zod';
import type { StatusSchema } from '../rpc.ts';
import {
  ActionButton,
  Badge,
  InlineBanner,
  SectionCard,
  SettingRow,
  TextField,
  usePalette,
} from './primitives.tsx';

type StatusSnapshot = z.infer<typeof StatusSchema>;

export function AccountSection({
  mode,
  snapshot,
  appId,
  secret,
  busy,
  onChangeAppId,
  onChangeSecret,
  onSaveAccount,
  onBind,
  onRefreshQr,
  onUnbind,
}: {
  mode: 'manage' | 'active';
  snapshot: StatusSnapshot | null;
  appId: string;
  secret: string;
  busy: boolean;
  onChangeAppId: (value: string) => void;
  onChangeSecret: (value: string) => void;
  onSaveAccount: () => void;
  onBind: () => void;
  onRefreshQr: () => void;
  onUnbind: () => void;
}) {
  const p = usePalette();
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const binding = snapshot?.binding;
  const showBindingCard = Boolean(
    binding && (binding.phase !== 'idle' || binding.qrSvg || binding.url),
  );
  const boundAppId = snapshot?.appId || '';

  return (
    <View style={{ gap: 20 }} testID="qqbot-section-account">
      <SectionCard
        title="机器人账号"
        subtitle="配置 QQ 机器人 AppID 与 AppSecret，或使用官方扫码绑定"
        trailing={
          boundAppId ? (
            <Badge
              label={snapshot?.secretConfigured ? '凭据已配置' : '缺少 AppSecret'}
              tone={snapshot?.secretConfigured ? 'success' : 'warning'}
            />
          ) : (
            <Badge label="未绑定" tone="warning" />
          )
        }
      >
        <SettingRow
          title="当前绑定"
          hint={boundAppId ? `AppID：${boundAppId}` : '尚未绑定 QQ 机器人账号'}
        >
          {boundAppId ? <Badge label={boundAppId} mono /> : <Badge label="未绑定" tone="neutral" />}
        </SettingRow>

        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 14,
            gap: 12,
            borderTopWidth: 1,
            borderTopColor: p.border,
          }}
        >
          <TextField
            label="AppID"
            accessibilityLabel="QQ AppID"
            placeholder="输入机器人 AppID"
            value={appId}
            editable={!busy}
            mono
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onChangeAppId}
          />
          <TextField
            label="AppSecret"
            accessibilityLabel="QQ AppSecret"
            placeholder={
              snapshot?.secretConfigured
                ? 'AppSecret 已保存；留空保持不变，输入新值可替换'
                : '输入 AppSecret（仅写入 daemon secret 存储）'
            }
            value={secret}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onChangeSecret}
          />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
            <ActionButton
              label="保存／替换账号"
              variant="primary"
              size="md"
              disabled={busy || !appId.trim()}
              onPress={onSaveAccount}
              testID="qqbot-save-account"
            />
            <ActionButton
              icon={QrCode}
              label="扫码绑定"
              variant="secondary"
              size="md"
              disabled={busy}
              onPress={onBind}
              testID="qqbot-scan-bind"
            />
            {boundAppId && !confirmUnbind ? (
              <ActionButton
                icon={Unlink}
                label="解绑"
                variant="dangerOutline"
                size="md"
                disabled={busy}
                onPress={() => setConfirmUnbind(true)}
                testID="qqbot-unbind-trigger"
              />
            ) : null}
          </View>

          {confirmUnbind ? (
            <InlineBanner
              tone="danger"
              message={`确认解绑当前账号（${boundAppId}）？将清除当前账号密钥并停止 QQ 网关；历史记录保留。`}
              action={
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <ActionButton
                    label="取消"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onPress={() => setConfirmUnbind(false)}
                  />
                  <ActionButton
                    label="确认解绑"
                    variant="danger"
                    size="xs"
                    disabled={busy}
                    onPress={() => {
                      setConfirmUnbind(false);
                      onUnbind();
                    }}
                    testID="qqbot-unbind-confirm"
                  />
                </View>
              }
            />
          ) : null}

          {mode === 'manage' ? (
            <InlineBanner
              tone="info"
              message="当前插件处于管理模式：可维护 AppID、凭据与名单；扫码轮询与在线连接需启用插件。"
            />
          ) : null}
        </View>
      </SectionCard>

      {showBindingCard && binding ? (
        <SectionCard
          title="扫码绑定"
          subtitle="使用手机 QQ 扫描二维码完成官方机器人授权"
          trailing={
            <ActionButton
              icon={RefreshCw}
              label="刷新二维码"
              variant="outline"
              size="xs"
              disabled={busy}
              onPress={onRefreshQr}
              testID="qqbot-refresh-qr"
            />
          }
        >
          <View style={{ padding: 16, gap: 14, alignItems: 'flex-start' }}>
            {binding.qrSvg ? (
              <View
                style={{
                  padding: 12,
                  borderRadius: 10,
                  backgroundColor: '#ffffff',
                  borderWidth: 1,
                  borderColor: p.border,
                }}
              >
                <Image
                  accessibilityLabel="QQ 绑定二维码"
                  source={{ uri: binding.qrSvg }}
                  style={{ width: 200, height: 200 }}
                />
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: p.foregroundMuted }}>
                {binding.phase === 'starting'
                  ? '正在向腾讯开放平台请求绑定二维码…'
                  : binding.phase === 'saving'
                    ? '已扫码确认，正在保存凭据…'
                    : '等待扫码确认…'}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {binding.url ? (
                <ActionButton
                  icon={ExternalLink}
                  label="打开绑定链接"
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    void Linking.openURL(binding.url!);
                  }}
                />
              ) : null}
            </View>

            {binding.phase === 'failed' && binding.reason ? (
              <InlineBanner tone="danger" role="alert" message={binding.reason} />
            ) : null}
          </View>
        </SectionCard>
      ) : null}
    </View>
  );
}
