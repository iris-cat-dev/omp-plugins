import { expect, test, vi } from "vitest";
import { connect, createExampleGraph, createNode, type BlueprintGraph } from "./graph.js";
import { runBlueprint } from "./runner.js";
import { runOmpAgent } from "./agent.js";
import type { OmpApi, OmpAgentRunResult } from "@omp-desktop/client";
import type { BlueprintImage } from "./image.js";

const asset = { name: "diagram.png", data: "iVBORw0KGgo=", mimeType: "image/png", width: 1, height: 1 } satisfies BlueprintImage;
const runOptions = () => ({
  signal: new AbortController().signal, runAgent: vi.fn(async () => "unused"),
  generateImage: vi.fn(async () => asset), onEvent: vi.fn(), onResult: vi.fn(), onImage: vi.fn(),
});

function graphWithAgent(images: readonly (BlueprintImage | null)[] = []) {
  const example = createExampleGraph();
  const [, , branch, text, result] = example.nodes;
  const agent = createNode("agent", { x: 0, y: 0 });
  let graph: BlueprintGraph = { ...example, nodes: [...example.nodes, agent], links: example.links.filter(({ to }) => to.nodeId !== result!.id) };
  graph = connect(graph, { nodeId: branch!.id, portId: "true" }, { nodeId: agent.id, portId: "in" });
  graph = connect(graph, { nodeId: text!.id, portId: "value" }, { nodeId: agent.id, portId: "prompt" });
  graph = connect(graph, { nodeId: agent.id, portId: "out" }, { nodeId: result!.id, portId: "in" });
  graph = connect(graph, { nodeId: agent.id, portId: "reply" }, { nodeId: result!.id, portId: "text" });
  for (const [x, asset] of images.entries()) {
    const node = { ...createNode("image", { x, y: 0 }), type: "image" as const, asset };
    graph = connect({ ...graph, nodes: [...graph.nodes, node] }, { nodeId: node.id, portId: "value" }, { nodeId: agent.id, portId: "image" });
  }
  return graph;
}

test("the starter computes the result only on the selected branch", async () => {
  const graph = createExampleGraph();
  expect((await runBlueprint(graph, runOptions())).results[0]?.text).toBe("蓝图运行成功");
  graph.nodes = graph.nodes.map((node) => node.type === "boolean" ? { ...node, value: false } : node);
  expect((await runBlueprint(graph, runOptions())).results).toEqual([]);
});

test("an empty image after a connected valid image fails before the agent is created", async () => {
  const options = runOptions();
  await expect(runBlueprint(graphWithAgent([asset, null]), options)).rejects.toThrow("第 2 个连接的图片节点为空");
  expect(options.runAgent).not.toHaveBeenCalled();
  expect(options.onResult).not.toHaveBeenCalled();
});

function agentFixture(result: Partial<OmpAgentRunResult> = {}, supportsImages?: boolean) {
  const stop = vi.fn(async () => {});
  const run = vi.fn(async (_text: string, _options: unknown) => ({ status: "idle", final: null, error: null, lastMessage: null, finalText: " Vision result. ", ...result }));
  const catalog = vi.fn(async () => ({ models: [{ id: "test/model", metadata: { supportsImages } }] }));
  const create = vi.fn(async () => ({ id: "fresh-agent", current: () => ({ model: "test/model", currentModeId: "ask", cwd: "/workspace" }), run, stop }));
  const omp = {
    agents: { list: async () => ({ entries: [{ agent: { id: "root", labels: {}, workspaceId: "ws" } }], pageInfo: { nextCursor: null } }) },
    workspaces: { ref: () => ({ agents: { create } }) },
    providers: { listModels: catalog },
  } as unknown as OmpApi;
  return { omp, create, run, stop, catalog };
}

test("shows the current Agent turn's final text, not the older reply", async () => {
  const { omp } = agentFixture({ lastMessage: "older reply" }, true);
  const options = runOptions();
  const result = await runBlueprint(graphWithAgent([asset, { ...asset, name: "second.png" }]), {
    ...options, runAgent: (input, created) => runOmpAgent(omp, "ws", input, options.signal, created),
  });
  expect(result.results[0]?.text).toBe(" Vision result. ");
});

test.each([false, undefined])("does not submit an image turn without positive vision capability (%s)", async (value) => {
  const { omp, run } = agentFixture({}, value);
  await expect(runOmpAgent(omp, "ws", { prompt: "Describe it", images: [asset] }, runOptions().signal, vi.fn())).rejects.toThrow(/支持图片/);
  expect(run).not.toHaveBeenCalled();
});

