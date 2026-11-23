import type { OmpWorkspaceFileActions, WorkspaceFileTarget, WorkspaceFileVersion } from "@omp-desktop/client";
import type { BlueprintGraph } from "./graph.js";
import { GraphConflictError, loadGraph, saveGraph } from "./storage.js";

const SAVE_DELAY = 400;
const HISTORY_LIMIT = 50;
type Content = Pick<BlueprintGraph, "nodes" | "links">;
interface CanvasSnapshot {
  graph: BlueprintGraph | null;
  loading: boolean;
  loadVersion: number;
  loadError: string;
  saving: boolean;
  dirty: boolean;
  saveError: { message: string; conflict: boolean } | null;
  canUndo: boolean;
  canRedo: boolean;
  historyVersion: number;
}

const sameContent = (a: Content, b: Content) => a.nodes === b.nodes && a.links === b.links;
function sameGraph(a: BlueprintGraph | null, b: BlueprintGraph | null) {
  return a === b || (a !== null && b !== null && sameContent(a, b)
    && a.viewport.x === b.viewport.x && a.viewport.y === b.viewport.y && a.viewport.zoom === b.viewport.zoom);
}

export class CanvasDocument {
  #snapshot: CanvasSnapshot = { graph: null, loading: true, loadVersion: 0, loadError: "",
    saving: false, dirty: false, saveError: null, canUndo: false, canRedo: false, historyVersion: 0 };
  #version: WorkspaceFileVersion | undefined;
  #saved: BlueprintGraph | null = null;
  #past: Content[] = [];
  #future: Content[] = [];
  #group: string | undefined;
  #listeners = new Set<() => void>();
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly files: OmpWorkspaceFileActions, private readonly location: WorkspaceFileTarget,
    private readonly signal: AbortSignal, private readonly release: () => void) {}

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    if (!this.#started) void this.reload();
    return () => {
      this.#listeners.delete(listener);
      // A remount in the same commit can reuse the document without interrupting its save.
      if (!this.#listeners.size) queueMicrotask(() => {
        if (this.#listeners.size) return;
        void this.save();
        this.#releaseIfIdle();
      });
    };
  };

  #publish(next: Partial<CanvasSnapshot>) {
    const snapshot = { ...this.#snapshot, ...next };
    snapshot.dirty = snapshot.graph !== null && !sameGraph(snapshot.graph, this.#saved);
    if (!snapshot.dirty && !snapshot.saveError?.conflict) snapshot.saveError = null;
    snapshot.canUndo = this.#past.length > 0;
    snapshot.canRedo = this.#future.length > 0;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #releaseIfIdle() {
    const { loading, saving, dirty } = this.#snapshot;
    if (!this.#listeners.size && !loading && !saving && !dirty) this.release();
  }

  async reload() {
    const { loading, saving, loadVersion } = this.#snapshot;
    if (this.signal.aborted || saving || (this.#started && loading)) return;
    this.#started = true;
    this.cancelTimer();
    this.#past.length = this.#future.length = 0;
    this.#group = undefined;
    this.#publish({ graph: null, loading: true, loadVersion: loadVersion + 1, loadError: "", saveError: null });
    try {
      const { graph, version } = await loadGraph(this.files, this.location);
      if (this.signal.aborted) return;
      this.#version = version;
      this.#saved = graph;
      this.#publish({ graph, loading: false });
    } catch (error) {
      if (!this.signal.aborted) this.#publish({ loading: false, loadError: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#releaseIfIdle();
    }
  }

  update(next: BlueprintGraph, group?: string) {
    const { graph } = this.#snapshot;
    if (!graph || this.signal.aborted || sameGraph(graph, next)) return;
    if (!sameContent(graph, next)) {
      if (!group || group !== this.#group) {
        this.#past.push({ nodes: graph.nodes, links: graph.links });
        if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
      }
      this.#group = group;
      this.#future.length = 0;
    }
    this.#publish({ graph: next });
    this.#scheduleSave();
  }

  endGroup(group: string) {
    if (this.#group === group) this.#group = undefined;
  }

  travel(redo: boolean) {
    const { graph, historyVersion } = this.#snapshot;
    if (!graph || this.signal.aborted) return false;
    const from = redo ? this.#future : this.#past, to = redo ? this.#past : this.#future;
    const content = from.pop();
    if (!content) return false;
    to.push({ nodes: graph.nodes, links: graph.links });
    this.#group = undefined;
    this.#publish({ graph: { ...graph, ...content }, historyVersion: historyVersion + 1 });
    this.#scheduleSave();
    return true;
  }

  cancelTimer() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #scheduleSave() {
    this.cancelTimer();
    const { saving, dirty, saveError } = this.#snapshot;
    if (saving || !dirty || saveError || this.signal.aborted) return;
    if (!this.#listeners.size) { void this.save(); return; }
    this.#timer = setTimeout(() => { void this.save(); }, SAVE_DELAY);
  }

  async save(explicit = false) {
    const { graph, dirty, saving, saveError } = this.#snapshot;
    if (!graph || !this.#version || !dirty || saving || this.signal.aborted || (saveError && (saveError.conflict || !explicit))) return;
    this.cancelTimer();
    this.#publish({ saving: true, saveError: null });
    try {
      this.#version = await saveGraph(this.files, this.location, this.#version, graph);
      this.#saved = graph;
      this.#publish({ saving: false });
      this.#scheduleSave();
    } catch (error) {
      this.#publish({ saving: false, saveError: { message: error instanceof Error ? error.message : String(error), conflict: error instanceof GraphConflictError } });
    } finally {
      this.#releaseIfIdle();
    }
  }
}

export interface CanvasDocuments {
  get(key: string, files: OmpWorkspaceFileActions, location: WorkspaceFileTarget): CanvasDocument;
  flush(): void;
}

export function createCanvasDocuments(signal: AbortSignal): CanvasDocuments {
  const documents = new Map<string, CanvasDocument>();
  signal.addEventListener("abort", () => {
    for (const document of documents.values()) document.cancelTimer();
    documents.clear();
  }, { once: true });
  return {
    get(key, files, location) {
      let document = documents.get(key);
      if (!document) {
        document = new CanvasDocument(files, location, signal, () => {
          if (documents.get(key) === document) documents.delete(key);
        });
        documents.set(key, document);
      }
      return document;
    },
    flush() { for (const document of documents.values()) void document.save(); },
  };
}
