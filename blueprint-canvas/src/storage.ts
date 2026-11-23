import type { OmpWorkspaceFileActions, WorkspaceFileTarget, WorkspaceFileVersion } from "@omp-desktop/client";
import type { PluginStorage } from "@omp-desktop/plugin";
import { createExampleGraph, GraphSchema, type BlueprintGraph } from "./graph.js";

export const CANVAS_DIRECTORY = "canvases";
export const CANVAS_SUFFIX = ".canva.json";

export class GraphConflictError extends Error {
  constructor() { super("画布文件已在其他窗口或编辑器中修改，请重新读取"); }
}

function parseGraph(value: unknown) {
  const result = GraphSchema.safeParse(value);
  if (!result.success) throw new Error(`画布数据无效：${result.error.issues[0]!.message}`);
  return result.data;
}

export async function loadGraph(files: OmpWorkspaceFileActions, location: WorkspaceFileTarget) {
  const file = await files.read(location);
  if (!file) throw new Error(`找不到画布文件：${location.path}`);
  let value: unknown;
  try { value = JSON.parse(file.content); }
  catch (cause) { throw new Error(`画布不是有效的 JSON：${location.path}`, { cause }); }
  return { graph: parseGraph(value), version: { modifiedAt: file.modifiedAt, revision: file.revision } };
}

export async function saveGraph(files: OmpWorkspaceFileActions, location: WorkspaceFileTarget, version: WorkspaceFileVersion, graph: BlueprintGraph): Promise<WorkspaceFileVersion> {
  const result = await files.write({ ...location, content: `${JSON.stringify(graph, null, 2)}\n`,
    expectedModifiedAt: version.modifiedAt, expectedRevision: version.revision });
  if (result.status === "conflict") throw new GraphConflictError();
  if (result.status === "error") throw new Error(result.error);
  return { modifiedAt: result.modifiedAt, revision: result.revision };
}

export async function listCanvases(files: OmpWorkspaceFileActions, workspaceId: string) {
  const entries = await files.list({ workspaceId, scope: "project", path: CANVAS_DIRECTORY });
  return (entries ?? []).filter(({ kind, name }) => kind === "file" && name.toLowerCase().endsWith(CANVAS_SUFFIX))
    .map(({ name }) => name).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

export async function createCanvas(files: OmpWorkspaceFileActions, workspaceId: string, title: string) {
  const trimmed = title.trim();
  const name = trimmed.toLowerCase().endsWith(CANVAS_SUFFIX) ? trimmed.slice(0, -CANVAS_SUFFIX.length) : trimmed;
  if (!name || name.length > 60 || /[/\\<>:"|?*\x00-\x1f]|^[.]|[. ]$/.test(name)
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error("请输入 1–60 个字符的有效画布名称，不要包含路径分隔符或系统保留字符");
  }
  const scope = "project" as const;
  await files.mkdir({ workspaceId, scope, path: CANVAS_DIRECTORY });
  const fileName = `${name}${CANVAS_SUFFIX}`;
  const path = `${CANVAS_DIRECTORY}/${fileName}`;
  const content = `${JSON.stringify(createExampleGraph(), null, 2)}\n`;
  if (!await files.create({ workspaceId, scope, path, content })) throw new Error(`画布已存在：${fileName}`);
  return fileName;
}

export async function migrateLegacyCanvas(files: OmpWorkspaceFileActions, storage: PluginStorage, hostId: string, workspaceId: string) {
  const key = `blueprint:${JSON.stringify([hostId, workspaceId])}`;
  const snapshot = await storage.get<Record<string, unknown>>();
  const original = snapshot.values[key];
  if (original == null) return;
  const graph = parseGraph(original);
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  const scope = "project" as const;
  await files.mkdir({ workspaceId, scope, path: CANVAS_DIRECTORY });
  const name = `迁移画布-${encodeURIComponent(workspaceId)}`;
  let index = 1;
  let filename: string;
  for (;;) {
    filename = `${name}${index === 1 ? "" : `-${index}`}${CANVAS_SUFFIX}`;
    const location = { workspaceId, scope, path: `${CANVAS_DIRECTORY}/${filename}` };
    if (await files.create({ ...location, content })) break;
    const existing = await files.read(location);
    if (existing?.content === content) break;
    index++;
  }
  // Storage patches merge JSON keys, so clear only the migrated payload; never reset other workspaces.
  const latest = await storage.get<Record<string, unknown>>();
  if (latest.values[key] != null) {
    if (JSON.stringify(latest.values[key]) !== JSON.stringify(original)) throw new Error("旧画布在迁移期间被修改，请重新打开画布列表后再试");
    await storage.patch({ [key]: null }, latest.revision);
  }
  return filename;
}
