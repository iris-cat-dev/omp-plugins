import React, { useEffect, useRef, useState } from 'react';
import { BellRing, CheckCircle2, CirclePause, MessageSquare, RefreshCw, Send, WifiOff } from 'lucide-react';

const connectionLabels = { ready: '已登录', not_logged_in: '未登录', unsupported: '当前版本不支持', multiple_accounts: '检测到多个登录账号', not_installed: '未找到 QQ 安装', login_timeout: '等待 QQ 自动登录超时', error: '连接检查失败' };
const attemptLabels = { submitted: '已提交给 QQ', unknown: '发送结果未知', failed: '未能发送', error: '状态检查失败', not_logged_in: '未登录，已跳过', unsupported: '不支持，已跳过', multiple_accounts: '多个账号，已跳过', canceled: '事项已结束，未发送', skipped: '已跳过', partial: '部分已提交给 QQ', not_installed: '未找到 QQ', login_timeout: 'QQ 自动登录超时' };
const targetOptions = [{ value: 'phone', label: '仅手机' }, { value: 'pad', label: '仅 Pad' }, { value: 'both', label: '手机和 Pad' }];
const deviceLabels = { phone: '手机', pad: 'Pad' };
const time = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value);

export function ReminderPage({ api, theme }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useRef(false);
  const lock = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let reading = false;
    let disposed = false;
    const refresh = async () => {
      if (reading || lock.current) return;
      reading = true;
      const expectedRevision = revision.current;
      try {
        const next = await api.read();
        if (!disposed && !lock.current && expectedRevision === revision.current) {
          setState(next);
          setError(current => current?.operation === 'read' ? null : current);
        }
      } catch (failure) {
        if (!disposed && !lock.current && expectedRevision === revision.current) {
          setError(current => current && current.operation !== 'read' ? current : { operation: 'read', message: failure.message || '无法读取提醒状态。' });
        }
      } finally { reading = false; }
    };
    void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { disposed = true; mounted.current = false; clearInterval(interval); };
  }, [api]);
  async function run(operation, action) {
    if (lock.current) return;
    lock.current = true;
    revision.current += 1;
    setBusy(operation);
    setError(null);
    try { const next = await action(); if (mounted.current) setState(next); }
    catch (failure) { if (mounted.current) setError({ operation, message: failure.message || '操作失败。' }); }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  }
  const colors = theme.colors;
  const active = state?.mode === 'active';
  const connection = state?.connection;
  const lastAttempt = state?.lastAttempt;
  const targetResults = Object.entries(lastAttempt?.targets ?? {});
  const hasUnknown = lastAttempt?.state === 'unknown' || targetResults.some(([, result]) => result.state === 'unknown');
  const hasSubmitted = ['submitted', 'partial'].includes(lastAttempt?.state) || targetResults.some(([, result]) => ['submitted', 'partial'].includes(result.state));
  const settingsDisabled = !state || !active || Boolean(busy);
  const ConnectionIcon = !active || !state?.enabled ? CirclePause : connection?.state === 'ready' ? CheckCircle2 : WifiOff;
  return <main className="wn-page" style={{ '--wn-fg': colors.foreground, '--wn-muted': colors.foregroundMuted, '--wn-surface': colors.surface0, '--wn-accent': colors.accent, '--wn-danger': colors.statusDanger }}>
    <style>{`
      .wn-page{max-width:720px;margin:0 auto;padding:32px 24px 64px;color:var(--wn-fg);font-family:"Microsoft YaHei UI","PingFang SC",sans-serif;font-size:14px;line-height:1.6;overflow-wrap:anywhere}
      .wn-page *{box-sizing:border-box}.wn-page h1{font-size:26px;line-height:1.3;margin:0;font-weight:650;letter-spacing:-.02em}.wn-page h2{font-size:16px;margin:0 0 12px;font-weight:650}
      .wn-page p{margin:0}.wn-muted{color:var(--wn-muted)}.wn-title{display:flex;gap:12px;align-items:center;margin-bottom:12px}.wn-title svg{color:var(--wn-accent);flex:none}
      .wn-section{padding:24px 0;border-bottom:1px solid color-mix(in srgb,var(--wn-muted) 25%,transparent)}.wn-toggle{display:flex;justify-content:space-between;align-items:center;gap:24px;cursor:pointer}.wn-toggle strong{display:block;font-size:16px}.wn-toggle p{margin-top:4px}.wn-toggle input{width:20px;height:20px;flex:none;accent-color:var(--wn-accent);cursor:pointer}.wn-toggle input:disabled{cursor:not-allowed}
      .wn-devices{min-width:0;margin:0;padding:0;border:0}.wn-devices legend{padding:0;margin-bottom:12px;font-size:16px;font-weight:650}.wn-options{display:flex;gap:12px 24px;flex-wrap:wrap}.wn-option{display:inline-flex;align-items:center;gap:8px;min-height:40px;cursor:pointer}.wn-option input{width:18px;height:18px;margin:0;flex:none;accent-color:var(--wn-accent);cursor:pointer}.wn-devices:disabled .wn-option{opacity:.5;cursor:not-allowed}.wn-option input:disabled{cursor:not-allowed}.wn-feedback:not(:empty){margin-top:8px}.wn-device-note{margin-top:8px!important}
      .wn-state{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;font-weight:600}.wn-state svg{flex:none;margin-top:3px;color:var(--wn-accent)}.wn-meta{margin:12px 0 0;display:grid;gap:8px}.wn-meta div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:16px}.wn-meta dt{color:var(--wn-muted)}.wn-meta dd{min-width:0;margin:0}
      .wn-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.wn-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 16px;border:1px solid color-mix(in srgb,var(--wn-muted) 55%,transparent);border-radius:8px;color:var(--wn-fg);background:var(--wn-surface);font:inherit;cursor:pointer}.wn-button svg{flex:none}.wn-button:active:not(:disabled){transform:scale(.98)}.wn-button:disabled{opacity:.5;cursor:not-allowed}.wn-button:focus-visible,.wn-toggle input:focus-visible,.wn-option input:focus-visible{outline:2px solid var(--wn-accent);outline-offset:4px}
      @media(hover:hover){.wn-button:hover:not(:disabled){border-color:var(--wn-accent)}}.wn-primary{border-color:var(--wn-accent)}.wn-note{display:flex;gap:10px;align-items:flex-start}.wn-note svg{flex:none;margin-top:3px;color:var(--wn-muted)}.wn-error{color:var(--wn-danger);margin-top:16px!important}.wn-result-note{margin-top:8px!important}.wn-preview{margin:12px 0 0;padding:16px;border-left:3px solid var(--wn-accent);background:color-mix(in srgb,var(--wn-muted) 7%,transparent);white-space:pre-wrap;font:inherit;line-height:1.8}.wn-page ::selection{background:color-mix(in srgb,var(--wn-accent) 30%,transparent)}
      @media(max-width:520px){.wn-page{padding:24px 16px 48px}.wn-toggle{gap:16px}.wn-options{flex-direction:column;gap:4px}.wn-button{flex:1;min-width:0}.wn-actions{gap:8px}.wn-meta div{grid-template-columns:64px minmax(0,1fr);gap:12px}}
    `}</style>
    <header><div className="wn-title"><BellRing size={26} aria-hidden="true" /><h1>OMP 询问提醒</h1></div><p className="wn-muted">OMP 有问题、计划或权限等事项待你确认时，通过 QQ 提醒所选设备。</p></header>
    <section className="wn-section" aria-busy={busy === 'configure'}>
      <label className="wn-toggle"><span><strong>自动提醒</strong><p className="wn-muted">QQ 未登录时尝试临时自动登录；整批提醒提交后退出，原已登录的 QQ 保持打开。</p></span><input type="checkbox" aria-label="自动提醒" checked={state?.enabled ?? false} disabled={settingsDisabled} onChange={event => { const enabled = event.target.checked; void run('configure', () => api.configure({ enabled })); }} /></label>
      {state && !active && <p className="wn-muted" style={{ marginTop: 12 }}>当前为管理模式。请先在插件管理中启用本插件。</p>}
    </section>
    <section className="wn-section" aria-busy={busy === 'configure'}>
      <fieldset className="wn-devices" disabled={settingsDisabled} aria-describedby="wn-device-note">
        <legend>接收设备</legend>
        <div className="wn-options">{targetOptions.map(({ value, label }) => <label className="wn-option" key={value}><input type="radio" name="wn-target-mode" value={value} checked={state?.targetMode === value} onChange={() => void run('configure', () => api.configure({ targetMode: value }))} /><span>{label}</span></label>)}</div>
      </fieldset>
      <p className="wn-muted wn-device-note" id="wn-device-note">接收设备仅用于新提醒；测试提醒也使用当前已保存的选择。</p>
      <p className="wn-muted wn-feedback" role="status" aria-live="polite">{busy === 'configure' ? '正在保存设置…' : !state ? error ? '尚未读取接收设备。' : '正在读取已保存的接收设备…' : ''}</p>
    </section>
    <section className="wn-section" aria-labelledby="wn-connection">
      <h2 id="wn-connection">提醒状态</h2>
      <div className="wn-state" role="status"><ConnectionIcon size={18} aria-hidden="true" /><span>{!state ? error ? '尚未读取提醒状态' : '正在读取状态' : !active ? '管理模式，自动提醒未运行' : !state.enabled ? '自动提醒已关闭' : '自动提醒已开启'}</span></div>
      <dl className="wn-meta">
        <div><dt>QQ 连接</dt><dd>{connection ? connectionLabels[connection.state] ?? connection.state : state ? '尚未检查' : '尚未读取'}{connection?.reason && <p className="wn-muted">{connection.reason}</p>}{(connection?.accountId || connection?.version) && <p className="wn-muted">{[connection.accountId, connection.version].filter(Boolean).join(' · ')}</p>}</dd></div>
        {state && <div><dt>待你处理</dt><dd>{state.pendingCount} 项</dd></div>}
      </dl>
      <div className="wn-actions"><button className="wn-button wn-primary" disabled={!state?.enabled || !active || Boolean(busy)} aria-describedby="wn-device-note" onClick={() => void run('test', api.test)}><Send size={16} aria-hidden="true" />{busy === 'test' ? '正在发送…' : '发送测试提醒'}</button><button className="wn-button" disabled={Boolean(busy)} onClick={() => void run('refresh', api.read)}><RefreshCw size={16} aria-hidden="true" />{busy === 'refresh' ? '正在刷新…' : '刷新状态'}</button></div>
      {(error?.message || state?.error) && <p className="wn-error" role="alert">{error?.message || state.error}</p>}
    </section>
    <section className="wn-section" aria-labelledby="wn-last-attempt">
      <h2 id="wn-last-attempt">最近一次提醒</h2>
      {lastAttempt ? <>
        <p>{attemptLabels[lastAttempt.state] ?? lastAttempt.state}{lastAttempt.agentTitle ? ` · ${lastAttempt.agentTitle}` : ''}</p>
        <p className="wn-muted">{time(lastAttempt.at)}</p>
        <dl className="wn-meta">{targetResults.map(([target, result]) => <div key={target}><dt>{deviceLabels[target]}</dt><dd>{attemptLabels[result.state] ?? result.state}{result.reason && <p className="wn-muted">{result.reason}</p>}</dd></div>)}</dl>
        {lastAttempt.reason && <p className="wn-muted wn-result-note">{lastAttempt.reason}</p>}
        {hasSubmitted && <p className="wn-muted wn-result-note">已提交只表示 QQ 接受了发送请求，不代表设备已收到通知。</p>}
        {hasUnknown && <p className="wn-result-note">发送结果未知，请在对应设备核对；不会自动重发。</p>}
      </> : <p className="wn-muted">{state ? '还没有提醒记录。' : '读取状态后显示提醒记录。'}</p>}
    </section>
    <section className="wn-section"><div className="wn-note"><MessageSquare size={18} aria-hidden="true" /><div><h2>收到后，回 OMP 处理</h2><p className="wn-muted">普通问答会附上问题和选项。审批只提示类型和会话，不转发计划正文或命令。在 QQ 中回复不会提交到 OMP。</p></div></div><blockquote className="wn-preview">{'【OMP 待你确认】\n会话：旅行计划\n事项：计划待审批\n\n请回到 OMP 原会话，选择「批准执行」或「继续规划」。'}</blockquote></section>
  </main>;
}
