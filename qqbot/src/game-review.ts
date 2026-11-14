import type { OmpApi, OmpAgentHandle, OmpAgentConfig, OmpAgentObservation } from '@omp-desktop/client';
import type { GameReviewRequest } from './game-api.ts';
import { AssistantOutput, type AssistantReply } from './assistant-output.ts';

export interface GameReviewOptions {
  omp: OmpApi;
  parent: OmpAgentHandle;
  config: OmpAgentConfig;
  cwd: string;
  request: GameReviewRequest;
  feedback: string;
  signal: AbortSignal;
  timeoutMs: number;
}

function canceled(signal: AbortSignal) {
  const error = new Error('游戏评审已取消', { cause: signal.reason });
  error.name = 'AbortError';
  return error;
}

// SDK parent establishes ownership and reuses the parent's workspace, not its
// conversation. Create without a prompt so permission observation precedes work.
export async function runGameReview(options: GameReviewOptions): Promise<AssistantReply> {
  const { omp, parent, config, cwd, request, feedback, signal, timeoutMs } = options;
  if (signal.aborted) throw canceled(signal);

  const controller = new AbortController();
  let interruption: Error | undefined;
  const { promise: interrupted, reject: rejectInterrupted } = Promise.withResolvers<never>();
  const fail = (error: Error) => {
    if (interruption) return;
    interruption = error;
    controller.abort(error);
    rejectInterrupted(error);
  };
  const abort = () => fail(canceled(signal));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`游戏评审超时（${timeoutMs}ms）`);
    error.name = 'TimeoutError';
    fail(error);
  }, timeoutMs);
  const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, interrupted]);
  const check = () => { if (interruption) throw interruption; };

  let child: OmpAgentHandle | undefined;
  let creating: Promise<OmpAgentHandle> | undefined;
  let observing: Promise<OmpAgentObservation> | undefined;
  let observation: OmpAgentObservation | undefined;
  let reply: AssistantReply | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const denials = new Map<string, Promise<void>>();
  const deny = (requestId: string) => {
    if (denials.has(requestId)) return;
    denials.set(requestId, child!.respondToPermission(requestId, {
      behavior: 'deny', interrupt: true, message: '游戏评审禁止使用工具或申请权限。',
    }).catch(error => { cleanupErrors.push(error); }));
    fail(new Error('游戏评审请求权限，已拒绝'));
  };

  try {
    check();
    creating = omp.agents.create({
      parent, cwd, background: true, notifyOnFinish: false,
      config: {
        ...config,
        systemPrompt: `${request.system}\n\n[插件宿主评审规则]\n只依据当前评审输入和真实纠正反馈给出判定JSON；不要执行游戏动作、使用工具或回复QQ。评分是否有效及是否通过由宿主游戏引擎校验，不得自报执行成功。`,
        toolPolicy: { preapproved: [] },
        mcpServers: {},
      },
    }).then(agent => { child = agent; return agent; });
    await wait(creating);
    check();
    observing = child!.observe(stream => {
      const event = stream.event;
      if (event.type === 'permission_requested') deny(event.request.id);
      else if (event.type === 'turn_failed') fail(new Error(`游戏评审失败：${event.error}`));
      else if (event.type === 'turn_canceled') {
        const error = new Error(`游戏评审被停止：${event.reason}`);
        error.name = 'AbortError';
        fail(error);
      }
    }).then(value => { observation = value; return value; });
    await wait(observing);
    check();
    for (const permission of observation!.snapshot.pendingPermissions) deny(permission.id);
    check();

    const prompt = `${request.prompt}\n\n严格输出判定JSON，完整schema：${JSON.stringify(request.schema)}`
      + (feedback ? `\n\n[宿主真实纠正反馈]\n${feedback}` : '');
    const result = await wait(child!.run(prompt, {
      signal: controller.signal, timeoutMs, requireIdle: true, sourceKind: 'service',
    }));
    for (const permission of result.final?.pendingPermissions ?? []) deny(permission.id);
    check();
    if (result.canceled) {
      const error = new Error('游戏评审被停止');
      error.name = 'AbortError';
      throw error;
    }
    if (result.status === 'timeout') {
      const error = new Error(`游戏评审超时（${timeoutMs}ms）`);
      error.name = 'TimeoutError';
      throw error;
    }
    if (result.status !== 'idle' || result.error) throw new Error(`游戏评审失败：${result.error ?? result.status}`);

    // Fetch the complete canonical result after run settles. This also includes
    // deltas whose live delivery is still buffered by observe; lastMessage and
    // finalText alone can lose separate assistant messages.
    const timeline = await wait(child!.timeline.refetch({ direction: 'tail', limit: 0, projection: 'canonical' }));
    check();
    if (timeline.error || timeline.historyUnavailable) throw new Error(`无法读取游戏评审输出：${timeline.error ?? timeline.historyUnavailable!.message}`);
    if (timeline.gap || timeline.hasOlder || timeline.hasNewer) throw new Error('游戏评审输出不完整');
    const output = new AssistantOutput();
    for (const row of timeline.entries) {
      if (row.item.type === 'assistant_message') output.add(row.item, row.seqEnd, timeline.contentVersion ?? 0, row.seqStart);
      else if (row.item.type === 'error') throw new Error(`游戏评审失败：${row.item.message}`);
    }
    reply = output.reply;
  } catch (error) {
    failure = interruption ?? error;
  } finally {
    // Creation and observation have no SDK cancellation parameter. Join their
    // settlement before returning so a late child or timeline lease cannot leak.
    if (creating) {
      try { await creating; } catch (error) { failure ??= error; }
    }
    if (observing) {
      try { await observing; } catch (error) { failure ??= error; }
    }
    try { observation?.unsubscribe(); } catch (error) { cleanupErrors.push(error); }
    await Promise.all(denials.values());
    if (child) {
      if (failure || interruption) {
        try { await child.stop(); } catch (error) { cleanupErrors.push(error); }
      }
      // archive unloads the runtime and retains the result for host audit; it
      // neither archives the shared workspace nor stops the parent.
      try { await child.archive(); } catch (error) { cleanupErrors.push(error); }
    }
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  failure ??= interruption;
  if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], '游戏评审或会话清理失败');
  if (failure !== undefined) throw failure;
  return reply!;
}
