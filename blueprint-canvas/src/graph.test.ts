import { expect, test } from "vitest";
import { connect, createExampleGraph, createNode, GraphSchema } from "./graph.js";
import { fitView, screenToWorld, zoomAt } from "./geometry.js";
import { importBlueprintImage } from "./image.js";

const pin = (nodeId: string, portId: string) => ({ nodeId, portId });

test("validates directions and types without replacing an occupied input", () => {
  const graph = GraphSchema.parse(createExampleGraph());
  const [, condition, , text, result] = graph.nodes;
  expect(() => connect(graph, pin(condition!.id, "value"), pin(result!.id, "text"))).toThrow("引脚类型不匹配");
  expect(() => connect(graph, pin(result!.id, "text"), pin(text!.id, "value"))).toThrow("此输入已有连线");
  const image = createNode("image", { x: -20, y: 0 });
  const agent = createNode("agent", { x: 20, y: 0 });
  const connected = connect({ ...graph, nodes: [...graph.nodes, image, agent] }, pin(agent.id, "image"), pin(image.id, "value"));
  expect(connected.links.slice(0, -1)).toEqual(graph.links);
  expect(connected.links.at(-1)?.from).toEqual(pin(image.id, "value"));
});

test("rejects a cycle spanning an execution and a data edge", () => {
  const graph = createExampleGraph();
  const a = createNode("agent", { x: 0, y: 0 });
  const b = createNode("agent", { x: 200, y: 0 });
  const withExec = connect({ ...graph, nodes: [...graph.nodes, a, b] }, pin(a.id, "out"), pin(b.id, "in"));
  expect(() => connect(withExec, pin(b.id, "reply"), pin(a.id, "prompt"))).toThrow("连线会形成循环");
});

test("bounds total persisted picture bytes and refuses misleading file types", async () => {
  const graph = createExampleGraph();
  const asset = { name: "pic.png", mimeType: "image/png", data: "A".repeat(4 * 1024 * 1024), width: 100, height: 100 };
  const images = Array.from({ length: 3 }, (_, x) => ({ ...createNode("image", { x, y: 0 }), type: "image", asset }));
  expect(() => GraphSchema.parse({ ...graph, nodes: [...graph.nodes, ...images] })).toThrow("每张蓝图的图片总大小不能超过 8 MiB");
  await expect(importBlueprintImage(new File(["not an image"], "fake.png", { type: "image/png" }))).rejects.toThrow("图片内容与文件格式不符");
});

test("anchors zoom and fits nodes on both sides of the world origin", () => {
  const point = { x: 220, y: 150 };
  const view = { x: 52, y: -84, zoom: 1 };
  expect(screenToWorld(point, zoomAt(point, view, 1.5))).toEqual(screenToWorld(point, view));
  const fit = fitView([{ x: -200, y: -100, width: 600, height: 200 }], 696, 500);
  expect(fit).toEqual({ x: 248, y: 250, zoom: 1 });
});
