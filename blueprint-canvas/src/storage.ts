import type { PluginStorage } from "@omp-desktop/plugin";
import { createExampleGraph, GraphSchema, type BlueprintGraph } from "./graph.js";

export const graphKey = (hostId: string, workspaceId: string) => `blueprint:${JSON.stringify([hostId, workspaceId])}`;

function readGraph(values: Record<string, unknown>, key: string): BlueprintGraph | null {
  if (!Object.hasOwn(values, key)) return null;
  const result = GraphSchema.safeParse(values[key]);
  if (!result.success) throw new Error(`已保存的蓝图无效：${result.error.issues[0]!.message}`);
  return result.data;
}

export interface DocumentState { graph: BlueprintGraph; baseline: BlueprintGraph | null }

export async function loadGraph(storage: PluginStorage, key: string): Promise<DocumentState> {
  const baseline = readGraph((await storage.get()).values, key);
  return { baseline, graph: baseline ?? createExampleGraph() };
}

export async function saveGraph(storage: PluginStorage, key: string, baseline: BlueprintGraph | null, graph: BlueprintGraph) {
  const saved = GraphSchema.parse(graph);
  for (let attempt = 0; ; attempt++) {
    const { revision, values } = await storage.get();
    // GraphSchema projects both sides in the same field order.
    if (JSON.stringify(readGraph(values, key)) !== JSON.stringify(baseline)) {
      throw new Error("蓝图已在另一个窗口修改，请重新读取");
    }
    try {
      await storage.patch({ [key]: saved }, revision);
      return saved;
    } catch (error) {
      if (attempt || !(error instanceof Error) || !error.message.includes("Plugin configuration changed. Reload it before saving.")) throw error;
    }
  }
}
