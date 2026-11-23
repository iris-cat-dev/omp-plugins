import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { ModelCatalog } from "./agent.js";
import { fitView, linkD, MAX_IMAGE_WIDTH, MIN_IMAGE_WIDTH, resizeImageWidth, screenToWorld, zoomAt, type Point, type Rect, type Viewport } from "./geometry.js";
import { checkImageBudget, connect, createNode, endpointKey, findPin, NODE_DEFS, type BlueprintGraph, type BlueprintNode, type Endpoint, type NodeType, type Pin } from "./graph.js";
import { imageUrl, importBlueprintImage, type BlueprintImage } from "./image.js";

const editableTypes = (Object.keys(NODE_DEFS) as NodeType[]).filter((type) => type !== "start");
const pinTypeName = { exec: "执行", text: "文本", boolean: "布尔", image: "图片" };
const boxBetween = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
const isControl = (target: HTMLElement) => !!target.closest("input,textarea,select,button,[contenteditable]");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const modulo = (n: number, d: number) => ((n % d) + d) % d;

type Selection = { nodes: Set<string>; link?: string };
const clearSelection = (): Selection => ({ nodes: new Set() });
type Gesture = { id: number; start: Point; bounds: DOMRect } & (
  | { kind: "pan"; viewport: Viewport }
  | { kind: "move"; nodes: Set<string> }
  | { kind: "select"; previous: Set<string> }
  | { kind: "wire"; pin: Endpoint }
  | { kind: "resize"; nodeId: string; width: number; aspectRatio: number }
);
type Preview = { viewport?: Viewport; nodeDelta?: Point; wire?: { pin: Endpoint; point: Point }; marquee?: Rect; imageSize?: { nodeId: string; width: number } };

const Wire = memo(function Wire({ id, type, ax, ay, bx, by, selected, active, label }: {
  id: string; type: Pin["type"]; ax: number; ay: number; bx: number; by: number; selected: boolean; active: boolean; label: string;
}) {
  const d = linkD({ x: ax, y: ay }, { x: bx, y: by });
  return <g data-bp-link={id} data-selected={selected || undefined} data-active={active || undefined} data-type={type}>
    <path className="bp-wire" d={d}/><path className="bp-wire-hit" d={d} role="button" tabIndex={0} aria-label={label}/>
  </g>;
});

interface CanvasProps {
  graph: BlueprintGraph;
  onChange(graph: BlueprintGraph, group?: string): void;
  onEndEdit(group: string): void;
  autoFit: boolean;
  fitRequest: number;
  locked: boolean;
  historyVersion: number;
  viewportLocked: boolean;
  onImportBusy(busy: boolean): void;
  toolbar: ReactNode;
  authoring?: ReactNode;
  output: ReactNode;
  activeLink?: string;
  nodeStates: ReadonlyMap<string, string>;
  generatedImages?: ReadonlyMap<string, BlueprintImage>;
  modelCatalog: ModelCatalog | null;
  onRetryModels(): void;
}

