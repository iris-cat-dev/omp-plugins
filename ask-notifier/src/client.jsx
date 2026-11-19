import React from 'react';
import { ReminderPage } from './page.jsx';
import { status, configure, testReminder } from './rpc.mjs';

export default function setup(context) {
  const api = Object.freeze({
    read: () => context.rpc(status, {}),
    configure: changes => context.rpc(configure, changes),
    test: () => context.rpc(testReminder, {})
  });
  function Page({ theme }) { return <ReminderPage api={api} theme={theme} />; }
  context.addSettingsPage({ id: 'wechat-ask-notifier.settings', title: 'OMP 询问提醒', icon: 'bell-ring', Component: Page });
  context.addCommandCenterItem({
    id: 'wechat-ask-notifier.open', title: '打开 OMP 询问提醒', icon: 'bell-ring',
    keywords: ['OMP', 'QQ', '手机', 'Pad', '提醒', '问题', '待确认', '审批'], context: 'global',
    onSelect: command => command.openSurface('wechat-ask-notifier.settings-surface')
  });
  context.addSurface('wechat-ask-notifier.settings-surface', Page);
}
