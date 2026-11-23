import { afterEach, expect, test, vi } from "vitest";
import type { OmpWorkspaceFileActions, WorkspaceFileTarget } from "@omp-desktop/client";
import type { PluginStorage } from "@omp-desktop/plugin";
import { previewCanvasAuthorPatch } from "./authoring.js";
import { createCanvasDocuments, type CanvasDocument } from "./document.js";
import { createExampleGraph, createNode } from "./graph.js";
import { createCanvas, listCanvases, loadGraph, migrateLegacyCanvas, saveGraph } from "./storage.js";

const location = { workspaceId: "checkout", scope: "project", path: "canvases/Canvas.canva.json" } as const;
const legacyKey = 'blueprint:["host","checkout"]';

function store(initial: Record<string, unknown>): PluginStorage {
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

function workspaceFiles(): OmpWorkspaceFileActions {
  let revision = 0;
  const data = new Map<string, { content: string; modifiedAt: string; revision: string }>();
  const dirs = new Set<string>();
  return {
    async list(input) {
      if (!dirs.has(input.path)) return null;
      return [...data.keys()].filter((path) => path.startsWith(`${input.path}/`))
        .map((path) => ({ kind: "file", name: path.slice(input.path.length + 1) }));
    },
    async mkdir(input) { dirs.add(input.path); },
    async create({ path, content }) {
      if (data.has(path)) return false;
      data.set(path, { content, modifiedAt: "instant", revision: String(++revision) });
      return true;
    },
    async read({ path }) { return data.get(path) ?? null; },
    async write({ path, content, expectedRevision }) {
      const current = data.get(path);
      if (!current || current.revision !== expectedRevision) {
        return { status: "conflict", version: { cwd: "/project", path, status: "missing" } };
      }
      const next = { content, modifiedAt: "instant", revision: String(++revision) };
      data.set(path, next);
      return { status: "written", size: content.length, modifiedAt: next.modifiedAt, revision: next.revision };
    },
  };
}

async function opened(document: CanvasDocument) {
  const ready = Promise.withResolvers<void>();
  const close = document.subscribe(() => { if (!document.getSnapshot().loading) ready.resolve(); });
  if (!document.getSnapshot().loading) ready.resolve();
  await ready.promise;
  return close;
}

afterEach(() => vi.useRealTimers());

test("multiple canvases have independent files and duplicate names cannot replace a graph", async () => {
  const files = workspaceFiles();
  const a = await createCanvas(files, location.workspaceId, "Canvas");
  const b = await createCanvas(files, location.workspaceId, "Other.canva.json");
  const graphA = await loadGraph(files, { ...location, path: `canvases/${a}` });
  const graphB = await loadGraph(files, { ...location, path: `canvases/${b}` });
  await expect(createCanvas(files, location.workspaceId, "Canvas")).rejects.toThrow("画布已存在");
  expect(await listCanvases(files, location.workspaceId)).toEqual([a, b]);
  expect(graphA.graph.nodes[0]!.id).not.toBe(graphB.graph.nodes[0]!.id);
  expect(await loadGraph(files, location)).toEqual(graphA);
});

test("an invalid or missing file never becomes a writable starter graph", async () => {
  const files = workspaceFiles();
  await files.create({ ...location, content: '{"version":1,"nodes":[]}' });
  await expect(loadGraph(files, location)).rejects.toThrow("画布数据无效");
  const missing: WorkspaceFileTarget = { ...location, path: "canvases/Missing.canva.json" };
  await expect(loadGraph(files, missing)).rejects.toThrow("找不到画布文件");
  expect(await files.read(missing)).toBeNull();
});

test("moving back to the host default survives saving and reopening a canvas file", async () => {
  const files = workspaceFiles();
  await createCanvas(files, location.workspaceId, "Canvas");
  const { graph, version } = await loadGraph(files, location);
  const agent = { ...createNode("agent", { x: 0, y: 0 }), type: "agent" as const, modelId: "test/vision" };
  const selected = await saveGraph(files, location, version, { ...graph, nodes: [...graph.nodes, agent] });
  await saveGraph(files, location, selected, { ...graph, nodes: [...graph.nodes, { ...agent, modelId: null }] });
  const reopened = await loadGraph(files, location);
  expect(reopened.graph.nodes.find(({ id }) => id === agent.id)).toMatchObject({ modelId: null });
  await saveGraph(files, location, reopened.version, {
    ...reopened.graph, nodes: reopened.graph.nodes.map((node) => node.id === agent.id ? { ...node, x: 12 } : node),
  });
  expect((await loadGraph(files, location)).graph.nodes.find(({ id }) => id === agent.id)).toMatchObject({ x: 12, modelId: null });
});

test("failed migration leaves the old settings intact; retry does not duplicate a file already written", async () => {
  const files = workspaceFiles();
  const graph = createExampleGraph();
  const otherKey = 'blueprint:["host","other"]';
  const storage = store({ [legacyKey]: graph, [otherKey]: graph });
  const create = vi.spyOn(files, "create").mockRejectedValueOnce(new Error("project is read-only"));
  await expect(migrateLegacyCanvas(files, storage, "host", location.workspaceId)).rejects.toThrow("read-only");
  create.mockRestore();
  expect((await storage.get<Record<string, unknown>>()).values[legacyKey]).toEqual(graph);
  const patch = vi.spyOn(storage, "patch").mockRejectedValueOnce(new Error("config save failed"));
  await expect(migrateLegacyCanvas(files, storage, "host", location.workspaceId)).rejects.toThrow("config save failed");
  patch.mockRestore();
  const migrated = await migrateLegacyCanvas(files, storage, "host", location.workspaceId);
  expect(await listCanvases(files, location.workspaceId)).toEqual([migrated]);
  expect((await loadGraph(files, { ...location, path: `canvases/${migrated}` })).graph).toEqual(graph);
  expect((await storage.get<Record<string, unknown>>()).values).toEqual({ [legacyKey]: null, [otherKey]: graph });
});

test("migration does not overwrite another file using the migration filename", async () => {
  const files = workspaceFiles();
  const name = await createCanvas(files, location.workspaceId, "迁移画布-checkout");
  const existing = { ...location, path: `canvases/${name}` };
  const original = await loadGraph(files, existing);
  const graph = createExampleGraph();
  const migrated = await migrateLegacyCanvas(files, store({ [legacyKey]: graph }), "host", location.workspaceId);
  expect(migrated).toBe("迁移画布-checkout-2.canva.json");
  expect(await loadGraph(files, existing)).toEqual(original);
  expect((await loadGraph(files, { ...existing, path: `canvases/${migrated}` })).graph).toEqual(graph);
});

test("an edit made during a save is flushed on close and never replaced by the older write", async () => {
  vi.useFakeTimers();
  const files = workspaceFiles();
  await createCanvas(files, location.workspaceId, "Canvas");
  const pending = Promise.withResolvers<void>();
  const write = files.write.bind(files);
  files.write = async (input) => { await pending.promise; return write(input); };
  const documents = createCanvasDocuments(new AbortController().signal);
  const document = documents.get(location.path, files, location);
  const close = await opened(document);
  const base = document.getSnapshot().graph!;
  const first = { ...base, nodes: [...base.nodes, createNode("text", { x: 10, y: 20 })] };
  const latest = { ...first, nodes: [...first.nodes, createNode("boolean", { x: 60, y: 80 })] };
  document.update(first);
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getSnapshot().saving).toBe(true);
  document.update(latest);
  close();
  const reopened = documents.get(location.path, files, location);
  const closeAgain = await opened(reopened);
  expect(reopened.getSnapshot().graph).toEqual(latest);
  closeAgain();
  pending.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await loadGraph(files, location)).graph).toEqual(latest);
});