test("does not send a prompt if the runtime replaces the explicitly selected model", async () => {
  const { omp, run } = agentFixture();
  await expect(runOmpAgent(omp, "ws", {
    prompt: "Use the selected model", images: [], modelId: "test/removed",
  }, runOptions().signal, vi.fn())).rejects.toThrow("无法使用所选模型 test/removed");
  expect(run).not.toHaveBeenCalled();
});

test.each([{ status: "permission" }, { status: "error" }, { finalText: "   " }] satisfies Partial<OmpAgentRunResult>[])("does not publish output on incomplete Agent turns (%j)", async (response) => {
  const { omp, stop } = agentFixture(response);
  const options = runOptions();
  await expect(runBlueprint(graphWithAgent(), { ...options, runAgent: (input, created) => runOmpAgent(omp, "ws", input, options.signal, created) })).rejects.toThrow();
  expect(options.onResult).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(response.status === "permission" ? 1 : 0);
});

test("cancelling during capability discovery does not send a prompt", async () => {
  const controller = new AbortController();
  const { omp, catalog, run } = agentFixture({}, true);
  catalog.mockImplementationOnce(async () => {
    controller.abort();
    return { models: [{ id: "test/model", metadata: { supportsImages: true } }] };
  });
  await expect(runOmpAgent(omp, "ws", { prompt: "read this", images: [asset] }, controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
  expect(run).not.toHaveBeenCalled();
});

test("a late Agent reply after cancellation cannot activate the result", async () => {
  const controller = new AbortController();
  const reply = Promise.withResolvers<string>();
  const options = runOptions();
  const execution = runBlueprint(graphWithAgent(), { ...options, signal: controller.signal, runAgent: () => reply.promise });
  const aborted = expect(execution).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  reply.resolve("late response");
  await aborted;
  expect(options.onResult).not.toHaveBeenCalled();
});

test("generation only uses upstream images produced by the current execution", async () => {
  const start = createNode("start", { x: 0, y: 0 });
  const first = { ...createNode("imageGen", { x: 220, y: 0 }), type: "imageGen" as const, prompt: "a poster" };
  const second = { ...createNode("imageGen", { x: 440, y: 0 }), type: "imageGen" as const, prompt: "edit the poster" };
  const graph = { ...createExampleGraph(), nodes: [start, first, second], links: [] } satisfies BlueprintGraph;
  const linked = connect(connect(graph, { nodeId: start.id, portId: "out" }, { nodeId: second.id, portId: "in" }),
    { nodeId: first.id, portId: "generated" }, { nodeId: second.id, portId: "image" });
  const options = runOptions();
  await expect(runBlueprint(linked, options)).rejects.toThrow("上游图像生成节点尚未出图");
  expect(options.generateImage).not.toHaveBeenCalled();
  const wired = connect(connect({ ...linked, links: linked.links.filter(({ to }) => to.portId !== "in") },
    { nodeId: start.id, portId: "out" }, { nodeId: first.id, portId: "in" }),
    { nodeId: first.id, portId: "out" }, { nodeId: second.id, portId: "in" });
  const result = await runBlueprint(wired, { ...options, generateImage: async ({ images }) => {
    if (!images.length) return asset;
    return { ...images[0]!, name: "edited.png" };
  } });
  expect(result.images.get(first.id)?.name).toBe("diagram.png");
  expect(result.images.get(second.id)?.name).toBe("edited.png");
});

test("stopping a pending generation discards even a late successful image", async () => {
  const controller = new AbortController();
  const image = Promise.withResolvers<BlueprintImage>();
  const start = createNode("start", { x: 0, y: 0 });
  const generation = { ...createNode("imageGen", { x: 220, y: 0 }), type: "imageGen" as const, prompt: "a poster" };
  const graph = connect({ ...createExampleGraph(), nodes: [start, generation], links: [] },
    { nodeId: start.id, portId: "out" }, { nodeId: generation.id, portId: "in" });
  const options = runOptions();
  const execution = runBlueprint(graph, { ...options, signal: controller.signal, generateImage: () => image.promise });
  const stopped = expect(execution).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  image.resolve(asset);
  await stopped;
  expect(options.onImage).not.toHaveBeenCalled();
});
