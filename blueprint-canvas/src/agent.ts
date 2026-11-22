import type { OmpAgent, OmpApi, OmpProviderModelsResult } from "@omp-desktop/client";
import { getParentAgentIdFromLabels } from "@omp-desktop/protocol/agent-labels";
import type { AgentInput } from "./runner.js";

export type ModelCatalog = Pick<OmpProviderModelsResult, "models" | "error">;

async function workspaceRoot(omp: OmpApi, workspaceId: string, signal: AbortSignal): Promise<OmpAgent | undefined> {
  const agents: OmpAgent[] = [];
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await omp.agents.list({
      filter: { workspaceIds: [workspaceId], includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 100, cursor },
    });
    for (const { agent } of page.entries) if (agent.workspaceId === workspaceId && !agent.archivedAt) agents.push(agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  const ids = new Set(agents.map(({ id }) => id));
  return agents.find(({ labels }) => {
    const parent = getParentAgentIdFromLabels(labels);
    return !parent || !ids.has(parent);
  });
}

export async function runOmpAgent(omp: OmpApi, workspaceId: string, { prompt, images, modelId }: AgentInput, signal: AbortSignal, onCreated: (agentId: string, stop: () => Promise<void>) => void): Promise<string> {
  if (!prompt.trim()) throw new Error("智能体 · 提示词不能为空");
  const root = await workspaceRoot(omp, workspaceId, signal);
  signal.throwIfAborted();
  const agent = await omp.workspaces.ref(workspaceId).agents.create({
    title: "无限画布 · 智能体",
    ...(root ? { parent: root.id } : {}),
    config: { provider: modelId ? `omp/${modelId}` : "omp", modeId: "ask", featureValues: { workflow_mode: "chat" } },
  });
  signal.throwIfAborted();
  let submitted = false;
  let stopRequest: Promise<void> | undefined;
  const stop = () => {
    if (!submitted) return Promise.resolve();
    return stopRequest ??= (async () => { await agent.stop(); })();
  };
  onCreated(agent.id, stop);
  let snapshot = agent.current();
  const hasImages = images.length > 0;
  if (!snapshot?.currentModeId || ((modelId || hasImages) && !snapshot.model)) snapshot = (await agent.refresh())?.agent ?? null;
  signal.throwIfAborted();
  if (snapshot?.currentModeId !== "ask") throw new Error("会话未启用 OMP 询问模式，未提交提示词");
  if (modelId && snapshot.model !== modelId) throw new Error(`无法使用所选模型 ${modelId}，请在节点内重新选择`);
  if (hasImages) {
    const unknown = "无法验证当前模型是否支持图片";
    if (!snapshot.model) throw new Error(unknown);
    const activeModel = snapshot.model;
    const catalog = await omp.providers.listModels("omp", { cwd: snapshot.cwd });
    signal.throwIfAborted();
    if (catalog.error) throw new Error(`${unknown}：${catalog.error}`);
    const capability = catalog.models?.find(({ id }) => id === activeModel)?.metadata?.supportsImages;
    if (capability === false) throw new Error(`模型 ${activeModel} 不支持图片，请在节点内选择支持图片的模型`);
    if (capability !== true) throw new Error(`${unknown}：${activeModel}`);
  }
  signal.throwIfAborted();
  submitted = true;
  const response = await agent.run(`请完成以下任务，并直接给出结果：\n\n${prompt}`, {
    requireIdle: true,
    timeoutMs: 120_000,
    signal,
    ...(hasImages ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
  });
  signal.throwIfAborted();
  if (response.status === "permission" || response.status === "timeout") {
    const message = response.status === "permission" ? "智能体请求权限，画布未批准" : "等待智能体回复超时";
    try { await stop(); }
    catch (error) { throw new Error(`${message}；停止请求失败，请在工作区检查智能体`, { cause: error }); }
    throw new Error(message);
  }
  if (response.canceled) throw new Error("智能体已取消本轮运行");
  if (response.status !== "idle") throw new Error(response.error ?? "智能体运行失败");
  if (!response.finalText?.trim()) throw new Error("智能体没有返回文本");
  return response.finalText;
}