test("undo and redo save an entire Agent batch while keeping the current zoom and pan", async () => {
  vi.useFakeTimers();
  const files = workspaceFiles();
  await createCanvas(files, location.workspaceId, "Canvas");
  const document = createCanvasDocuments(new AbortController().signal).get(location.path, files, location);
  const close = await opened(document);
  const base = document.getSnapshot().graph!;
  const { graph } = previewCanvasAuthorPatch(base, JSON.stringify({
    nodes: [{ id: "result", type: "result" }],
    links: [{ from: { node: `existing:${base.nodes[0]!.id}`, port: "out" }, to: { node: "new:result", port: "in" } }],
  }));
  document.update(graph);
  const viewport = { x: 152, y: -12, zoom: 0.9 };
  document.update({ ...graph, viewport });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await loadGraph(files, location)).graph).toEqual({ ...graph, viewport });
  document.travel(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await loadGraph(files, location)).graph).toEqual({ ...base, viewport });
  expect(document.getSnapshot().canUndo).toBe(false);
  document.travel(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await loadGraph(files, location)).graph).toEqual({ ...graph, viewport });
  document.travel(false);
  document.update({ ...base, viewport, nodes: [...base.nodes, createNode("image", { x: 1, y: 1 })] });
  expect(document.travel(true)).toBe(false);
  close();
  await vi.advanceTimersByTimeAsync(1000);
});

test("a conflicting autosave preserves both the file on disk and the local draft", async () => {
  vi.useFakeTimers();
  const files = workspaceFiles();
  await createCanvas(files, location.workspaceId, "Canvas");
  const document = createCanvasDocuments(new AbortController().signal).get(location.path, files, location);
  const close = await opened(document);
  const { graph, version } = await loadGraph(files, location);
  const other = { ...graph, nodes: [...graph.nodes, createNode("image", { x: 1, y: 1 })] };
  await saveGraph(files, location, version, other);
  const local = { ...graph, nodes: [...graph.nodes, createNode("boolean", { x: 2, y: 2 })] };
  document.update(local);
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getSnapshot().saveError).toMatchObject({ conflict: true });
  expect(document.getSnapshot().graph).toEqual(local);
  await document.save(true);
  expect((await loadGraph(files, location)).graph).toEqual(other);
  await document.reload();
  expect(document.getSnapshot().graph).toEqual(other);
  expect(document.getSnapshot().canUndo).toBe(false);
  close();
});