export function BlueprintCanvas({ graph, onChange, onEndEdit, autoFit, fitRequest, historyVersion, locked, viewportLocked, onImportBusy, toolbar, authoring, output, activeLink, nodeStates, modelCatalog, onRetryModels, generatedImages }: CanvasProps) {
  const canvas = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerTarget = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const space = useRef(false);
  const raf = useRef(0);
  const latest = useRef<Point | null>(null);
  const loaded = useRef(false);
  const fittedRequest = useRef(fitRequest);
  const handledHistory = useRef(historyVersion);
  const importTask = useRef<AbortController | null>(null);
  const current = useRef(graph);
  current.current = graph;
  const [preview, setPreview] = useState<Preview>({});
  const [selection, setSelection] = useState<Selection>(clearSelection);
  const [armed, setArmed] = useState<Endpoint | null>(null);
  const [menu, setMenu] = useState<{ point: Point; anchor?: Point } | null>(null);
  const [search, setSearch] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [measurements, setMeasurements] = useState({ boxes: new Map<string, { width: number; height: number }>(), pins: new Map<string, Point>() });
  const view = preview.viewport ?? graph.viewport;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeIds = JSON.stringify(graph.nodes.map(({ id }) => id));
  const pinPosition = (endpoint: Endpoint): Point | undefined => {
    const offset = measurements.pins.get(endpointKey(endpoint));
    const node = nodes.get(endpoint.nodeId);
    if (!offset || !node) return;
    const delta = selection.nodes.has(node.id) ? preview.nodeDelta : undefined;
    return { x: node.x + offset.x + (delta?.x ?? 0), y: node.y + offset.y + (delta?.y ?? 0) };
  };

  useLayoutEffect(() => {
    const layer = world.current!;
    const cards = [...layer.querySelectorAll<HTMLElement>("[data-bp-node]")];
    const measure = () => {
      const scale = layer.getBoundingClientRect().width || 1;
      const boxes = new Map<string, { width: number; height: number }>();
      const pins = new Map<string, Point>();
      for (const card of cards) {
        const id = card.dataset.bpNode!;
        const rect = card.getBoundingClientRect();
        boxes.set(id, { width: card.offsetWidth, height: card.offsetHeight });
        for (const dot of card.querySelectorAll<HTMLElement>("[data-bp-dot]")) {
          const r = dot.getBoundingClientRect();
          pins.set(endpointKey({ nodeId: id, portId: dot.dataset.bpDot! }), {
            x: (r.left + r.width / 2 - rect.left) / scale,
            y: (r.top + r.height / 2 - rect.top) / scale,
          });
        }
      }
      setMeasurements({ boxes, pins });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const card of cards) observer.observe(card);
    return () => observer.disconnect();
  }, [nodeIds]);

  const fit = () => {
    const surface = canvas.current;
    if (viewportLocked || !surface?.clientWidth || !surface.clientHeight) return false;
    const boxes: Rect[] = [];
    for (const node of current.current.nodes) {
      const size = measurements.boxes.get(node.id);
      if (!size) return false;
      boxes.push({ x: node.x, y: node.y, ...size });
    }
    onChange({ ...current.current, viewport: fitView(boxes, surface.clientWidth, surface.clientHeight) });
    return true;
  };
  useLayoutEffect(() => {
    if ((fittedRequest.current !== fitRequest || (autoFit && !loaded.current)) && fit()) {
      fittedRequest.current = fitRequest;
      loaded.current = true;
    }
  });

  const cancel = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    if (active && canvas.current?.hasPointerCapture(active.id)) canvas.current.releasePointerCapture(active.id);
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    latest.current = null;
    setPreview({});
  }, []);
  useLayoutEffect(() => {
    if (handledHistory.current === historyVersion) return;
    handledHistory.current = historyVersion;
    cancel();
    setArmed(null);
    setSelection(clearSelection());
    setMenu(null);
    setMessage("");
  }, [cancel, historyVersion]);
  useEffect(() => {
    const blur = () => { space.current = false; cancel(); setArmed(null); };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      cancelAnimationFrame(raf.current);
      importTask.current?.abort();
    };
  }, [cancel]);
  useEffect(() => {
    const surface = canvas.current!;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("textarea, .bp-menu, .bp-node-model")) return;
      event.preventDefault();
      if (viewportLocked || gesture.current) return;
      const rect = surface.getBoundingClientRect();
      const base = current.current;
      const next = zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, base.viewport, base.viewport.zoom * Math.exp(-event.deltaY * (event.deltaMode ? .07 : .0018)));
      if (next !== base.viewport) {
        surface.querySelector<HTMLElement>(".bp-model-options:popover-open")?.hidePopover();
        current.current = { ...base, viewport: next };
        onChange(current.current);
      }
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, [onChange, viewportLocked]);

  function endpointAt(target: Element | null): Endpoint | null {
    const port = target?.closest<HTMLElement>("[data-bp-port]");
    if (!port || !canvas.current?.contains(port)) return null;
    return { nodeId: port.closest<HTMLElement>("[data-bp-node]")!.dataset.bpNode!, portId: port.dataset.bpPort! };
  }
  function commitWire(from: Endpoint, to: Endpoint) {
    setArmed(null);
    try { onChange(connect(current.current, from, to)); setMessage(""); }
    catch (error) { setMessage(errorText(error)); }
  }
  function activatePort(port: Endpoint) {
    if (locked) return;
    if (!armed) { setArmed(port); setMessage(""); }
    else if (endpointKey(armed) === endpointKey(port)) setArmed(null);
    else commitWire(armed, port);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current || event.button > 1) return;
    const target = event.target as HTMLElement;
    if (target.closest(".bp-menu, .bp-node-model")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const base = { id: event.pointerId, start, bounds };
    if (event.button === 1 || space.current || (event.pointerType === "touch" && !target.closest("[data-bp-node]"))) {
      if (viewportLocked) return;
      gesture.current = { ...base, kind: "pan", viewport: graph.viewport };
    } else {
      if (locked) return;
      const port = endpointAt(target);
      const resize = target.closest("[data-bp-resize]");
      const node = target.closest<HTMLElement>("[data-bp-node]")?.dataset.bpNode;
      const link = target.closest<SVGElement>("[data-bp-link]")?.dataset.bpLink;
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (port) gesture.current = { ...base, kind: "wire", pin: port };
      else if (resize && node) {
        const card = resize.closest<HTMLElement>("[data-bp-node]")!;
        const width = card.offsetWidth;
        setSelection({ nodes: new Set([node]) });
        gesture.current = { ...base, kind: "resize", nodeId: node, width, aspectRatio: width / card.offsetHeight };
      } else if (isControl(target)) return;
      else if (node) {
        const next = new Set(additive || selection.nodes.has(node) ? selection.nodes : []);
        if (additive && next.has(node)) next.delete(node); else next.add(node);
        setSelection({ nodes: next });
        if (target.closest(".bp-node-title, .bp-image-content") && next.has(node)) gesture.current = { ...base, kind: "move", nodes: next };
      } else if (link) setSelection({ nodes: new Set(), link });
      else {
        const previous = additive ? selection.nodes : new Set<string>();
        setSelection({ nodes: previous });
        gesture.current = { ...base, kind: "select", previous };
      }
      if (!port) setArmed(null);
    }
    setMenu(null);
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    if (gesture.current) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function sample(active: Gesture, point: Point): Preview {
    const dx = point.x - active.start.x, dy = point.y - active.start.y;
    switch (active.kind) {
      case "pan": return { viewport: { ...active.viewport, x: active.viewport.x + dx, y: active.viewport.y + dy } };
      case "move": return { nodeDelta: { x: dx / graph.viewport.zoom, y: dy / graph.viewport.zoom } };
      case "resize": return { imageSize: {
        nodeId: active.nodeId,
        width: resizeImageWidth(active.width, active.aspectRatio, dx / graph.viewport.zoom, dy / graph.viewport.zoom),
      } };
      case "select": return { marquee: boxBetween(active.start, point) };
      case "wire": return { wire: { pin: active.pin, point: screenToWorld(point, graph.viewport) } };
    }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    latest.current = { x: event.clientX - active.bounds.left, y: event.clientY - active.bounds.top };
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (gesture.current === active && latest.current) setPreview(sample(active, latest.current));
    });
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const point = { x: event.clientX - active.bounds.left, y: event.clientY - active.bounds.top };
    const end = sample(active, point);
    const moved = Math.abs(point.x - active.start.x) + Math.abs(point.y - active.start.y) >= 3;
    cancel();
    if (active.kind === "pan" && moved && !viewportLocked) onChange({ ...current.current, viewport: end.viewport! });
    if (locked) return;
    if (active.kind === "move" && moved) {
      const delta = end.nodeDelta!;
      onChange({ ...current.current, nodes: current.current.nodes.map((node) => active.nodes.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node) });
    } else if (active.kind === "resize" && moved && end.imageSize!.width !== active.width) {
      const base = current.current;
      onChange({ ...base, nodes: base.nodes.map((node) => node.type === "image" && node.id === active.nodeId
        ? { ...node, displayWidth: end.imageSize!.width } : node) });
    } else if (active.kind === "select" && moved) {
      const box = boxBetween(screenToWorld(active.start, view), screenToWorld(point, view));
      const selected = new Set(active.previous);
      for (const node of graph.nodes) {
        const size = measurements.boxes.get(node.id)!;
        if (node.x <= box.x + box.width && node.x + size.width >= box.x && node.y <= box.y + box.height && node.y + size.height >= box.y) selected.add(node.id);
      }
      setSelection({ nodes: selected });
    } else if (active.kind === "wire") {
      if (!moved) activatePort(active.pin);
      else {
        const port = endpointAt(document.elementFromPoint(event.clientX, event.clientY));
        if (port) commitWire(active.pin, port);
        else setArmed(null);
      }
    }
  }
  function removeSelection() {
    const remove = new Set(graph.nodes.filter((node) => node.type !== "start" && selection.nodes.has(node.id)).map(({ id }) => id));
    if (!remove.size && !selection.link) return;
    onChange({ ...graph, nodes: graph.nodes.filter(({ id }) => !remove.has(id)), links: graph.links.filter(({ id, from, to }) => id !== selection.link && !remove.has(from.nodeId) && !remove.has(to.nodeId)) });
    setSelection(clearSelection());
    setArmed(null);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      cancel(); setArmed(null); setMenu(null); setSelection(clearSelection());
      if (menu) canvas.current?.focus();
      return;
    }
    if (isControl(target) || event.altKey) return;
    if (event.key === " ") { event.preventDefault(); space.current = true; }
    else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "f") { event.preventDefault(); fit(); }
    else if (!locked && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); removeSelection(); }
    else if ((event.key === "Enter" || event.key === " ") && !locked) {
      const link = target.closest<SVGElement>("[data-bp-link]")?.dataset.bpLink;
      if (link) { event.preventDefault(); setSelection({ nodes: new Set(), link }); }
    }
  }
  function setZoom(scale: number) {
    const surface = canvas.current!;
    const next = zoomAt({ x: surface.clientWidth / 2, y: surface.clientHeight / 2 }, graph.viewport, scale);
    if (next !== graph.viewport) onChange({ ...graph, viewport: next });
  }
  function openMenu(anchor?: Point) {
    const surface = canvas.current!;
    const point = screenToWorld(anchor ?? { x: surface.clientWidth / 2, y: surface.clientHeight / 2 }, graph.viewport);
    setSearch(""); setMenu({ point, anchor });
  }
  async function importFile(file: File, target: string | Point) {
    if (locked || importTask.current) return;
    const controller = new AbortController();
    importTask.current = controller;
    onImportBusy(true);
    setMessage("");
    try {
      const asset = await importBlueprintImage(file);
      if (controller.signal.aborted) return;
      const base = current.current;
      const updated = typeof target === "string"
        ? base.nodes.map((node) => node.id === target && node.type === "image" ? { ...node, asset } : node)
        : [...base.nodes, { ...createNode("image", target), type: "image" as const, asset }];
      checkImageBudget(updated);
      onChange({ ...base, nodes: updated });
    } catch (error) {
      if (!controller.signal.aborted) setMessage(errorText(error));
    } finally {
      importTask.current = null;
      if (!controller.signal.aborted) onImportBusy(false);
    }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files") && !event.dataTransfer.types.includes("text/uri-list")) return;
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    if (locked || importTask.current) return;
    const { files } = event.dataTransfer;
    if (files.length !== 1) { setMessage(files.length ? "每次请拖入一张图片" : "只接受本地图片文件"); return; }
    const card = (event.target as Element).closest<HTMLElement>("[data-bp-node]");
    if (card && card.dataset.kind !== "image") { setMessage("请将图片拖到空白画布或图片节点"); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    void importFile(files[0]!, card?.dataset.bpNode ?? screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, graph.viewport));
  }
  const step = (view.zoom < .5 ? 100 : 20) * view.zoom;
  const draft = preview.wire;
  const draftPin = draft && pinPosition(draft.pin);
  const draftDef = draft && findPin(nodes, draft.pin);
  const connections = new Map<string, number>();
  for (const { from, to } of graph.links) {
    connections.set(endpointKey(from), 1);
    const input = endpointKey(to);
    connections.set(input, (connections.get(input) ?? 0) + 1);
  }

  return <>
    <div className="bp-toolbar">
      <button type="button" disabled={locked} aria-expanded={!!menu} onClick={() => menu ? setMenu(null) : openMenu()}>＋ 添加节点</button>
      {toolbar}
      <div className="bp-zoom" aria-label="画布视图">
        <button type="button" disabled={viewportLocked} onClick={fit}>适应视图</button>
        <button type="button" aria-label="缩小" disabled={viewportLocked} onClick={() => setZoom(graph.viewport.zoom / 1.15)}>−</button>
        <button type="button" aria-label="重置缩放" disabled={viewportLocked} onClick={() => setZoom(1)}>{Math.round(view.zoom * 100)}%</button>
        <button type="button" aria-label="放大" disabled={viewportLocked} onClick={() => setZoom(graph.viewport.zoom * 1.15)}>＋</button>
      </div>
    </div>
    {authoring}
    <div className="bp-canvas" data-file-drop-owner="blueprint" ref={canvas} tabIndex={0} aria-label="无限画布"
      onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current) cancel(); }}
      onKeyDown={keyDown} onKeyUp={(event) => { if (event.key === " ") space.current = false; }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { space.current = false; cancel(); setArmed(null); } }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest("[data-bp-node], [data-bp-link], .bp-menu")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        if (!locked) openMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      }} onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files") && !event.dataTransfer.types.includes("text/uri-list")) return;
        event.preventDefault(); event.stopPropagation();
        const card = (event.target as Element).closest<HTMLElement>("[data-bp-node]");
        const allowed = !locked && event.dataTransfer.types.includes("Files") && (!card || card.dataset.kind === "image");
        event.dataTransfer.dropEffect = allowed ? "copy" : "none";
        setDropTarget(allowed ? (card?.dataset.bpNode ?? "") : null);
      }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={drop}>
      <div className="bp-grid" style={{ backgroundSize: `${step}px ${step}px`, transform: `translate3d(${modulo(view.x, step)}px,${modulo(view.y, step)}px,0)` }}/>
      <div className="bp-world" ref={world} style={{ transform: `translate3d(${view.x}px,${view.y}px,0) scale(${view.zoom})` }}>
        <svg className="bp-links" width="1" height="1">
          {graph.links.map((link) => {
            const a = pinPosition(link.from), b = pinPosition(link.to);
            if (!a || !b) return null;
            return <Wire key={link.id} id={link.id} type={findPin(nodes, link.from)!.type} ax={a.x} ay={a.y} bx={b.x} by={b.y}
              selected={selection.link === link.id} active={activeLink === link.id} label={`${NODE_DEFS[nodes.get(link.from.nodeId)!.type].title} 到 ${NODE_DEFS[nodes.get(link.to.nodeId)!.type].title}的连线`}/>;
          })}
          {draft && draftPin && draftDef && <path className="bp-wire bp-draft-wire" data-type={draftDef.type} d={draftDef.direction === "out" ? linkD(draftPin, draft.point) : linkD(draft.point, draftPin)}/>}
        </svg>
        {graph.nodes.map((node) => {
          const def = NODE_DEFS[node.type];
          const chosen = selection.nodes.has(node.id);
          const delta = chosen ? preview.nodeDelta : undefined;
          const changeNode = (next: BlueprintNode, group?: string) => {
            const base = current.current;
            onChange({ ...base, nodes: base.nodes.map((item) => item.id === node.id ? next : item) }, group);
          };
          const generated = generatedImages?.get(node.id);
          const hasPromptLink = connections.has(endpointKey({ nodeId: node.id, portId: "prompt" }));
          const image = node.type === "image" ? node.asset : null;
          const aspectRatio = image ? Math.max(.25, Math.min(4, image.width / image.height)) : 1.6;
          const imageWidth = node.type === "image" ? (preview.imageSize?.nodeId === node.id ? preview.imageSize.width
            : node.displayWidth ?? Math.max(MIN_IMAGE_WIDTH, Math.min(216, Math.round(288 * aspectRatio)))) : undefined;
          return <article key={node.id} className="bp-node" data-bp-node={node.id} data-kind={node.type}
            data-selected={chosen || undefined} data-status={nodeStates.get(node.id)} data-drop={dropTarget === node.id || undefined}
            style={{ transform: `translate3d(${node.x + (delta?.x ?? 0)}px,${node.y + (delta?.y ?? 0)}px,0)`, width: imageWidth }}>
            {node.type !== "image" && <header className="bp-node-title"><span>{def.title}</span><small>{def.group}</small></header>}
            <div className="bp-pins">
              {(["in", "out"] as const).map((direction) => <div className={`bp-${direction}`} key={direction}>
                {def.pins.filter((pin) => pin.direction === direction).map((pin) => {
                  const endpoint = { nodeId: node.id, portId: pin.id };
                  const key = endpointKey(endpoint);
                  const count = connections.get(key) ?? 0;
                  const label = pin.multiple ? (count ? `${pin.title} · ${count}` : `${pin.title}（可多张）`) : pin.title;
                  return <button key={pin.id} type="button" className="bp-port" data-type={pin.type} data-bp-port={pin.id}
                    aria-label={`${def.title}：${label} ${direction === "in" ? "输入" : "输出"} · ${pinTypeName[pin.type]}`}
                    aria-pressed={!!armed && endpointKey(armed) === key} disabled={locked}
                    onClick={(event) => { if (event.detail === 0) activatePort(endpoint); }}>
                    <i data-bp-dot={pin.id} data-filled={count > 0 || undefined}/>
                    {node.type !== "image" && label}
                  </button>;
                })}
              </div>)}
            </div>
            {node.type === "text" && <textarea aria-label="文本值" rows={3} disabled={locked} value={node.value}
              onChange={(event) => changeNode({ ...node, value: event.target.value }, node.id)} onBlur={() => onEndEdit(node.id)}/>}
            {node.type === "boolean" && <label className="bp-node-control"><input type="checkbox" aria-label="布尔值" checked={node.value} disabled={locked} onChange={(event) => changeNode({ ...node, value: event.target.checked })}/>{node.value ? "真" : "假"}</label>}
            {node.type === "agent" && <AgentModelPicker modelId={node.modelId} catalog={modelCatalog} disabled={locked}
              hasImages={connections.has(endpointKey({ nodeId: node.id, portId: "image" }))}
              onChange={(modelId) => changeNode({ ...node, modelId })} onRetry={onRetryModels}/>}
            {node.type === "imageGen" && <>
              {!hasPromptLink && <textarea aria-label="图像生成提示词" placeholder="描述想生成或修改的画面…" rows={3}
                disabled={locked} value={node.prompt}
                onChange={(event) => changeNode({ ...node, prompt: event.target.value }, node.id)} onBlur={() => onEndEdit(node.id)}/>}
              <div className="bp-generation">
                <small>{nodeStates.get(node.id) === "running" ? "正在生成…" : `${connections.has(endpointKey({ nodeId: node.id, portId: "image" })) ? "图生图" : "文生图"} · 主机图片生成设置`}</small>
                {generated && <>
                  <img src={imageUrl(generated)} alt="生成结果" draggable={false}/>
                  <button type="button" disabled={locked} onClick={() => {
                    const { width = 216 } = measurements.boxes.get(node.id) ?? {};
                    const copy = { ...createNode("image", { x: node.x + width + 44, y: node.y }), type: "image" as const, asset: generated };
                    const next = [...graph.nodes, copy];
                    try { checkImageBudget(next); }
                    catch (error) { setMessage(errorText(error)); return; }
                    onChange({ ...graph, nodes: next });
                    setSelection({ nodes: new Set([copy.id]) });
                    setMessage("");
                  }}>保留为图片节点</button>
                </>}
              </div>
            </>}
            {node.type === "image" && <div className="bp-image-content" style={{ aspectRatio }}>
              {image && <img src={imageUrl(image)} alt={image.name} draggable={false}/>}
              <button type="button" className={image ? "bp-image-replace" : "bp-image-empty"} disabled={locked}
                aria-label={image ? "替换图片" : "选择图片"} title={image ? "替换图片" : undefined}
                onClick={() => { pickerTarget.current = node.id; picker.current!.click(); }}>
                {image ? <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <path d="M3 6a5 5 0 0 1 8.5-2L13 5.5m0-3v3h-3M13 10a5 5 0 0 1-8.5 2L3 10.5m0 3v-3h3"/>
                </svg> : "拖入或选择图片"}
              </button>
              {image && <button type="button" className="bp-image-resize" data-bp-resize disabled={locked}
                aria-label="缩放图片" title="拖动缩放图片" onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 24 : -24;
                  const displayWidth = Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, imageWidth! + step));
                  if (displayWidth !== imageWidth) changeNode({ ...node, displayWidth });
                }}><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M4 12L12 4M8 12h4V8M4 8V4h4"/>
                </svg></button>}
            </div>}
          </article>;
        })}
      </div>
      {preview.marquee && <div className="bp-marquee" style={{ left: preview.marquee.x, top: preview.marquee.y, width: preview.marquee.width, height: preview.marquee.height }}/>}
      {dropTarget === "" && <div className="bp-drop-overlay"><strong>拖入图片</strong><span>PNG、JPEG 或 WebP · 每张最多 4 MiB</span></div>}
      {menu && !locked && <div className="bp-menu" style={menu.anchor && { left: Math.max(8, Math.min(menu.anchor.x, canvas.current!.clientWidth - 248)), top: Math.max(8, Math.min(menu.anchor.y, canvas.current!.clientHeight - 338)) }}>
        <input autoFocus aria-label="搜索节点" placeholder="搜索节点…" value={search} onChange={(event) => setSearch(event.target.value)}/>
        <div>{editableTypes.filter((type) => `${NODE_DEFS[type].title} ${type} ${NODE_DEFS[type].description}`.toLowerCase().includes(search.toLowerCase().trim())).map((type) => <button key={type} type="button"
          onClick={() => {
            const node = createNode(type, menu.point);
            onChange({ ...graph, nodes: [...graph.nodes, node] });
            setSelection({ nodes: new Set([node.id]) }); setMenu(null); canvas.current?.focus();
          }}><strong>{NODE_DEFS[type].title}</strong><small>{NODE_DEFS[type].description}</small></button>)}</div>
      </div>}
      <input hidden ref={picker} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.target.files?.[0], node = pickerTarget.current;
        event.target.value = "";
        if (file && node) void importFile(file, node);
      }}/>
      {message && <div className="bp-error" role="alert">{message}<button type="button" aria-label="关闭提示" onClick={() => setMessage("")}>×</button></div>}
    </div>
    <footer className="bp-status"><span>{graph.nodes.length} 节点 · {graph.links.length} 连线</span><span>滚轮缩放 · 空格或中键平移 · 可拖入图片</span>
      <button type="button" disabled={locked || (!selection.link && ![...selection.nodes].some((id) => nodes.get(id)?.type !== "start"))} onClick={removeSelection}>删除所选</button>
    </footer>
    {output}
  </>;
}

