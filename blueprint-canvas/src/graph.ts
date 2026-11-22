// Port registry and endpoints adapted from OpenAGI js/node-registry.js and
// js/flow-canvas.js. See LICENSE.openagi.
import { z } from "zod";
import { MAX_IMAGE_WIDTH, MAX_ZOOM, MIN_IMAGE_WIDTH, MIN_ZOOM, type Point } from "./geometry.js";
import { BlueprintImageSchema, MAX_GRAPH_IMAGE_BYTES, imageBytes } from "./image.js";

type PinType = "exec" | "text" | "boolean" | "image";
export interface Pin { id: string; title: string; direction: "in" | "out"; type: PinType; multiple?: boolean }
const pin = (id: string, title: string, direction: Pin["direction"], type: PinType): Pin => ({ id, title, direction, type });
export const NODE_DEFS = {
  start: { title: "开始", group: "流程", description: "蓝图的执行入口", pins: [pin("out", "执行", "out", "exec")] },
  text: { title: "文本", group: "输入", description: "提供提示词或文本值", pins: [pin("value", "文本", "out", "text")] },
  boolean: { title: "布尔", group: "输入", description: "提供真或假", pins: [pin("value", "布尔", "out", "boolean")] },
  image: { title: "图片", group: "输入", description: "拖入或选择本地图片", pins: [pin("value", "图片", "out", "image")] },
  branch: { title: "条件分支", group: "流程", description: "按条件执行一个出口", pins: [pin("in", "执行", "in", "exec"), pin("true", "为真", "out", "exec"), pin("false", "为假", "out", "exec"), pin("condition", "条件", "in", "boolean")] },
  agent: { title: "智能体", group: "AI", description: "把提示词和连入的图片交给模型", pins: [pin("in", "执行", "in", "exec"), pin("out", "完成", "out", "exec"), pin("prompt", "提示词", "in", "text"), pin("reply", "回复", "out", "text"), { ...pin("image", "图片", "in", "image"), multiple: true }] },
  imageGen: { title: "图像生成", group: "图像任务", description: "接参考图做图生图，不接则文生图", pins: [
    pin("in", "执行", "in", "exec"), pin("out", "完成", "out", "exec"), pin("prompt", "提示词", "in", "text"),
    { ...pin("image", "参考图", "in", "image"), multiple: true }, pin("generated", "生成图片", "out", "image"),
  ] },
  result: { title: "显示结果", group: "结果", description: "把文本显示在运行结果中", pins: [pin("in", "执行", "in", "exec"), pin("text", "文本", "in", "text")] },
};
const Id = z.string().min(1);
const nodeBase = z.object({ id: Id, x: z.number().finite(), y: z.number().finite() });
const NodeSchema = z.discriminatedUnion("type", [
  nodeBase.extend({ type: z.literal("start") }),
  nodeBase.extend({ type: z.literal("text"), value: z.string() }),
  nodeBase.extend({ type: z.literal("boolean"), value: z.boolean() }),
  nodeBase.extend({ type: z.literal("image"), asset: BlueprintImageSchema.nullable(), displayWidth: z.number().min(MIN_IMAGE_WIDTH).max(MAX_IMAGE_WIDTH).optional() }),
  nodeBase.extend({ type: z.literal("branch") }),
  nodeBase.extend({ type: z.literal("agent"), modelId: z.string().trim().min(1).nullish() }),
  nodeBase.extend({ type: z.literal("imageGen"), prompt: z.string() }),
  nodeBase.extend({ type: z.literal("result") }),
]);
const EndpointSchema = z.object({ nodeId: Id, portId: Id });
const LinkSchema = z.object({ id: Id, from: EndpointSchema, to: EndpointSchema });
export type BlueprintNode = z.infer<typeof NodeSchema>;
export type NodeType = BlueprintNode["type"];
export type Endpoint = z.infer<typeof EndpointSchema>;
export type Link = z.infer<typeof LinkSchema>;
export const endpointKey = ({ nodeId, portId }: Endpoint) => JSON.stringify([nodeId, portId]);

export function findPin(nodes: Map<string, BlueprintNode>, endpoint: Endpoint): Pin | undefined {
  const node = nodes.get(endpoint.nodeId);
  return node && NODE_DEFS[node.type].pins.find(({ id }) => id === endpoint.portId);
}

function linkError(nodes: Map<string, BlueprintNode>, from: Endpoint, to: Endpoint, sources?: ReadonlySet<string>): string | undefined {
  const output = findPin(nodes, from), input = findPin(nodes, to);
  if (!output || !input) return "引脚已不存在";
  if (output.direction !== "out" || input.direction !== "in") return "请连接一个输出和一个输入";
  if (from.nodeId === to.nodeId) return "不能连接同一个节点";
  if (output.type !== input.type) return "引脚类型不匹配";
  if (sources?.size && !input.multiple) return "此输入已有连线，请先断开";
  if (sources?.has(endpointKey(from))) return "这两个引脚已经连接";
}

