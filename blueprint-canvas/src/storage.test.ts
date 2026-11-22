import { expect, test, vi } from "vitest";
import type { PluginStorage } from "@omp-desktop/plugin";
import { createNode } from "./graph.js";
import { graphKey, loadGraph, saveGraph } from "./storage.js";

function store(initial: Record<string, unknown> = {}): PluginStorage {
  let revision = 0;
  let values = initial;
  return {
    get: async <T>() => ({ revision, values: structuredClone(values) as T }),
    patch: async <T>(patch: Partial<T>, expectedRevision: number) => {
      if (expectedRevision !== revision) throw new Error("Plugin configuration changed. Reload it before saving.");
      values = { ...values, ...structuredClone(patch) };
      return { revision: ++revision, values: structuredClone(values) as T };
    },
  };
}

test("parallel saves on different checkouts preserve both graphs; stale saves on one checkout fail", async () => {
  const storage = store();
  const aKey = graphKey("host", "a"), bKey = graphKey("host", "b");
  const [a, b] = await Promise.all([loadGraph(storage, aKey), loadGraph(storage, bKey)]);
  await Promise.all([saveGraph(storage, aKey, a.baseline, a.graph), saveGraph(storage, bKey, b.baseline, b.graph)]);
  await expect(saveGraph(storage, aKey, a.baseline, b.graph)).rejects.toThrow("蓝图已在另一个窗口修改");
  expect((await loadGraph(storage, aKey)).graph).toEqual(a.graph);
  expect((await loadGraph(storage, bKey)).graph).toEqual(b.graph);
});

test("malformed saved graph never becomes a writable starter graph", async () => {
  const key = graphKey("host", "checkout");
  const storage = store({ [key]: { version: 1, nodes: [] } });
  const patch = vi.spyOn(storage, "patch");
  await expect(loadGraph(storage, key)).rejects.toThrow("已保存的蓝图无效");
  const { graph } = await loadGraph(storage, "different");
  await expect(saveGraph(storage, key, null, graph)).rejects.toThrow("已保存的蓝图无效");
  expect(patch).not.toHaveBeenCalled();
});

test("a node can return to the host default and the saved graph can still be opened and edited", async () => {
  const key = graphKey("host", "checkout");
  const storage = store();
  const { graph } = await loadGraph(storage, key);
  const agent = { ...createNode("agent", { x: 0, y: 0 }), type: "agent" as const, modelId: "test/vision" };
  graph.nodes.push(agent);
  const selected = await saveGraph(storage, key, null, graph);
  await saveGraph(storage, key, selected, {
    ...graph, nodes: [...graph.nodes.slice(0, -1), { ...agent, modelId: null }],
  });
  const reopened = await loadGraph(storage, key);
  expect(reopened.graph.nodes.find(({ id }) => id === agent.id)).toMatchObject({ modelId: null });
  const moved = await saveGraph(storage, key, reopened.baseline, {
    ...reopened.graph, nodes: reopened.graph.nodes.map((node) => node.id === agent.id ? { ...node, x: 12 } : node),
  });
  expect(moved.nodes.find(({ id }) => id === agent.id)).toMatchObject({ x: 12, modelId: null });
});