function AgentModelPicker({ modelId, catalog, disabled, hasImages, onChange, onRetry }: {
  modelId?: string | null;
  catalog: ModelCatalog | null;
  disabled: boolean;
  hasImages: boolean;
  onChange(modelId: string | null): void;
  onRetry(): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const models = catalog?.models ?? [];
  const current = models.find(({ id }) => id === modelId);
  const vision = models.filter(({ metadata }) => metadata?.supportsImages === true);
  const other = models.filter(({ metadata }) => metadata?.supportsImages !== true);
  const label = (model: (typeof models)[number]) => {
    const provider = model.metadata?.providerName;
    return `${model.label} · ${typeof provider === "string" ? provider : model.id.split("/")[0]}`;
  };
  const selected = current ? label(current) : modelId ?? "主机默认";
  const option = (value: string | null, text: string, unavailable = false) =>
    <button key={value} type="button" role="menuitemradio" aria-checked={(modelId ?? null) === value}
      disabled={unavailable || disabled} tabIndex={-1} onClick={() => {
        popup.current!.hidePopover();
        if ((modelId ?? null) !== value) onChange(value);
        trigger.current!.focus({ preventScroll: true });
      }}>{text}</button>;
  return <div className="bp-node-model">
    <div className="bp-model-field"><span id={`${id}-label`}>模型</span>
      <button type="button" ref={trigger} popoverTarget={id} aria-haspopup="menu" disabled={disabled}
        aria-labelledby={`${id}-label ${id}-value`} title={modelId ?? "使用工作区主机的默认模型"}>
        <span id={`${id}-value`}>{selected}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"><path d="m2 4 4 4 4-4"/></svg>
      </button>
    </div>
    <div id={id} ref={popup} popover="auto" className="bp-model-options" role="menu" aria-labelledby={`${id}-label`}
      onBeforeToggle={(event) => {
        if (event.newState !== "open") return;
        // Use viewport coordinates after canvas pan and zoom; the popover is in the top layer.
        const { left, top, bottom } = trigger.current!.getBoundingClientRect();
        const { clientWidth, clientHeight } = document.documentElement;
        const margin = 8, gap = 4, maxHeight = 260;
        const width = Math.min(290, clientWidth - 2 * margin);
        const below = clientHeight - bottom - gap - margin;
        const above = top - gap - margin;
        const opensAbove = below < maxHeight && above > below;
        Object.assign(event.currentTarget.style, {
          width: `${width}px`, left: `${Math.max(margin, Math.min(left, clientWidth - width - margin))}px`,
          top: opensAbove ? "auto" : `${bottom + gap}px`,
          bottom: opensAbove ? `${clientHeight - top + gap}px` : "auto",
          maxHeight: `${Math.min(maxHeight, opensAbove ? above : below)}px`,
        });
      }}
      onToggle={(event) => {
        if (event.newState !== "open") return;
        const menu = event.currentTarget;
        (menu.querySelector<HTMLButtonElement>('button[aria-checked="true"]:enabled') ??
          menu.querySelector<HTMLButtonElement>("button:enabled"))?.focus();
      }}
      onBlur={(event) => {
        if (event.relatedTarget && event.relatedTarget !== trigger.current &&
          !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.hidePopover();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        const { key, currentTarget } = event;
        if (key === "Tab" || key === "Escape") {
          if (key === "Escape") event.preventDefault();
          currentTarget.hidePopover();
          return;
        }
        if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
        event.preventDefault();
        const options = Array.from(currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"));
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const step = key === "ArrowDown" ? 1 : -1;
        const next = key === "Home" ? 0 : key === "End" ? options.length - 1
          : (index + step + options.length) % options.length;
        options[next]?.focus();
      }}>
      {option(null, "主机默认")}
      {modelId && !current && option(modelId, modelId, true)}
      {vision.length > 0 && <div role="group" aria-label="支持图片"><small>支持图片</small>
        {vision.map((model) => option(model.id, label(model)))}</div>}
      {other.length > 0 && <div role="group" aria-label={hasImages ? "不可用于图片输入" : "其他模型"}>
        <small>{hasImages ? "不可用于图片输入" : "其他模型"}</small>
        {other.map((model) => option(model.id, label(model), hasImages))}</div>}
    </div>
    {!catalog ? <small role="status">正在读取模型…</small>
      : catalog.error ? <button type="button" className="bp-model-retry" disabled={disabled} title={catalog.error} onClick={onRetry}>模型列表加载失败 · 重试</button>
      : modelId && !current ? <small role="status">所选模型已不可用</small>
      : current && hasImages && current.metadata?.supportsImages !== true ? <small role="status">请改选支持图片的模型</small>
      : !models.length ? <small role="status">主机未提供模型</small>
      : null}
  </div>;
}