function hasCycle(nodes: Map<string, BlueprintNode>, links: readonly Link[]): boolean {
  const edges = new Map<string, string[]>(), depths = new Map<string, number>();
  for (const id of nodes.keys()) depths.set(id, 0);
  for (const { from, to } of links) {
    const next = edges.get(from.nodeId);
    if (next) next.push(to.nodeId);
    else edges.set(from.nodeId, [to.nodeId]);
    depths.set(to.nodeId, depths.get(to.nodeId)! + 1);
  }
  const pending: string[] = [];
  for (const [id, depth] of depths) if (!depth) pending.push(id);
  let visited = 0;
  while (pending.length) {
    const id = pending.pop()!;
    visited++;
    for (const next of edges.get(id) ?? []) {
      const depth = depths.get(next)! - 1;
      depths.set(next, depth);
      if (!depth) pending.push(next);
    }
  }
  return visited !== nodes.size;
}

export function checkImageBudget(nodes: readonly BlueprintNode[]): void {
  let bytes = 0;
  for (const node of nodes) if (node.type === "image" && node.asset) bytes += imageBytes(node.asset.data);
  if (bytes > MAX_GRAPH_IMAGE_BYTES) throw new Error("每张蓝图的图片总大小不能超过 8 MiB");
}

function graphError(nodes: BlueprintNode[], links: Link[]): string | undefined {
  const index = new Map(nodes.map((node) => [node.id, node]));
  if (index.size !== nodes.length) return "节点 ID 重复";
  if (nodes.filter(({ type }) => type === "start").length !== 1) return "蓝图必须有且仅有一个开始节点";
  const sourcesByInput = new Map<string, Set<string>>(), ids = new Set<string>();
  for (const link of links) {
    if (ids.has(link.id)) return "连线 ID 重复";
    ids.add(link.id);
    const target = endpointKey(link.to);
    const sources = sourcesByInput.get(target);
    const error = linkError(index, link.from, link.to, sources);
    if (error) return error;
    if (sources) sources.add(endpointKey(link.from));
    else sourcesByInput.set(target, new Set([endpointKey(link.from)]));
  }
  if (hasCycle(index, links)) return "连线会形成循环";
}

export const GraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(NodeSchema),
  links: z.array(LinkSchema),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(MIN_ZOOM).max(MAX_ZOOM) }),
}).superRefine(({ nodes, links }, ctx) => {
  const error = graphError(nodes, links);
  if (error) ctx.addIssue({ code: "custom", message: error });
  try { checkImageBudget(nodes); }
  catch (caught) { ctx.addIssue({ code: "custom", message: (caught as Error).message }); }
});
export type BlueprintGraph = z.infer<typeof GraphSchema>;

export function connect(graph: BlueprintGraph, from: Endpoint, to: Endpoint): BlueprintGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (findPin(nodes, from)?.direction === "in") [from, to] = [to, from];
  const target = endpointKey(to);
  const sources = new Set(graph.links.filter((link) => endpointKey(link.to) === target).map((link) => endpointKey(link.from)));
  const error = linkError(nodes, from, to, sources);
  if (error) throw new Error(error);
  const links = [...graph.links, { id: crypto.randomUUID(), from, to }];
  if (hasCycle(nodes, links)) throw new Error("连线会形成循环");
  return { ...graph, links };
}

export function createNode(type: NodeType, point: Point): BlueprintNode {
  const base = { ...point, id: crypto.randomUUID() };
  switch (type) {
    case "text": return { ...base, type, value: "" };
    case "boolean": return { ...base, type, value: true };
    case "image": return { ...base, type, asset: null };
    case "imageGen": return { ...base, type, prompt: "" };
    default: return { ...base, type };
  }
}

export function createExampleGraph(): BlueprintGraph {
  const start = createNode("start", { x: 0, y: 0 });
  const condition = createNode("boolean", { x: 0, y: 148 });
  const branch = createNode("branch", { x: 276, y: 13 });
  const text = { ...createNode("text", { x: 276, y: 190 }), type: "text", value: "蓝图运行成功" } as const;
  const result = createNode("result", { x: 560, y: 66 });
  const link = (from: BlueprintNode, out: string, to: BlueprintNode, input: string): Link => ({
    id: crypto.randomUUID(), from: { nodeId: from.id, portId: out }, to: { nodeId: to.id, portId: input },
  });
  return { version: 1, nodes: [start, condition, branch, text, result], viewport: { x: 48, y: 48, zoom: 1 }, links: [
    link(start, "out", branch, "in"), link(condition, "value", branch, "condition"),
    link(branch, "true", result, "in"), link(text, "value", result, "text"),
  ] };
}
