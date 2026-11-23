import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { WorkspaceFileTarget } from "@omp-desktop/client";
import type { PluginClientContext, PluginSettingsPageProps, PluginWorkspacePanelProps } from "@omp-desktop/plugin";
import { runOmpAgent, type ModelCatalog } from "./agent.js";
import { buildCanvasAuthorPrompt, previewCanvasAuthorPatch, type CanvasAuthorPreview } from "./authoring.js";
import { BlueprintCanvas } from "./canvas.js";
import { createCanvasDocuments, type CanvasDocument, type CanvasDocuments } from "./document.js";
import { NODE_DEFS, type BlueprintGraph, type BlueprintNode, type Endpoint } from "./graph.js";
import { decodeGeneratedImage, type BlueprintImage } from "./image.js";
import { runBlueprint, type RunEvent, type RunResult } from "./runner.js";
import { CANVAS_DIRECTORY, CANVAS_SUFFIX, createCanvas, listCanvases, migrateLegacyCanvas } from "./storage.js";
import { styles } from "./styles.js";

const PANEL = "blueprint.canvas";
interface ActiveRun {
  controller: AbortController;
  stopAgent?: () => Promise<void>;
  stopping?: Promise<void>;
}
interface RunView {
  phase: "running" | "stopping" | "done" | "failed" | "stopped";
  events: Map<string, RunEvent>;
  results: RunResult[];
  images: Map<string, BlueprintImage>;
  current?: RunEvent;
  message?: string;
}

type AuthorView =
  | { phase: "closed" | "generating" | "stopping" }
  | { phase: "editing"; error?: string }
  | { phase: "preview"; operation: ActiveRun; base: BlueprintGraph; preview: CanvasAuthorPreview };

function stopRun(run: ActiveRun): Promise<void> {
  if (run.stopping) return run.stopping;
  run.stopping = (async () => { await run.stopAgent?.(); })();
  run.controller.abort();
  return run.stopping;
}

function AuthorPreviewDetails({ graph, addedNodes, addedLinks }: CanvasAuthorPreview) {
  const nodes = new Map(graph.nodes.map((node, index) => [node.id, { node, name: `${NODE_DEFS[node.type].title} #${index + 1}` }]));
  function portName({ nodeId, portId }: Endpoint) {
    const { node, name } = nodes.get(nodeId)!;
    return `${name} · ${NODE_DEFS[node.type].pins.find(({ id }) => id === portId)!.title}`;
  }
  function config(node: BlueprintNode) {
    switch (node.type) {
      case "text": return node.value || "（空文本）";
      case "boolean": return node.value ? "真" : "假";
      case "imageGen": return node.prompt || "（未填写提示词）";
      case "image": return "待导入图片";
      case "agent": return "主机默认模型";
    }
  }
  return <div className="bp-author-details">
    {addedNodes.length > 0 && <ul aria-label="新增节点">
      {addedNodes.map((node) => <li key={node.id}>
        <strong>{nodes.get(node.id)!.name}</strong>
        <span className="bp-muted">{config(node)}</span>
      </li>)}
    </ul>}
    {addedLinks.length > 0 && <ul aria-label="新增连线">
      {addedLinks.map(({ id, from, to }) => <li key={id}>{portName(from)} → {portName(to)}</li>)}
    </ul>}
  </div>;
}

function canvasTheme(theme: PluginWorkspacePanelProps["theme"]): CSSProperties {
  return {
    "--bp-base": theme.colors.surface0, "--bp-fg": theme.colors.foreground,
    "--bp-muted": theme.colors.foregroundMuted, "--bp-accent": theme.colors.accent,
    "--bp-accent-text": theme.colors.accentForeground, "--bp-danger": theme.colors.statusDanger,
  } as CSSProperties;
}

interface OpenCanvas {
  path: string;
  scope: WorkspaceFileTarget["scope"];
  fitOnOpen?: boolean;
}

function workspaceFileApi(ctx: PluginClientContext, hostId: string) {
  const omp = ctx.hosts.get(hostId)?.omp;
  if (!omp) throw new Error("当前工作区主机未连接");
  if (!omp.workspaceFiles) throw new Error("请更新 OMP Desktop，以启用项目画布文件");
  return omp;
}

