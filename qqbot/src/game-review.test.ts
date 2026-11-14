import { afterEach, expect, it, vi } from 'vitest';
import type { OmpApi, OmpAgentHandle, OmpAgentObservation, OmpAgentRunResult, OmpAgentStream, OmpAgentConfig } from '@omp-desktop/client';
import type { AgentTimelineItem } from '@omp-desktop/protocol/agent-types';
import type { FetchAgentTimelineResponseMessage } from '@omp-desktop/protocol/messages';
import { runGameReview } from './game-review.ts';
import type { GameReviewRequest } from './game-api.ts';

const request: GameReviewRequest = {
  kind: 'rift', requestId: 'current-review', revision: 2,
  system: '只依据真实行动证据判定。', prompt: '当前行动：先观察出口，再试探地板。',
  schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
};
const config: OmpAgentConfig = {
  provider: 'codex/current-model', thinkingOptionId: 'high',
  systemPrompt: 'CHAT_RULES_AND_GROUP_DIRECTORY', sandbox: { root: '/qq-sandbox' },
  toolPolicy: { preapproved: [{ kind: 'mcp', server: 'chat', tool: 'members' }] },
  mcpServers: { chat: { command: 'chat-tools' } },
};
type Timeline = FetchAgentTimelineResponseMessage['payload'];
type Entry = Timeline['entries'][number];
function row(seq: number, item: AgentTimelineItem, start = seq): Entry {
  return { seqStart: start, seqEnd: seq, item, timestamp: '2026-11-14T01:00:00Z', provider: 'codex',
    sourceSeqRanges: [{ startSeq: start, endSeq: seq }], collapsed: [] };
}
function page(entries: Entry[] = []): Timeline {
  return {
    requestId: 'timeline', agentId: 'review-child', agent: null, direction: 'tail', projection: 'canonical',
    epoch: 'child-epoch', reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: entries.length, nextSeq: entries.length + 1 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries, error: null,
  };
}
function fixture() {
  const controller = new AbortController();
  const order: string[] = [];
  let receive: ((stream: OmpAgentStream) => void) | undefined;
  const snapshot = { id: 'review-child', pendingPermissions: [], status: 'idle' } as unknown as OmpAgentObservation['snapshot'];
  const unsubscribe = vi.fn(() => { order.push('unsubscribe'); receive = undefined; });
  const observation: OmpAgentObservation = { snapshot, timeline: page(), unsubscribe };
  const result: OmpAgentRunResult = { status: 'idle', final: snapshot, error: null, lastMessage: 'INCOMPLETE_LAST_MESSAGE', finalText: 'INCOMPLETE_FINAL_TEXT' };
  const runStarted = Promise.withResolvers<void>();
  const child = {
    id: 'review-child', workspaceId: 'chat-workspace',
    observe: vi.fn(async (handler: (stream: OmpAgentStream) => void) => { order.push('observe'); receive = handler; return observation; }),
    run: vi.fn(async (_text: string, _options?: Parameters<OmpAgentHandle['run']>[1]) => { order.push('run'); runStarted.resolve(); return result; }),
    respondToPermission: vi.fn(async (_id: string, _response: Parameters<OmpAgentHandle['respondToPermission']>[1]) => { order.push('deny'); }),
    stop: vi.fn(async () => { order.push('stop'); }),
    archive: vi.fn(async () => { order.push('archive'); return { archivedAt: '2026-11-14T01:00:00Z' }; }),
    detach: vi.fn(async () => {}),
    timeline: { refetch: vi.fn(async (_options?: Parameters<OmpAgentHandle['timeline']['refetch']>[0]) => page([
      row(1, { type: 'user_message', text: request.prompt }),
      row(2, { type: 'assistant_message', text: '{"reason":"真实输出"}', messageId: 'result' }),
    ])) },
  };
  const parent = {
    id: 'chat-parent', workspaceId: 'chat-workspace',
    run: vi.fn(), send: vi.fn(), stop: vi.fn(), archive: vi.fn(), detach: vi.fn(),
    timeline: { refetch: vi.fn(() => { throw new Error('Parent chat history must never be read'); }) },
  };
  const create = vi.fn(async (_options: Parameters<OmpApi['agents']['create']>[0]) => { order.push('create'); return child as unknown as OmpAgentHandle; });
  const createWorkspace = vi.fn();
  const omp = { agents: { create }, workspaces: { create: createWorkspace } } as unknown as OmpApi;
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const options = { omp, parent: parent as unknown as OmpAgentHandle, config, cwd: '/qq-sandbox', request,
    feedback: '', signal: controller.signal, timeoutMs: 1000 };
  const emit = (event: OmpAgentStream['event']) => receive?.({ agentId: child.id, event } as OmpAgentStream);
  return { controller, order, observation, result, child, parent, create, createWorkspace, remove, options, emit, runStarted };
}
interface ReleaseChecks {
  child: Pick<OmpAgentHandle, 'archive' | 'stop' | 'detach'>;
  parent: Pick<OmpAgentHandle, 'run' | 'send' | 'stop' | 'archive' | 'detach'> & {
    timeline: Pick<OmpAgentHandle['timeline'], 'refetch'>;
  };
  createWorkspace: unknown;
  remove: unknown;
}
function expectReleased(f: ReleaseChecks, stopped: boolean) {
  expect(f.child.archive).toHaveBeenCalledOnce();
  expect(f.child.stop).toHaveBeenCalledTimes(stopped ? 1 : 0);
  expect(f.child.detach).not.toHaveBeenCalled();
  expect(f.parent.run).not.toHaveBeenCalled();
  expect(f.parent.send).not.toHaveBeenCalled();
  expect(f.parent.stop).not.toHaveBeenCalled();
  expect(f.parent.archive).not.toHaveBeenCalled();
  expect(f.parent.detach).not.toHaveBeenCalled();
  expect(f.parent.timeline.refetch).not.toHaveBeenCalled();
  expect(f.createWorkspace).not.toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalledWith('abort', expect.any(Function));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('returns every canonical delta unchanged, ignoring incomplete run summaries and buffered live text', async () => {
  const f = fixture();
  const text = '{"reason":"观察\\n出口🌙，再试探。"}';
  const entries = [row(1, { type: 'user_message', text: request.prompt })];
  for (let index = 0; index < text.length; index++) entries.push(row(index + 2, { type: 'assistant_message', text: text[index]!, messageId: 'one-result' }));
  f.child.run.mockImplementationOnce(async () => {
    f.emit({ type: 'timeline', provider: 'codex', item: { type: 'assistant_message', text: 'STALE_LIVE_DELTA', messageId: 'one-result' } });
    return f.result;
  });
  f.child.timeline.refetch.mockResolvedValueOnce(page(entries));
  expect(await runGameReview(f.options)).toEqual({ text, messageCount: 1 });
  expect(f.child.timeline.refetch).toHaveBeenCalledWith({ direction: 'tail', limit: 0, projection: 'canonical' });
  expect(f.order).toEqual(['create', 'observe', 'unsubscribe', 'archive']);
  expect(f.observation.unsubscribe).toHaveBeenCalledOnce();
  expectReleased(f, false);
});

it('preserves separate assistant messages and invalid JSON for the engine instead of inventing a score', async () => {
  const f = fixture();
  f.child.timeline.refetch.mockResolvedValueOnce(page([
    row(1, { type: 'reasoning', text: 'private reasoning must not be returned' }),
    row(2, { type: 'assistant_message', text: '{"reason":', messageId: 'first' }),
    row(3, { type: 'assistant_message', text: 'invalid JSON', messageId: 'second' }),
    row(4, { type: 'assistant_message', text: ' trailing text', messageId: 'second' }),
  ]));
  expect(await runGameReview(f.options)).toEqual({ text: '{"reason":\ninvalid JSON trailing text', messageCount: 2 });
  expectReleased(f, false);
});

it.each(['tool', 'plan', 'question', 'mode', 'other'] as const)('denies %s permissions and discards even apparent successful output', async kind => {
  const f = fixture();
  f.child.run.mockImplementationOnce(async () => {
    f.emit({ type: 'permission_requested', provider: 'codex', request: { id: 'permission', provider: 'codex', name: 'write', kind, input: {} } });
    f.emit({ type: 'permission_requested', provider: 'codex', request: { id: 'permission', provider: 'codex', name: 'write', kind, input: {} } });
    return f.result;
  });
  await expect(runGameReview(f.options)).rejects.toThrow('请求权限');
  expect(f.child.respondToPermission).toHaveBeenCalledExactlyOnceWith('permission', { behavior: 'deny', interrupt: true, message: '游戏评审禁止使用工具或申请权限。' });
  expect(f.child.timeline.refetch).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('denies all snapshot permissions when the finish response precedes buffered permission delivery', async () => {
  const f = fixture();
  f.result.status = 'permission';
  f.result.final = { ...f.observation.snapshot, pendingPermissions: [
    { id: 'first', kind: 'tool', provider: 'codex', name: 'read' }, { id: 'second', kind: 'tool', provider: 'codex', name: 'write' },
  ] } as OmpAgentObservation['snapshot'];
  await expect(runGameReview(f.options)).rejects.toThrow('请求权限');
  expect(f.child.respondToPermission.mock.calls.map(call => [call[0], call[1].behavior])).toEqual([['first', 'deny'], ['second', 'deny']]);
  expectReleased(f, true);
});

it('refuses a permission already pending in the new child before sending the request', async () => {
  const f = fixture();
  f.observation.snapshot = { ...f.observation.snapshot, pendingPermissions: [{ id: 'early', kind: 'tool', provider: 'codex', name: 'read' }] } as OmpAgentObservation['snapshot'];
  await expect(runGameReview(f.options)).rejects.toThrow('请求权限');
  expect(f.child.run).not.toHaveBeenCalled();
  expect(f.child.respondToPermission.mock.calls[0]![0]).toBe('early');
  expectReleased(f, true);
});

it.each([
  ['error', false, 'provider rejected request'],
  ['idle', true, null],
  ['timeout', false, null],
  ['permission', false, null],
] as const)('rejects finish status %s, canceled=%s rather than returning partial text', async (status, canceled, error) => {
  const f = fixture();
  Object.assign(f.result, { status, canceled, error });
  await expect(runGameReview(f.options)).rejects.toThrow(/失败|停止|超时/);
  expect(f.child.timeline.refetch).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('preserves provider failure and still releases the observation and child', async () => {
  const f = fixture();
  const failure = new Error('model transport failure');
  f.child.run.mockRejectedValueOnce(failure);
  await expect(runGameReview(f.options)).rejects.toBe(failure);
  expect(f.observation.unsubscribe).toHaveBeenCalledOnce();
  expectReleased(f, true);
});

it.each([
  { error: 'timeline unavailable' },
  { historyUnavailable: { reason: 'missing' as const, message: 'history missing' } },
  { gap: true }, { hasOlder: true }, { hasNewer: true },
])('rejects an unavailable or incomplete final output: %j', async details => {
  const f = fixture();
  f.child.timeline.refetch.mockResolvedValueOnce({ ...page(), ...details });
  await expect(runGameReview(f.options)).rejects.toThrow(/无法读取|不完整/);
  expectReleased(f, true);
});

it('never returns an error timeline as a scoring success', async () => {
  const f = fixture();
  f.child.timeline.refetch.mockResolvedValueOnce(page([
    row(1, { type: 'assistant_message', text: '{"reason":"partial"}' }),
    row(2, { type: 'error', message: 'generation failed' }),
  ]));
  await expect(runGameReview(f.options)).rejects.toThrow('generation failed');
  expectReleased(f, true);
});

it('does not create a child for an already canceled route', async () => {
  const f = fixture();
  f.controller.abort(new Error('route replaced'));
  await expect(runGameReview(f.options)).rejects.toMatchObject({ name: 'AbortError', cause: f.controller.signal.reason });
  expect(f.create).not.toHaveBeenCalled(); expect(f.parent.stop).not.toHaveBeenCalled();
});

it('stops only its active child and discards output arriving after cancellation', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<OmpAgentRunResult>();
  f.child.run.mockImplementationOnce(async () => { f.runStarted.resolve(); return pending.promise; });
  const review = runGameReview(f.options);
  await f.runStarted.promise;
  const waitSignal = f.child.run.mock.calls[0]![1]!.signal!;
  f.controller.abort('route replaced');
  await expect(review).rejects.toMatchObject({ name: 'AbortError' });
  expect(waitSignal.aborted).toBe(true);
  pending.resolve(f.result);
  expect(f.child.timeline.refetch).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('joins a late create result and cleans it without observing or starting a canceled review', async () => {
  const f = fixture();
  const creating = Promise.withResolvers<OmpAgentHandle>();
  f.create.mockReturnValueOnce(creating.promise);
  const review = runGameReview(f.options);
  f.controller.abort('route replaced during create');
  creating.resolve(f.child as unknown as OmpAgentHandle);
  await expect(review).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.child.observe).not.toHaveBeenCalled(); expect(f.child.run).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('releases an observation lease acquired after cancellation, then archives the child', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const observing = Promise.withResolvers<OmpAgentObservation>();
  f.child.observe.mockImplementationOnce(async () => { started.resolve(); return observing.promise; });
  const review = runGameReview(f.options);
  await started.promise;
  f.controller.abort('route replaced during observe');
  observing.resolve(f.observation);
  await expect(review).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.child.run).not.toHaveBeenCalled();
  expect(f.order).toEqual(['create', 'unsubscribe', 'stop', 'archive']);
  expect(f.observation.unsubscribe).toHaveBeenCalledOnce();
  expectReleased(f, true);
});

it('cleans a child when observation acquisition fails', async () => {
  const f = fixture();
  const error = new Error('observation failed');
  f.child.observe.mockRejectedValueOnce(error);
  await expect(runGameReview(f.options)).rejects.toBe(error);
  expect(f.child.run).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('cleans cancellation during the final timeline read, ignoring its later result', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const fetching = Promise.withResolvers<Timeline>();
  f.child.timeline.refetch.mockImplementationOnce(async () => { started.resolve(); return fetching.promise; });
  const review = runGameReview(f.options);
  await started.promise;
  f.controller.abort('route replaced during output read');
  await expect(review).rejects.toMatchObject({ name: 'AbortError' });
  fetching.resolve(page([row(1, { type: 'assistant_message', text: 'LATE_OUTPUT' })]));
  expectReleased(f, true);
});

it('timeouts stop and archive the child and remove timers/listeners', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = Promise.withResolvers<OmpAgentRunResult>();
  f.child.run.mockImplementationOnce(async () => { f.runStarted.resolve(); return pending.promise; });
  const review = runGameReview({ ...f.options, timeoutMs: 40 });
  const rejected = expect(review).rejects.toMatchObject({ name: 'TimeoutError' });
  await f.runStarted.promise;
  await vi.advanceTimersByTimeAsync(40);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve(f.result);
  expectReleased(f, true);
});

it('still attempts archive after stop failure and exposes both original failure and cleanup failure', async () => {
  const f = fixture();
  const failure = new Error('provider failed');
  const cleanup = new Error('stop not acknowledged');
  f.child.run.mockRejectedValueOnce(failure); f.child.stop.mockRejectedValueOnce(cleanup);
  await expect(runGameReview(f.options)).rejects.toMatchObject({ name: 'AggregateError', errors: [failure, cleanup] });
  expectReleased(f, true);
});

it('does not report success when archiving fails', async () => {
  const f = fixture();
  const cleanup = new Error('archive failed');
  f.child.archive.mockRejectedValueOnce(cleanup);
  await expect(runGameReview(f.options)).rejects.toMatchObject({ name: 'AggregateError', errors: [cleanup] });
  expectReleased(f, false);
});

it('cancellation during normal archival prevents a completed result from escaping', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const archiving = Promise.withResolvers<{ archivedAt: string }>();
  f.child.archive.mockImplementationOnce(async () => { started.resolve(); return archiving.promise; });
  const review = runGameReview(f.options);
  await started.promise;
  f.controller.abort('route replaced during archival');
  archiving.resolve({ archivedAt: '2026-11-14T01:00:00Z' });
  await expect(review).rejects.toMatchObject({ name: 'AbortError' });
  expectReleased(f, false);
});

it.each([
  { type: 'turn_failed' as const, provider: 'codex' as const, error: 'live model failure' },
  { type: 'turn_canceled' as const, provider: 'codex' as const, reason: 'stopped externally' },
])('reacts to a live %s even when the run waiter has not settled', async event => {
  const f = fixture();
  const pending = Promise.withResolvers<OmpAgentRunResult>();
  f.child.run.mockImplementationOnce(async () => { f.runStarted.resolve(); return pending.promise; });
  const review = runGameReview(f.options);
  await f.runStarted.promise;
  f.emit(event);
  await expect(review).rejects.toThrow(event.type === 'turn_failed' ? 'live model failure' : 'stopped externally');
  pending.resolve(f.result);
  expect(f.child.timeline.refetch).not.toHaveBeenCalled();
  expectReleased(f, true);
});

it('retains permission denial failures while still stopping and archiving the child', async () => {
  const f = fixture();
  const denied = new Error('permission response disconnected');
  f.child.respondToPermission.mockRejectedValueOnce(denied);
  f.child.run.mockImplementationOnce(async () => {
    f.emit({ type: 'permission_requested', provider: 'codex', request: { id: 'permission', provider: 'codex', name: 'write', kind: 'tool' } });
    return f.result;
  });
  await expect(runGameReview(f.options)).rejects.toMatchObject({ name: 'AggregateError', errors: [expect.objectContaining({ message: '游戏评审请求权限，已拒绝' }), denied] });
  expectReleased(f, true);
});

it('removes cancellation listeners when creation fails without touching any existing agent', async () => {
  const f = fixture();
  const failed = new Error('creation rejected');
  f.create.mockRejectedValueOnce(failed);
  await expect(runGameReview(f.options)).rejects.toBe(failed);
  expect(f.remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(f.child.observe).not.toHaveBeenCalled(); expect(f.child.stop).not.toHaveBeenCalled();
  expect(f.child.archive).not.toHaveBeenCalled(); expect(f.parent.stop).not.toHaveBeenCalled();
});

it('still archives the child and removes route listeners if observation disposal fails', async () => {
  const f = fixture();
  const failed = new Error('observation disposal disconnected');
  f.observation.unsubscribe = vi.fn(() => { throw failed; });
  await expect(runGameReview(f.options)).rejects.toMatchObject({ name: 'AggregateError', errors: [failed] });
  expectReleased(f, false);
});
