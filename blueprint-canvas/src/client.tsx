import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@omp-desktop/plugin";
import { runOmpAgent, type ModelCatalog } from "./agent.js";
import { BlueprintCanvas } from "./canvas.js";
import { NODE_DEFS, type BlueprintGraph } from "./graph.js";
import { decodeGeneratedImage, type BlueprintImage } from "./image.js";
import { runBlueprint, type RunEvent, type RunResult } from "./runner.js";
import { graphKey, loadGraph, saveGraph, type DocumentState } from "./storage.js";
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

function stopRun(run: ActiveRun): Promise<void> {
  if (run.stopping) return run.stopping;
  run.stopping = run.stopAgent?.() ?? Promise.resolve();
  run.controller.abort();
  return run.stopping;
}

function BlueprintPanel({ host, workspaceId, theme, ctx }: PluginWorkspacePanelProps & { ctx: PluginClientContext }) {
  const key = graphKey(host.id, workspaceId);
  const [document, setDocument] = useState<DocumentState | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [readyVersion, setReadyVersion] = useState(-1);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const saveLock = useRef(false);
  const importLock = useRef(false);
  const activeRun = useRef<ActiveRun | null>(null);
  const [runView, setRunView] = useState<RunView | null>(null);
  const running = runView?.phase === "running" || runView?.phase === "stopping";
  const dirty = document !== null && document.graph !== document.baseline;
  const hasAgent = document?.graph.nodes.some(({ type }) => type === "agent");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const setImportBusy = useCallback((busy: boolean) => { importLock.current = busy; setImporting(busy); }, []);
  const changeGraph = useCallback((graph: BlueprintGraph) => {
    setDocument((prev) => prev && { ...prev, graph });
  }, []);

  useEffect(() => {
    let current = true;
    setError("");
    void loadGraph(ctx.storage, key).then((next) => {
      if (current) setDocument(next);
    }, (cause: unknown) => {
      if (current) { setDocument(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    }).finally(() => { if (current) setReadyVersion(loadVersion); });
    return () => { current = false; };
  }, [ctx, key, loadVersion]);

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
      const run = activeRun.current;
      if (!run) return;
      activeRun.current = null;
      void stopRun(run).catch((cause: unknown) => console.warn("Blueprint Agent stop was not confirmed", cause));
    };
    ctx.signal.addEventListener("abort", abandon, { once: true });
    return () => { ctx.signal.removeEventListener("abort", abandon); abandon(); };
  }, [ctx.signal]);

  async function run() {
    if (!document || activeRun.current || saveLock.current || importLock.current || ctx.signal.aborted) return;
    const operation: ActiveRun = { controller: new AbortController() };
    activeRun.current = operation;
    const { signal } = operation.controller;
    setRunView({ phase: "running", events: new Map(), results: [], images: new Map() });
    try {
      await runBlueprint(document.graph, {
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

  async function save() {
    if (!document || saveLock.current || importLock.current || activeRun.current || !dirty) return;
    saveLock.current = true;
    setSaving(true); setError("");
    try {
      const { graph, baseline } = document;
      const saved = await saveGraph(ctx.storage, key, baseline, graph);
      setDocument({ graph: saved, baseline: saved });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function reload() {
    if (dirty && !window.confirm("重新读取并丢弃未保存的修改？")) return;
    setRunView(null);
    setLoadVersion((version) => version + 1);
  }
  const variables = {
    "--bp-base": theme.colors.surface0, "--bp-fg": theme.colors.foreground,
    "--bp-muted": theme.colors.foregroundMuted, "--bp-accent": theme.colors.accent,
    "--bp-accent-text": theme.colors.accentForeground, "--bp-danger": theme.colors.statusDanger,
  } as CSSProperties;
  const nodeStates = new Map<string, string>();
  for (const event of runView?.events.values() ?? []) if (event.state !== "running" || runView?.phase === "running") nodeStates.set(event.nodeId, event.state);
  const activeLink = running ? runView?.current?.linkId : undefined;
  const sendsImage = document?.graph.links.some(({ to }) => to.portId === "image");
  const failedNode = runView?.phase === "failed" && document?.graph.nodes.find(({ id }) => id === runView.current?.nodeId);
  const runMessage = runView?.message ?? (runView?.phase === "done" ? (runView.results.length || runView.images.size ? "运行完成" : "运行结束，无结果")
    : runView?.phase === "stopping" ? "正在停止…" : "正在运行…");
  return <section className="omp-blueprint" style={variables}>
    <style>{styles}</style>
    {readyVersion !== loadVersion ? <p className="bp-callout" role="status">正在读取画布…</p>
      : !document ? <div className="bp-callout" role="alert">{error}<button type="button" onClick={reload}>重新读取</button></div>
      : <BlueprintCanvas key={loadVersion} graph={document.graph} autoFit={!document.baseline} locked={saving || importing || running}
        viewportLocked={saving} onChange={changeGraph} onImportBusy={setImportBusy} nodeStates={nodeStates} activeLink={activeLink}
        modelCatalog={modelCatalog} onRetryModels={() => setCatalogVersion((version) => version + 1)}
        generatedImages={runView?.images}
        toolbar={<>
          <button type="button" disabled={!dirty || saving || importing || running} onClick={() => void save()}>保存</button>
          {running
            ? <button type="button" className="bp-primary" disabled={runView.phase === "stopping"} onClick={() => void stop()}>停止</button>
            : <button type="button" className="bp-primary" disabled={saving || importing} onClick={() => void run()}>▶ 运行</button>}
          {sendsImage && <span className="bp-muted">运行时，连入的图片会随提示词发送给模型</span>}
          <span className="bp-muted" role="status">{importing ? "正在导入…" : saving ? "正在保存…" : dirty ? "未保存" : "已保存"}</span>
        </>}
        output={<>
          {error && <div className="bp-callout" role="alert">{error}<button type="button" disabled={saving || importing || running} onClick={reload}>重新读取</button></div>}
          {runView && <div className="bp-output">
            <strong role={runView.phase === "failed" ? "alert" : "status"}>{failedNode ? `${NODE_DEFS[failedNode.type].title}：` : ""}{runMessage}</strong>
            {runView.current?.agentId && <div className="bp-muted">智能体 · {runView.current.agentId}</div>}
            {runView.results.map(({ nodeId, text }, index) => <pre key={`${nodeId}:${index}`}>{text || "（空文本）"}</pre>)}
          </div>}
        </>}
      />}
  </section>;
}

export default function setup(ctx: PluginClientContext) {
  if (ctx.mode !== "active") return;
  ctx.addWorkspacePanel({ id: PANEL, title: "无限画布", icon: "Blocks", context: "workspace", Component: (props) => (
    <BlueprintPanel key={graphKey(props.host.id, props.workspaceId)} {...props} ctx={ctx}/>
  ) });
  ctx.addCommandCenterItem({ id: "blueprint.open", title: "打开无限画布", icon: "Blocks", keywords: ["infinite canvas", "blueprint"], context: "workspace", onSelect: ({ openPanel }) => openPanel(PANEL) });
}