function CanvasLibrary({ host, workspaceId, theme, ctx, onOpen }: PluginWorkspacePanelProps & {
  ctx: PluginClientContext; onOpen(file: OpenCanvas): void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [migration, setMigration] = useState<{ error?: string; filename?: string }>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    async function load() {
      const { workspaceFiles } = workspaceFileApi(ctx, host.id);
      try {
        const filename = await migrateLegacyCanvas(workspaceFiles, ctx.storage, host.id, workspaceId);
        if (current && filename) setMigration({ filename });
        else if (current) setMigration((prev) => prev.error ? {} : prev);
      } catch (error) {
        if (current) setMigration({ error: error instanceof Error ? error.message : String(error) });
      }
      if (!current) return;
      const entries = await listCanvases(workspaceFiles, workspaceId);
      if (current) setFiles(entries);
    }
    void load().catch((error: unknown) => {
      if (current) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [ctx, host.id, workspaceId, refresh]);

  async function add() {
    setCreating(true);
    setError("");
    try {
      const { workspaceFiles } = workspaceFileApi(ctx, host.id);
      const file = await createCanvas(workspaceFiles, workspaceId, name);
      ctx.signal.throwIfAborted();
      onOpen({ scope: "project", path: `${CANVAS_DIRECTORY}/${file}`, fitOnOpen: true });
    } catch (error) {
      if (!ctx.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally { setCreating(false); }
  }

  return <section className="omp-blueprint" style={canvasTheme(theme)}>
    <style>{styles}</style>
    <div className="bp-library">
      <header><div><h2>项目画布</h2><p className="bp-muted">项目根目录 / {CANVAS_DIRECTORY} /</p></div>
        <button type="button" disabled={loading || creating} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
      </header>
      <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <input aria-label="画布名称" placeholder="画布名称" value={name} onChange={(event) => setName(event.target.value)}
          disabled={loading || creating} />
        <button type="submit" className="bp-primary" disabled={!name.trim() || loading || creating}>{creating ? "正在创建…" : "新建画布"}</button>
      </form>
      {migration.error && <p role="alert">旧画布迁移失败，原数据已保留：{migration.error}</p>}
      {migration.filename && <p role="status">旧画布已迁移：{migration.filename}</p>}
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">正在读取项目画布…</p> : files?.length === 0
        ? <p className="bp-muted">这个项目还没有画布。输入名称，创建第一个画布。</p>
        : files && <ul>{files.map((file) => <li key={file}>
          <button type="button" disabled={creating} title={file}
            onClick={() => onOpen({ scope: "project", path: `${CANVAS_DIRECTORY}/${file}` })}>
            <strong>{file.slice(0, -CANVAS_SUFFIX.length)}</strong><span className="bp-muted">{file}</span>
          </button>
        </li>)}</ul>}
    </div>
  </section>;
}

function CanvasFile({ host, workspaceId, theme, ctx, file, onBack, documents, ...props }: PluginWorkspacePanelProps & {
  ctx: PluginClientContext; file: OpenCanvas; onBack?: () => void; documents: CanvasDocuments;
}) {
  const [binding, setBinding] = useState<{ key: string; document: CanvasDocument } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setBinding(null);
    setError("");
    async function open() {
      const omp = workspaceFileApi(ctx, host.id);
      const workspace = await omp.workspaces.ref(workspaceId).refresh();
      if (!current) return;
      const root = file.scope === "project" ? workspace?.projectRootPath : workspace?.workspaceDirectory;
      if (!root) throw new Error("找不到画布文件所在的目录");
      const key = JSON.stringify([host.id, root, file.path]);
      setBinding({ key, document: documents.get(key, omp.workspaceFiles, { workspaceId, scope: file.scope, path: file.path }) });
    }
    void open().catch((error: unknown) => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [ctx, documents, host.id, workspaceId, file.path, file.scope, attempt]);
  if (binding) return <BlueprintPanel key={binding.key} {...props} host={host} workspaceId={workspaceId} theme={theme}
    ctx={ctx} canvasDocument={binding.document} file={file} onBack={onBack}/>;
  return <section className="omp-blueprint" style={canvasTheme(theme)}>
    <style>{styles}</style>
    {error
      ? <div className="bp-callout" role="alert">{error}
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
        {onBack && <button type="button" onClick={onBack}>返回项目画布</button>}</div>
      : <p className="bp-callout" role="status">正在读取画布…</p>}
  </section>;
}

function CanvasWorkspace(props: PluginWorkspacePanelProps & { ctx: PluginClientContext; documents: CanvasDocuments }) {
  const [selected, setSelected] = useState<OpenCanvas | null>(null);
  if (props.filePath) return <CanvasFile key={props.filePath} {...props} file={{ path: props.filePath, scope: "workspace" }}/>;
  if (selected) return <CanvasFile key={selected.path} {...props} file={selected} onBack={() => setSelected(null)}/>;
  return <CanvasLibrary {...props} onOpen={setSelected}/>;
}

function BlueprintPanel({ host, workspaceId, theme, ctx, canvasDocument, file, onBack }: PluginWorkspacePanelProps & {
  ctx: PluginClientContext; canvasDocument: CanvasDocument; file: OpenCanvas; onBack?: () => void;
}) {
  const { graph, loading, loadVersion, loadError, saving, dirty, saveError, canUndo, canRedo, historyVersion } =
    useSyncExternalStore(canvasDocument.subscribe, canvasDocument.getSnapshot);
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const activeRun = useRef<ActiveRun | null>(null);
  const activeAuthor = useRef<ActiveRun | null>(null);
  const [authorView, setAuthorView] = useState<AuthorView>({ phase: "closed" });
  const [instruction, setInstruction] = useState("");
  const [fitRequest, setFitRequest] = useState(0);
  const authorLocked = authorView.phase !== "closed" && authorView.phase !== "editing";
  const [runView, setRunView] = useState<RunView | null>(null);
  const running = runView?.phase === "running" || runView?.phase === "stopping";
  const hasAgent = graph?.nodes.some(({ type }) => type === "agent");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const setImportBusy = useCallback((busy: boolean) => { importLock.current = busy; setImporting(busy); }, []);
  const changeGraph = useCallback((next: BlueprintGraph, group?: string) => {
    if (!activeAuthor.current) canvasDocument.update(next, group);
  }, [canvasDocument]);
  const endEdit = useCallback((group: string) => canvasDocument.endGroup(group), [canvasDocument]);

  useEffect(() => {
    if (!hasAgent) return;
    let current = true;
    setModelCatalog(null);
    async function loadModels(): Promise<ModelCatalog> {
      const omp = ctx.hosts.get(host.id)?.omp;
      if (!omp) throw new Error("当前工作区主机未连接");
      const workspace = await omp.workspaces.ref(workspaceId).refresh();
      if (!workspace?.workspaceDirectory) throw new Error("当前工作区目录不可用");
      return omp.providers.listModels("omp", { cwd: workspace.workspaceDirectory });
    }
    void loadModels().then((result) => {
      if (current) setModelCatalog(result);
    }, (cause: unknown) => {
      if (current) setModelCatalog({ error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { current = false; };
  }, [ctx, host.id, workspaceId, hasAgent, catalogVersion]);

  useEffect(() => {
    const abandon = () => {
      const runs = [activeRun.current, activeAuthor.current];
      activeRun.current = null;
      activeAuthor.current = null;
      for (const run of runs) if (run) {
        void stopRun(run).catch((cause: unknown) => console.warn("Blueprint Agent stop was not confirmed", cause));
      }
    };
    ctx.signal.addEventListener("abort", abandon, { once: true });
    return () => { ctx.signal.removeEventListener("abort", abandon); abandon(); };
  }, [ctx.signal]);

  async function generatePreview() {
    if (!graph || authorView.phase !== "editing" || !instruction.trim()
      || activeAuthor.current || activeRun.current || importLock.current || ctx.signal.aborted) return;
    const base = canvasDocument.getSnapshot().graph;
    if (!base) return;
    const operation: ActiveRun = { controller: new AbortController() };
    activeAuthor.current = operation;
    const { signal } = operation.controller;
    setAuthorView({ phase: "generating" });
    try {
      const omp = ctx.hosts.get(host.id)?.omp;
      if (!omp) throw new Error("当前工作区主机未连接");
      const reply = await runOmpAgent(omp, workspaceId, {
        prompt: buildCanvasAuthorPrompt(base, instruction.trim()), images: [],
      }, signal, (_id, stop) => { operation.stopAgent = stop; });
      if (activeAuthor.current !== operation || signal.aborted) return;
      setAuthorView({ phase: "preview", operation, base, preview: previewCanvasAuthorPatch(base, reply) });
    } catch (cause) {
      if (activeAuthor.current !== operation || signal.aborted) return;
      activeAuthor.current = null;
      setAuthorView({ phase: "editing", error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      operation.stopAgent = undefined;
    }
  }

  async function cancelGeneration() {
    const operation = activeAuthor.current;
    if (authorView.phase !== "generating" || !operation || operation.stopping) return;
    setAuthorView({ phase: "stopping" });
    let error: string | undefined;
    try { await stopRun(operation); }
    catch { error = "已取消画布生成；请在工作区检查智能体"; }
    if (activeAuthor.current !== operation) return;
    activeAuthor.current = null;
    setAuthorView({ phase: "editing", error });
  }

  function finishPreview(apply: boolean) {
    if (authorView.phase !== "preview" || activeAuthor.current !== authorView.operation) return;
    activeAuthor.current = null;
    if (!apply) {
      setAuthorView({ phase: "editing" });
      return;
    }
    if (canvasDocument.getSnapshot().graph !== authorView.base) {
      setAuthorView({ phase: "editing", error: "画布已变化，请重新生成预览" });
      return;
    }
    const { graph, addedNodes } = authorView.preview;
    canvasDocument.update(graph);
    setRunView(null);
    setInstruction("");
    setAuthorView({ phase: "closed" });
    if (addedNodes.length) setFitRequest((request) => request + 1);
  }

  async function run() {
    if (!graph || activeAuthor.current || activeRun.current || importLock.current || ctx.signal.aborted) return;
    const operation: ActiveRun = { controller: new AbortController() };
    activeRun.current = operation;
    const { signal } = operation.controller;
    setRunView({ phase: "running", events: new Map(), results: [], images: new Map() });
    try {
      await runBlueprint(graph, {
        signal,
        runAgent: async (input, onCreated) => {
          const omp = ctx.hosts.get(host.id)?.omp;
          if (!omp) throw new Error("当前工作区主机未连接");
          try {
            return await runOmpAgent(omp, workspaceId, input, signal, (id, stop) => {
              operation.stopAgent = stop;
              onCreated(id);
            });
          } finally { operation.stopAgent = undefined; }
        },
        generateImage: async ({ prompt, images }) => {
          const omp = ctx.hosts.get(host.id)?.omp;
          if (!omp) throw new Error("当前工作区主机未连接");
          const result = await omp.images.generate({ prompt, images: images.map(({ data, mimeType }) => ({ data, mimeType })) }, { signal });
          signal.throwIfAborted();
          return decodeGeneratedImage(result);
        },
        onEvent: (event) => setRunView((prev) => prev && ({
          ...prev, current: event, events: new Map(prev.events).set(event.nodeId, event),
        })),
        onResult: (result) => setRunView((prev) => prev && ({ ...prev, results: [...prev.results, result] })),
        onImage: (nodeId, image) => setRunView((prev) => prev && ({ ...prev, images: new Map(prev.images).set(nodeId, image) })),
      });
      if (activeRun.current === operation && !signal.aborted) setRunView((prev) => prev && ({ ...prev, phase: "done" }));
    } catch (cause) {
      if (activeRun.current === operation && !signal.aborted) setRunView((prev) => prev && ({
        ...prev, phase: "failed", message: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      if (activeRun.current === operation && !operation.stopping) activeRun.current = null;
    }
  }

  async function stop() {
    const operation = activeRun.current;
    if (!operation || operation.stopping) return;
    setRunView((prev) => prev && ({ ...prev, phase: "stopping" }));
    let message = "已停止";
    try { await stopRun(operation); }
    catch { message = "画布已停止运行；请在工作区检查智能体"; }
    if (activeRun.current !== operation) return;
    activeRun.current = null;
    setRunView((prev) => prev && ({ ...prev, phase: "stopped", message }));
  }

  function travelHistory(redo: boolean) {
    if (activeAuthor.current || activeRun.current || importLock.current) return;
    if (canvasDocument.travel(redo)) setRunView(null);
  }

  function reload() {
    const current = canvasDocument.getSnapshot();
    if (activeAuthor.current || current.saving || importLock.current || activeRun.current) return;
    if (current.dirty && !window.confirm("重新读取并丢弃未保存的修改？")) return;
    setRunView(null);
    void canvasDocument.reload();
  }
  const nodeStates = new Map<string, string>();
  for (const event of runView?.events.values() ?? []) if (event.state !== "running" || runView?.phase === "running") nodeStates.set(event.nodeId, event.state);
  const activeLink = running ? runView?.current?.linkId : undefined;
  const sendsImage = graph?.links.some(({ to }) => to.portId === "image");
  const failedNode = runView?.phase === "failed" && graph?.nodes.find(({ id }) => id === runView.current?.nodeId);
  const runMessage = runView?.message ?? (runView?.phase === "done" ? (runView.results.length || runView.images.size ? "运行完成" : "运行结束，无结果")
    : runView?.phase === "stopping" ? "正在停止…" : "正在运行…");
  const busy = importing || running;
  const saveStatus = saveError ? (saveError.conflict ? "保存冲突" : "保存失败")
    : saving ? "正在保存…" : dirty ? "等待自动保存…" : "已自动保存";
  return <section className="omp-blueprint" style={canvasTheme(theme)} onKeyDown={(event) => {
    const target = event.target as Element;
    if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)
      || target.closest("input,textarea,select,[contenteditable]")) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && !(key === "y" && event.ctrlKey && !event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    travelHistory(event.shiftKey || key === "y");
  }}>
    <style>{styles}</style>
    <div className="bp-document" aria-label="画布文件">
      {onBack && <button type="button" disabled={busy || authorLocked || saving} onClick={async () => {
        await canvasDocument.save(true);
        if (!canvasDocument.getSnapshot().dirty) onBack();
      }}>← 项目画布</button>}
      <span title={file.path}>{file.path}</span>
    </div>
    {loading ? <p className="bp-callout" role="status">正在读取画布…</p>
      : !graph ? <div className="bp-callout" role="alert">{loadError}<button type="button" onClick={reload}>重新读取</button></div>
      : <BlueprintCanvas key={loadVersion} graph={graph} autoFit={file.fitOnOpen === true && loadVersion === 1} fitRequest={fitRequest} historyVersion={historyVersion}
        locked={busy || authorLocked} viewportLocked={authorLocked} onChange={changeGraph} onEndEdit={endEdit}
        onImportBusy={setImportBusy} nodeStates={nodeStates} activeLink={activeLink}
        modelCatalog={modelCatalog} onRetryModels={() => setCatalogVersion((version) => version + 1)}
        generatedImages={runView?.images}
        toolbar={<>
          <button type="button" aria-expanded={authorView.phase !== "closed"} disabled={busy || authorLocked} onClick={() =>
            setAuthorView({ phase: authorView.phase === "closed" ? "editing" : "closed" })}>智能体生成</button>
          <button type="button" title="撤销（⌘/Ctrl+Z）" aria-keyshortcuts="Meta+Z Control+Z"
            disabled={!canUndo || busy || authorLocked} onClick={() => travelHistory(false)}>撤销</button>
          <button type="button" title="重做（⌘/Ctrl+Shift+Z）" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
            disabled={!canRedo || busy || authorLocked} onClick={() => travelHistory(true)}>重做</button>
          <button type="button" disabled={!dirty || saving || saveError?.conflict}
            onClick={() => void canvasDocument.save(true)}>保存</button>
          {running
            ? <button type="button" className="bp-primary" disabled={runView.phase === "stopping"} onClick={() => void stop()}>停止</button>
            : <button type="button" className="bp-primary" disabled={busy || authorLocked} onClick={() => void run()}>▶ 运行</button>}
          {sendsImage && <span className="bp-muted">运行时，连入的图片会随提示词发送给模型</span>}
          <span className="bp-muted" role="status">{importing && "正在导入… · "}{saveStatus}</span>
        </>}
        authoring={authorView.phase !== "closed" && <section className="bp-author" aria-label="智能体生成">
          {authorView.phase === "editing" ? <form onSubmit={(event) => { event.preventDefault(); void generatePreview(); }}>
            <label>
              <strong>描述要生成的节点或流程</strong>
              <textarea autoFocus rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)}
                placeholder="例如：新增一个图像生成节点，用画布上的两张图片作参考" />
            </label>
            {authorView.error && <div role="alert">{authorView.error}</div>}
            <div className="bp-author-actions">
              <button type="submit" className="bp-primary" disabled={busy || !instruction.trim()}>生成预览</button>
              <span className="bp-muted">请求和画布摘要（含节点文本和提示词）将发送给工作区主机的默认模型。不附带画布图片。</span>
            </div>
          </form> : authorView.phase === "preview" ? <>
            <strong role="status">新增 {authorView.preview.addedNodes.length} 个节点、{authorView.preview.addedLinks.length} 条连线</strong>
            <AuthorPreviewDetails {...authorView.preview}/>
            <div className="bp-author-actions">
              <button type="button" className="bp-primary" onClick={() => finishPreview(true)}>应用到画布</button>
              <button type="button" onClick={() => finishPreview(false)}>丢弃预览</button>
            </div>
          </> : <div className="bp-author-actions">
            <strong role="status">{authorView.phase === "stopping" ? "正在取消生成…" : "正在生成预览…"}</strong>
            <button type="button" disabled={authorView.phase === "stopping"} onClick={() => void cancelGeneration()}>取消生成</button>
          </div>}
        </section>}
        output={<>
          {saveError && <div className="bp-callout" role="alert">
            自动保存失败：{saveError.message}
            {!saveError.conflict && <button type="button" disabled={!dirty} onClick={() => void canvasDocument.save(true)}>重试保存</button>}
            <button type="button" disabled={busy || authorLocked} onClick={reload}>重新读取</button>
          </div>}
          {runView && <div className="bp-output">
            <strong role={runView.phase === "failed" ? "alert" : "status"}>{failedNode ? `${NODE_DEFS[failedNode.type].title}：` : ""}{runMessage}</strong>
            {runView.current?.agentId && <div className="bp-muted">智能体 · {runView.current.agentId}</div>}
            {runView.results.map(({ nodeId, text }, index) => <pre key={`${nodeId}:${index}`}>{text || "（空文本）"}</pre>)}
          </div>}
        </>}
      />}
  </section>;
}

function CanvasSettings({ mode, theme }: PluginSettingsPageProps) {
  return <section aria-label="无限画布设置" style={{ color: theme.colors.foreground, font: "14px/1.5 system-ui, sans-serif" }}>
    <strong>画布内容在工作区编辑</strong>
    <p style={{ margin: "4px 0 0", color: theme.colors.foregroundMuted }}>
      {mode === "manage" && "启用插件后，"}在工作区的命令中心选择「打开无限画布」，或点击文件树中的 .canva.json 文件。新画布保存在项目的 canvases/ 目录。
    </p>
  </section>;
}

export default function setup(ctx: PluginClientContext) {
  ctx.addSettingsPage({ id: "blueprint.settings", title: "无限画布", icon: "Blocks", Component: CanvasSettings });
  if (ctx.mode !== "active") return;
  const documents = createCanvasDocuments(ctx.signal);
  const flushHidden = () => { if (document.visibilityState === "hidden") documents.flush(); };
  document.addEventListener("visibilitychange", flushHidden);
  ctx.own(() => document.removeEventListener("visibilitychange", flushHidden));
  ctx.addWorkspacePanel({ id: PANEL, title: "无限画布", icon: "Blocks", context: "workspace", fileSuffix: CANVAS_SUFFIX,
    Component: (props) => <CanvasWorkspace key={JSON.stringify([props.host.id, props.workspaceId])} {...props} ctx={ctx} documents={documents}/> });
  ctx.addCommandCenterItem({ id: "blueprint.open", title: "打开无限画布", icon: "Blocks", keywords: ["infinite canvas", "blueprint"], context: "workspace", onSelect: ({ openPanel }) => openPanel(PANEL) });
}
