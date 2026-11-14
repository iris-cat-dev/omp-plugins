import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Coordinator } from './coordinator.mjs';
import { BindingManager } from './binding-manager.mjs';
import { revokeSavedSessions } from './config-transition.mjs';
import { status, save, action, models, unknownSends, reviewSend, interruptedMessages, closeInterrupted, imageSend, generateBinding, cancelBinding, config as configSchema } from './rpc.mjs';

async function register(ctx) {
  const id = createHash('sha256').update(ctx.installation.id).digest('hex');
  const directory = path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'OMP', 'wechat', id);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const coordinator = new Coordinator({ directory, root, signal: ctx.signal, mode: ctx.mode });
  const bindingManager = new BindingManager({ root, directory, signal: ctx.signal });
  const active = () => { if (ctx.signal.aborted) throw new Error('插件实例已停用'); };
  const getConfig = async () => { const value = (await ctx.storage.get()).values.wechatConfig; return value == null ? null : configSchema.parse(value); };
  let saving = false, epoch = 0;
  ctx.handle(status, async () => { active(); return { config: await getConfig(), ...coordinator.status(), mode: ctx.mode }; });
  ctx.handle(save, async input => {
    active();
    if (!['stopped', 'error'].includes(coordinator.state) || saving) throw new Error('请先停止连接再修改配置');
    if (!path.isAbsolute(input.pythonPath) || !path.isAbsolute(input.bindingPath)) throw new Error('Python 与绑定文件必须使用绝对路径');
    saving = true;
    try {
      const snapshot = await ctx.storage.get(); active();
      const previous = snapshot.values.wechatConfig == null ? null : configSchema.parse(snapshot.values.wechatConfig);
      revokeSavedSessions(directory, previous, input);
      await ctx.storage.patch({ wechatConfig: input }, snapshot.revision);
      return { saved: true };
    } finally { saving = false; }
  });
  ctx.handle(action, async ({ operation }) => {
    active();
    if (operation === 'stop') { epoch++; if (bindingManager.running) bindingManager.cancel(bindingManager.running.id); await coordinator.stop(); }
    else {
      const requestedEpoch = epoch;
      if (saving) throw new Error('请等待配置保存完成');
      const config = await getConfig(); active();
      if (saving || requestedEpoch !== epoch) throw new Error('启动已取消或配置正在保存');
      if (!config) throw new Error('请先保存连接配置');
      await coordinator.start(config);
    }
    return coordinator.status();
  });
  ctx.handle(generateBinding, async input => {
    active();
    if (ctx.mode !== 'active' || saving || !['stopped', 'error'].includes(coordinator.state)) throw new Error('请启用插件并停止连接，等待其他操作完成');
    saving = true;
    try { return await bindingManager.run(input); }
    finally { saving = false; }
  });
  ctx.handle(cancelBinding, ({ id }) => { active(); bindingManager.cancel(id); return { canceled: true }; });
  ctx.handle(unknownSends, async () => { active(); const config = await getConfig(); active(); return coordinator.unknownSends(config); });
  ctx.handle(reviewSend, async ({ id }) => {
    active();
    if (saving || !['stopped', 'error'].includes(coordinator.state)) throw new Error('请先停止连接，等待其他设置操作完成');
    saving = true;
    try {
      const config = await getConfig(); active();
      if (!config) throw new Error('当前没有配置账号');
      await coordinator.review(config, id);
      return { closed: true };
    } finally { saving = false; }
  });
  ctx.handle(interruptedMessages, async () => { active(); const config = await getConfig(); active(); return coordinator.interruptedMessages(config); });
  ctx.handle(closeInterrupted, async ({ seq }) => {
    active();
    if (saving || !['stopped', 'error'].includes(coordinator.state)) throw new Error('请先停止连接，等待其他设置操作完成');
    saving = true;
    try {
      const config = await getConfig(); active();
      if (!config) throw new Error('当前没有配置账号');
      coordinator.closeInterrupted(config, seq);
      return { closed: true };
    } finally { saving = false; }
  });
  ctx.handle(imageSend, async input => { active(); return coordinator.sendImage(input.target, input.path); });
  ctx.handle(models, async () => {
    active();
    if (ctx.mode !== 'active' || !ctx.omp) throw new Error('启用插件后才能读取宿主模型目录');
    mkdirSync(directory, { recursive: true });
    const result = await ctx.omp.providers.listModels('omp', { cwd: directory });
    active();
    if (result.error) throw new Error('无法读取 OMP 模型目录');
    return result.models.filter(item => item.isSelectable !== false).map(item => ({ id: item.id.startsWith('omp/') ? item.id : `omp/${item.id}`, name: item.name ?? item.id }));
  });
  return async () => { await Promise.all([bindingManager.close(), coordinator.close()]); };
}
export default register;
export const manage = register;
