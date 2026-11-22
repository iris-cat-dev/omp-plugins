// Execution/data separation adapted from OpenAGI js/blueprint-runtime.js (runFlow).
import { endpointKey, NODE_DEFS, type BlueprintGraph, type BlueprintNode, type Link } from "./graph.js";
import type { BlueprintImage } from "./image.js";

export interface ImageInput { prompt: string; images: BlueprintImage[] }
export interface AgentInput extends ImageInput { modelId?: string }
export interface RunEvent { nodeId: string; linkId?: string; state: "running" | "done" | "failed"; agentId?: string; message?: string }
export interface RunResult { nodeId: string; text: string }
interface RunOptions {
  signal: AbortSignal;
  runAgent(input: AgentInput, onCreated: (agentId: string) => void): Promise<string>;
  generateImage(input: ImageInput): Promise<BlueprintImage>;
  onEvent(event: RunEvent): void;
  onResult(result: RunResult): void;
  onImage(nodeId: string, image: BlueprintImage): void;
}

export async function runBlueprint(graph: BlueprintGraph, { signal, runAgent, generateImage, onEvent, onResult, onImage }: RunOptions): Promise<{ results: RunResult[]; images: ReadonlyMap<string, BlueprintImage> }> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const inputs = new Map<string, Link>();
  const imageInputs = new Map<string, Link[]>();
  const outputs = new Map<string, Link[]>();
  const replies = new Map<string, string>();
  const generated = new Map<string, BlueprintImage>();
  const results: RunResult[] = [];
  for (const link of graph.links) {
    if (link.to.portId === "image") {
      const images = imageInputs.get(link.to.nodeId);
      if (images) images.push(link);
      else imageInputs.set(link.to.nodeId, [link]);
    } else inputs.set(endpointKey(link.to), link);
    const key = endpointKey(link.from);
    const edges = outputs.get(key);
    if (edges) edges.push(link);
    else outputs.set(key, [link]);
  }
  function read(node: BlueprintNode, portId: string) {
    const source = inputs.get(endpointKey({ nodeId: node.id, portId }))?.from;
    const title = `${NODE_DEFS[node.type].title} · ${NODE_DEFS[node.type].pins.find(({ id }) => id === portId)!.title}`;
    if (!source) throw new Error(`${title}：请连接输入`);
    const upstream = nodes.get(source.nodeId)!;
    switch (upstream.type) {
      case "text": case "boolean": return upstream.value;
      case "agent": {
        const reply = replies.get(upstream.id);
        if (reply !== undefined) return reply;
        throw new Error(`${title}：上游智能体尚未执行，请检查执行线`);
      }
      default: throw new Error("非数据端口出现在数据连线上");
    }
  }
  function readImages(node: BlueprintNode): BlueprintImage[] {
    return (imageInputs.get(node.id) ?? []).map(({ from }, index) => {
      const upstream = nodes.get(from.nodeId)!;
      if (upstream.type === "imageGen") {
        const image = generated.get(upstream.id);
        if (!image) throw new Error("上游图像生成节点尚未出图，请检查执行线");
        return image;
      }
      if (upstream.type !== "image") throw new Error("非图片节点出现在图片连线上");
      if (!upstream.asset) throw new Error(`第 ${index + 1} 个连接的图片节点为空`);
      return upstream.asset;
    });
  }
  const pending: { node: BlueprintNode; linkId?: string }[] = [{ node: graph.nodes.find(({ type }) => type === "start")! }];
  while (pending.length) {
    signal.throwIfAborted();
    const { node, linkId } = pending.pop()!;
    const event = { nodeId: node.id, linkId, state: "running" as const };
    onEvent(event);
    let agentId: string | undefined;
    let nextPort: string | undefined;
    try {
      switch (node.type) {
        case "start": nextPort = "out"; break;
        case "branch": nextPort = read(node, "condition") ? "true" : "false"; break;
        case "agent": {
          const prompt = read(node, "prompt") as string;
          if (!prompt.trim()) throw new Error("智能体 · 提示词不能为空");
          const images = readImages(node);
          const reply = await runAgent({ prompt, images, modelId: node.modelId ?? undefined }, (id) => {
            if (signal.aborted) return;
            agentId = id;
            onEvent({ ...event, agentId });
          });
          signal.throwIfAborted();
          replies.set(node.id, reply);
          nextPort = "out";
          break;
        }
        case "imageGen": {
          const wired = inputs.has(endpointKey({ nodeId: node.id, portId: "prompt" }));
          const prompt = (wired ? read(node, "prompt") as string : node.prompt).trim();
          if (!prompt) throw new Error("请输入提示词，或连接提示词输入");
          const image = await generateImage({ prompt, images: readImages(node) });
          signal.throwIfAborted();
          generated.set(node.id, image);
          onImage(node.id, image);
          nextPort = "out";
          break;
        }
        case "result": {
          const result = { nodeId: node.id, text: read(node, "text") as string };
          results.push(result);
          onResult(result);
          break;
        }
        default: throw new Error("纯数据节点没有执行入口");
      }
      onEvent({ ...event, state: "done", agentId });
    } catch (error) {
      if (!signal.aborted) onEvent({ ...event, state: "failed", agentId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!nextPort) continue;
    const edges = outputs.get(endpointKey({ nodeId: node.id, portId: nextPort }));
    if (edges) for (let i = edges.length - 1; i >= 0; i--) {
      const link = edges[i]!;
      pending.push({ node: nodes.get(link.to.nodeId)!, linkId: link.id });
    }
  }
  return { results, images: generated };
}
