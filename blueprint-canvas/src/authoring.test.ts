import { expect, test } from "vitest";
import { previewCanvasAuthorPatch } from "./authoring.js";
import { createExampleGraph } from "./graph.js";
import { runBlueprint } from "./runner.js";

const edge = (source: string, out: string, target: string, input: string) => ({
  from: { node: source, port: out }, to: { node: target, port: input },
});
const newNodes = [{ id: "message", type: "text", value: "画布 Agent 验证" }, { id: "display", type: "result" }];

test("adds a runnable result to the existing blueprint without changing the draft", async () => {
  const base = createExampleGraph();
  const start = `existing:${base.nodes[0]!.id}`;
  const reply = JSON.stringify({ nodes: newNodes, links: [
    edge(start, "out", "new:display", "in"), edge("new:message", "value", "new:display", "text"),
  ] });
  const { graph } = previewCanvasAuthorPatch(base, `\n\`\`\`json\r\n${reply}\r\n\`\`\`\n`);
  const { results } = await runBlueprint(graph, {
    signal: new AbortController().signal,
    runAgent: async () => { throw new Error("unexpected Agent node"); },
    generateImage: async () => { throw new Error("unexpected image generation"); },
    onEvent: () => {}, onResult: () => {}, onImage: () => {},
  });
  expect(results.map(({ text }) => text)).toEqual(["蓝图运行成功", "画布 Agent 验证"]);
  expect([base.nodes.length, base.links.length]).toEqual([5, 4]);
  expect(graph.viewport).toEqual(base.viewport);
});

test.each([
  ["类型", "引脚类型不匹配"], ["占用", "此输入已有连线"], ["反向", "请从输出引脚连接到输入引脚"], ["悬空", "引用的节点不存在"],
])("rejects an entire patch when its second link fails (%s)", (kind, error) => {
  const base = createExampleGraph();
  const before = structuredClone(base);
  const invalid = kind === "类型" ? edge("new:message", "value", `existing:${base.nodes[2]!.id}`, "in")
    : kind === "占用" ? edge("new:message", "value", `existing:${base.nodes[4]!.id}`, "text")
    : kind === "反向" ? edge("new:display", "text", "new:message", "value")
    : edge("new:missing", "value", "new:display", "text");
  expect(() => previewCanvasAuthorPatch(base, JSON.stringify({ nodes: newNodes, links: [
    edge(`existing:${base.nodes[0]!.id}`, "out", "new:display", "in"), invalid,
  ] }))).toThrow(`第 2 条连线：${error}`);
  expect(base).toEqual(before);
});

test.each([
  [[...newNodes, newNodes[0]], "第 3 个节点：节点别名重复"],
  [[{ id: "extra", type: "start" }], "智能体没有返回有效的画布更改"],
  [[{ id: "picture", type: "image", asset: "injected" }], "智能体没有返回有效的画布更改"],
  [[], "没有可应用的更改"],
])("rejects non-applicable node proposals (%j)", (nodes, error) => {
  expect(() => previewCanvasAuthorPatch(createExampleGraph(), JSON.stringify({ nodes, links: [] }))).toThrow(error);
});
