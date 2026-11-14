import React, { useEffect, useRef, useState } from 'react';
import { status, save, action, models, unknownSends, reviewSend, interruptedMessages, closeInterrupted, imageSend, generateBinding, cancelBinding } from './rpc.mjs';

const empty = { accountId: '', bindingPath: '', pythonPath: '', targets: '', model: '' };
export default function setup(ctx) {
  function Page({ theme }) {
    const [draft, setDraft] = useState(empty), [state, setState] = useState(null), [choices, setChoices] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [pending, setPending] = useState(null), [interrupted, setInterrupted] = useState(null), [imagePath, setImagePath] = useState(''), [imageTarget, setImageTarget] = useState(''), [notice, setNotice] = useState('');
    const [bindingPid, setBindingPid] = useState(''), [contactDatabase, setContactDatabase] = useState(''), [bindingBusy, setBindingBusy] = useState(false), [bindingCanceling, setBindingCanceling] = useState(false);
    const mounted = useRef(false), bindingId = useRef(null), bindingCanceled = useRef(false);
    const colors = theme.colors;
    const refresh = async (loadConfig = false) => {
      const result = await ctx.rpc(status, {}); setState(result);
      if (loadConfig && result.config) setDraft({ ...result.config, targets: result.config.targets.join('\n') });
      if (['running', 'stopped', 'error'].includes(result.state)) { const [sends, messages] = await Promise.all([ctx.rpc(unknownSends, {}), ctx.rpc(interruptedMessages, {})]); setPending(sends); setInterrupted(messages); }
    };
    useEffect(() => { let alive = true; (async () => { const result = await ctx.rpc(status, {}); if (!alive) return; setState(result); if (result.config) setDraft({ ...result.config, targets: result.config.targets.join('\n') }); if (['running', 'stopped', 'error'].includes(result.state)) { const [sends, messages] = await Promise.all([ctx.rpc(unknownSends, {}), ctx.rpc(interruptedMessages, {})]); if (alive) { setPending(sends); setInterrupted(messages); } } })().catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (bindingId.current) { bindingCanceled.current = true; void ctx.rpc(cancelBinding, { id: bindingId.current }).catch(() => {}); } }; }, []);
    async function makeBinding() {
      const pid = Number(bindingPid);
      if (!/^[1-9][0-9]*$/.test(bindingPid) || !Number.isSafeInteger(pid)) { setError('请输入有效的微信进程 PID'); return; }
      const id = crypto.randomUUID().replaceAll('-', '');
      bindingId.current = id; bindingCanceled.current = false;
      setBindingBusy(true); setBindingCanceling(false); setBusy(true); setError(''); setNotice('');
      try {
        const result = await ctx.rpc(generateBinding, { id, accountId: draft.accountId, pid, contactDatabase, pythonPath: draft.pythonPath });
        if (mounted.current && bindingId.current === id && !bindingCanceled.current) { setDraft(previous => ({ ...previous, bindingPath: result.bindingPath })); setNotice('绑定已核验并回填；请保存配置。尚未启动连接。'); }
      } catch (failure) {
        if (mounted.current && bindingId.current === id && !bindingCanceled.current) setError(failure.message || '绑定核验失败');
      } finally {
        if (mounted.current && bindingId.current === id) { bindingId.current = null; setBindingBusy(false); setBindingCanceling(false); setBusy(false); }
      }
    }
    function cancelMakeBinding() {
      if (!bindingId.current || bindingCanceled.current) return;
      bindingCanceled.current = true; setBindingCanceling(true); setNotice('已请求取消绑定核验，不会回填结果。');
      void ctx.rpc(cancelBinding, { id: bindingId.current }).catch(() => { if (mounted.current) setError('取消请求未确认；请等待核验结束。'); });
    }
    const run = async fn => { setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e) { setError(e.message || '操作失败'); try { await refresh(); } catch {} } finally { setBusy(false); } };
    const field = (key, label, placeholder) => <label style={{ display: 'grid', gap: 6 }}>{label}<input value={draft[key]} placeholder={placeholder} onChange={e => setDraft({ ...draft, [key]: e.target.value })} style={input} disabled={busy || locked} /></label>;
    const locked = state && !['stopped', 'error'].includes(state.state);
    const input = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.foregroundMuted}`, background: colors.surface0, color: colors.foreground, font: 'inherit' };
    const button = { padding: '9px 15px', borderRadius: 8, border: `1px solid ${colors.accent}`, color: colors.foreground, background: colors.surface0, font: 'inherit', cursor: 'pointer' };
    return <main style={{ maxWidth: 680, margin: '0 auto', padding: 24, color: colors.foreground, fontFamily: 'inherit', lineHeight: 1.5 }}>
      <h1>微信连接</h1><p style={{ color: colors.foregroundMuted }}>仅处理明确授权的会话。插件不会自动启动连接。</p>
      <section><h2>连接状态</h2><p role="status">{state ? ({ stopped: '已停止', starting: '正在连接', running: '运行中', error: '连接异常' }[state.state] || state.state) : '正在读取状态'}{state?.reason ? `：${state.reason}` : ''}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}><button style={button} disabled={busy || locked || state?.mode !== 'active'} onClick={() => run(() => ctx.rpc(action, { operation: 'start' }))}>启动连接</button><button style={button} onClick={() => { if (bindingBusy) cancelMakeBinding(); void run(() => ctx.rpc(action, { operation: 'stop' })); }}>停止连接</button><button style={button} disabled={busy} onClick={() => run(() => refresh())}>刷新状态</button></div></section>
      <section style={{ display: 'grid', gap: 14, marginTop: 32 }}><h2 style={{ marginBottom: 0 }}>授权会话与模型</h2>
        <p style={{ color: colors.foregroundMuted, margin: 0 }}>填写账号、Python、目标进程 PID 和联系人数据库，主动核验后生成绑定。不会自动发现账号或启动连接。</p>
        {field('accountId', '微信账号 ID', 'wxid_…')}{field('pythonPath', 'Python 可执行文件的绝对路径', 'python.exe')}
        <label style={{ display: 'grid', gap: 6 }}>微信进程 PID<input style={input} value={bindingPid} inputMode="numeric" onChange={e => setBindingPid(e.target.value)} disabled={busy || locked} /></label>
        <label style={{ display: 'grid', gap: 6 }}>联系人数据库绝对路径<input style={input} value={contactDatabase} onChange={e => setContactDatabase(e.target.value)} placeholder="db_storage/contact/contact.db" disabled={busy || locked} /></label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button style={button} disabled={busy || locked || state?.mode !== 'active'} onClick={makeBinding}>核验并生成绑定</button>{bindingBusy && <button style={button} disabled={bindingCanceling} onClick={cancelMakeBinding}>取消核验</button>}</div>
        {field('bindingPath', '已验证绑定文件的绝对路径', 'JSON 文件')}
        <label style={{ display: 'grid', gap: 6 }}>允许的会话<textarea rows={4} value={draft.targets} onChange={e => setDraft({ ...draft, targets: e.target.value })} style={input} disabled={busy || locked} /></label>
        <label style={{ display: 'grid', gap: 6 }}>OMP 模型<select style={input} value={draft.model} disabled={busy || locked} onChange={e => setDraft({ ...draft, model: e.target.value })}><option value="">请选择模型</option>{draft.model && !choices.some(x => x.id === draft.model) && <option value={draft.model}>{draft.model}</option>}{choices.map(x => <option key={x.id} value={x.id}>{x.name} · {x.id}</option>)}</select></label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button style={button} disabled={busy || locked} onClick={() => run(async () => setChoices(await ctx.rpc(models, {})))}>读取模型目录</button><button style={{ ...button, background: colors.accent }} disabled={busy || locked} onClick={() => run(() => ctx.rpc(save, { ...draft, targets: draft.targets.split(/\r?\n/).map(x => x.trim()).filter(Boolean) }))}>保存配置</button></div>
      </section>
      <section style={{ display: 'grid', gap: 12, marginTop: 32 }}><h2>发送图片</h2>
        <p style={{ color: colors.foregroundMuted, margin: 0 }}>选择已授权会话，填写本机图片绝对路径；发送前需要再次确认。图片由原生宿主校验。</p>
        <label style={{ display: 'grid', gap: 6 }}>目标会话<select style={input} value={imageTarget} onChange={e => setImageTarget(e.target.value)} disabled={busy || state?.state !== 'running'}><option value="">请选择会话</option>{state?.config?.targets.map(target => <option key={target} value={target}>{target}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 6 }}>图片文件路径<input style={input} value={imagePath} onChange={e => setImagePath(e.target.value)} disabled={busy || state?.state !== 'running'} /></label>
        <div><button style={button} disabled={busy || state?.state !== 'running' || !imageTarget || !imagePath} onClick={() => { if (window.confirm(`确认向 ${imageTarget} 发送所选图片？`)) run(async () => { const result = await ctx.rpc(imageSend, { target: imageTarget, path: imagePath, confirmed: true }); setNotice(`图片已提交，编号 ${result.requestId}。`); setImagePath(''); }); }}>发送图片</button></div>
      </section>
      <section style={{ marginTop: 32 }}><h2>待核对的发送</h2><p style={{ color: colors.foregroundMuted }}>结果未知的发送不会重试。请先在微信核对实际结果，再选择封口；封口不会发送消息。</p>
        {pending === null ? <p>尚未读取发送记录。</p> : pending.length === 0 ? <p>没有待核对记录。</p> : pending.map(row => <div key={row.id} style={{ display: 'grid', gap: 8, marginBottom: 16, overflowWrap: 'anywhere' }}><span>{row.kind === 'image' ? '图片' : '文本'} · {row.peer} · {row.createdAt ? new Date(row.createdAt).toLocaleString() : '时间未知'} · {row.id}</span>{row.summary && <span>{row.kind === 'image' ? '文件：' : '内容：'}{row.summary}</span>}<div><button style={button} disabled={busy || locked || state?.mode !== 'active'} onClick={() => { if (window.confirm(`已在微信核对 ${row.peer} 的这条发送？封口后不会自动重发。`)) run(async () => { await ctx.rpc(reviewSend, { id: row.id, confirmed: true }); setNotice('已记录人工核对并封口，未重发。'); }); }}>已核对，封口</button></div></div>)}
      </section>
      <section style={{ marginTop: 32 }}><h2>中断的消息</h2><p style={{ color: colors.foregroundMuted }}>中断的消息不会自动重做。请先在微信核对已有回复，停止连接后关闭该记录，同一会话才能继续。</p>
        {interrupted === null ? <p>尚未读取中断记录。</p> : interrupted.length === 0 ? <p>没有中断记录。</p> : interrupted.map(row => <div key={row.seq} style={{ display: 'grid', gap: 8, marginBottom: 16, overflowWrap: 'anywhere' }}><span>{row.peer} · 已提交 {row.submittedParts} 段</span><span>收到：{row.message}</span><div><button style={button} disabled={busy || locked || state?.mode !== 'active'} onClick={() => { if (window.confirm(`已在微信核对 ${row.peer} 的回复？关闭后不会重做这条消息。`)) run(async () => { await ctx.rpc(closeInterrupted, { seq: row.seq, confirmed: true }); setNotice('已关闭中断记录，不会重发或重做。'); }); }}>已核对，关闭记录</button></div></div>)}
      </section>{notice && <p role="status">{notice}</p>}{error && <p role="alert" style={{ color: colors.statusDanger }}>{error}</p>}
    </main>;
  }
  ctx.addSettingsPage({ id: 'wechat.settings', title: '微信连接', icon: 'message-circle', Component: Page });
}
