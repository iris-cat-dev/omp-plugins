export const styles = `
.omp-blueprint { --bp-border:color-mix(in srgb,var(--bp-fg) 14%,transparent); --bp-raised:color-mix(in srgb,var(--bp-base) 94%,var(--bp-fg)); --bp-dot:color-mix(in srgb,var(--bp-fg) 23%,transparent); display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; height:100%; overflow:hidden; color:var(--bp-fg); background:var(--bp-base); font:13px/1.5 system-ui,sans-serif; }
.omp-blueprint *, .omp-blueprint *::before, .omp-blueprint *::after { box-sizing:border-box; }
.omp-blueprint button,.omp-blueprint input,.omp-blueprint textarea { font:inherit; color:inherit; }
.omp-blueprint button { border:1px solid var(--bp-border); border-radius:6px; padding:4px 9px; min-height:26px; background:var(--bp-raised); cursor:pointer; white-space:nowrap; }
.omp-blueprint button:hover:not(:disabled) { background:color-mix(in srgb,var(--bp-raised) 91%,var(--bp-fg)); }
.omp-blueprint button:disabled { opacity:.5; cursor:default; }
.omp-blueprint :focus-visible { outline:2px solid var(--bp-accent); outline-offset:2px; }
.omp-blueprint .bp-primary { background:var(--bp-accent); color:var(--bp-accent-text); border-color:transparent; font-weight:650; }
.omp-blueprint .bp-primary:hover:not(:disabled) { background:color-mix(in srgb,var(--bp-accent) 88%,var(--bp-accent-text)); }
.omp-blueprint .bp-toolbar,.omp-blueprint .bp-status { display:flex; align-items:center; flex-wrap:wrap; gap:7px; flex:none; padding:8px 11px; background:var(--bp-raised); }
.omp-blueprint .bp-toolbar { border-bottom:1px solid var(--bp-border); }
.omp-blueprint .bp-status { border-top:1px solid var(--bp-border); font-size:12px; color:var(--bp-muted); }
.omp-blueprint .bp-status button { margin-left:auto; }
.omp-blueprint .bp-zoom { display:flex; gap:4px; margin-left:auto; }
.omp-blueprint .bp-zoom button:nth-child(3) { min-width:53px; font-variant-numeric:tabular-nums; }
.omp-blueprint .bp-muted { color:var(--bp-muted); }
.omp-blueprint .bp-canvas { position:relative; flex:1; overflow:hidden; min-height:0; isolation:isolate; touch-action:none; user-select:none; outline-offset:-2px; }
.omp-blueprint .bp-grid { position:absolute; inset:-220px 0 0 -220px; background-image:radial-gradient(circle at 1px 1px,var(--bp-dot) .85px,transparent 1.25px); pointer-events:none; background-position:220px 220px; }
.omp-blueprint .bp-world { position:absolute; top:0; left:0; width:1px; height:1px; transform-origin:0 0; }
.omp-blueprint .bp-links { position:absolute; top:0; left:0; overflow:visible; pointer-events:none; }
.omp-blueprint [data-type="exec"] { --bp-pin:color-mix(in srgb,var(--bp-fg) 78%,var(--bp-base)); }
.omp-blueprint [data-type="text"] { --bp-pin:light-dark(#176cb1,#63b9fa); }
.omp-blueprint [data-type="boolean"] { --bp-pin:light-dark(#ba3654,#f87d95); }
.omp-blueprint [data-type="image"] { --bp-pin:light-dark(#127365,#5bd2be); }
.omp-blueprint .bp-wire { fill:none; stroke:var(--bp-pin); stroke-width:2.3px; }
.omp-blueprint [data-selected="true"] > .bp-wire { stroke-width:4; filter:drop-shadow(0 0 3px var(--bp-accent)); }
.omp-blueprint [data-active="true"] > .bp-wire { stroke:var(--bp-accent); stroke-width:4; }
.omp-blueprint .bp-wire-hit { fill:none; stroke:transparent; stroke-width:16px; pointer-events:stroke; cursor:pointer; }
.omp-blueprint .bp-wire-hit:focus-visible { outline:none; stroke:color-mix(in srgb,var(--bp-accent) 40%,transparent); }
.omp-blueprint .bp-draft-wire { stroke-dasharray:5 4; }
.omp-blueprint .bp-node { position:absolute; top:0; left:0; width:216px; padding-bottom:8px; border:1px solid var(--bp-border); border-radius:9px; background:var(--bp-raised); box-shadow:0 6px 14px #0002; }
.omp-blueprint .bp-node[data-selected="true"] { outline:2px solid var(--bp-accent); }
.omp-blueprint .bp-node[data-status="running"] { box-shadow:0 0 0 3px var(--bp-accent),0 0 20px color-mix(in srgb,var(--bp-accent) 45%,transparent); }
.omp-blueprint .bp-node[data-status="failed"] { outline:2px solid var(--bp-danger); }
.omp-blueprint .bp-node[data-status="done"] header small::before { content:'✓ '; }
.omp-blueprint .bp-node[data-drop="true"] { outline:2px dashed var(--bp-accent); }
.omp-blueprint .bp-node-title { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:8px 8px 0 0; border-bottom:1px solid var(--bp-border); background:color-mix(in srgb,var(--bp-raised) 82%,var(--bp-category,#847fe8)); font-weight:700; cursor:grab; }
.omp-blueprint .bp-node-title:active { cursor:grabbing; }
.omp-blueprint .bp-node-title small { font-size:11px; font-weight:550; color:var(--bp-fg); opacity:.74; }
.omp-blueprint .bp-node[data-kind="text"], .omp-blueprint .bp-node[data-kind="boolean"] { --bp-category:#47b3db; }
.omp-blueprint .bp-node[data-kind="agent"] { --bp-category:#bd72d2; }
.omp-blueprint .bp-node[data-kind="imageGen"] { --bp-category:#55b39c; }
.omp-blueprint .bp-node[data-kind="result"] { --bp-category:#4eb991; }
.omp-blueprint .bp-pins { display:flex; justify-content:space-between; padding:6px 0 1px; gap:2px; }
.omp-blueprint .bp-in,.omp-blueprint .bp-out { display:flex; flex-direction:column; }
.omp-blueprint .bp-out { align-items:flex-end; margin-left:auto; }
.omp-blueprint button.bp-port { position:relative; display:flex; align-items:center; gap:5px; padding:3px 7px; border:none; background:transparent; font-size:11.5px; }
.omp-blueprint .bp-out .bp-port { flex-direction:row-reverse; }
.omp-blueprint .bp-port > i { display:block; width:11px; height:11px; border-radius:50%; border:2px solid var(--bp-pin); flex:none; }
.omp-blueprint .bp-port[data-type="exec"] > i { border-radius:2px; transform:rotate(45deg) scale(.84); }
.omp-blueprint .bp-port > i[data-filled="true"] { background:var(--bp-pin); }
.omp-blueprint .bp-port[aria-pressed="true"] { outline:2px solid var(--bp-pin); }
.omp-blueprint .bp-node textarea { display:block; width:calc(100% - 20px); margin:5px 10px 0; resize:none; border-radius:5px; padding:5px 7px; background:var(--bp-base); border:1px solid var(--bp-border); user-select:text; }
.omp-blueprint .bp-node-control { display:flex; align-items:center; gap:5px; padding:2px 10px; color:var(--bp-muted); }
.omp-blueprint .bp-node-model { margin:6px 9px 1px; }
.omp-blueprint .bp-node-model label { display:flex; align-items:center; gap:7px; color:var(--bp-muted); font-size:11.5px; }
.omp-blueprint .bp-node-model select { flex:1; min-width:0; width:100%; padding:4px 6px; text-overflow:ellipsis; color:var(--bp-fg); font:inherit; background:var(--bp-base); border:1px solid var(--bp-border); border-radius:5px; cursor:pointer; }
.omp-blueprint .bp-node-model select:disabled { opacity:.55; cursor:default; }
.omp-blueprint .bp-node-model small { display:block; margin-top:3px; color:var(--bp-muted); font-size:11px; }
.omp-blueprint button.bp-model-retry { margin-top:3px; padding:0; border:none; min-height:20px; color:var(--bp-muted); background:transparent; font-size:11px; }
.omp-blueprint .bp-generation { display:grid; gap:6px; margin:6px 9px 0; }
.omp-blueprint .bp-generation small { color:var(--bp-muted); font-size:11px; }
.omp-blueprint .bp-generation img { display:block; width:100%; max-height:280px; object-fit:contain; border-radius:5px; background:var(--bp-base); }
.omp-blueprint .bp-generation button { justify-self:start; font-size:11.5px; }
.omp-blueprint .bp-node[data-kind="image"] { padding:0; }
.omp-blueprint .bp-node[data-kind="image"] .bp-pins { position:absolute; z-index:2; top:50%; right:0; transform:translate(50%,-50%); padding:0; }
.omp-blueprint .bp-node[data-kind="image"] .bp-port { width:26px; justify-content:center; padding:0; }
.omp-blueprint .bp-node[data-kind="image"] .bp-port i { background:var(--bp-base); box-shadow:0 0 0 2px var(--bp-base); }
.omp-blueprint .bp-node[data-kind="image"] .bp-port i[data-filled="true"] { background:var(--bp-pin); }
.omp-blueprint .bp-image-content { position:relative; border-radius:inherit; background:var(--bp-base); cursor:grab; }
.omp-blueprint .bp-image-content:active { cursor:grabbing; }
.omp-blueprint .bp-image-content img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; border-radius:inherit; }
.omp-blueprint .bp-image-empty { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); }
.omp-blueprint button.bp-image-replace,.omp-blueprint button.bp-image-resize { position:absolute; right:5px; display:grid; place-items:center; width:26px; padding:0; opacity:0; background:#14181add; color:#fff; border-color:#ffffff50; }
.omp-blueprint button.bp-image-replace { top:5px; }
.omp-blueprint button.bp-image-resize { bottom:5px; cursor:nwse-resize; }
.omp-blueprint .bp-node:is(:hover,:focus-within,[data-selected="true"]) :is(.bp-image-replace,.bp-image-resize):not(:disabled) { opacity:1; }
.omp-blueprint .bp-node :is(.bp-image-replace,.bp-image-resize):hover:not(:disabled) { background:#242a2d; }
.omp-blueprint .bp-menu { position:absolute; top:10px; left:10px; width:min(240px,calc(100% - 20px)); max-height:calc(100% - 20px); overflow:auto; display:grid; gap:6px; padding:7px; border-radius:9px; border:1px solid var(--bp-border); background:var(--bp-raised); box-shadow:0 10px 30px #0004; }
.omp-blueprint .bp-menu input { width:100%; border:1px solid var(--bp-border); border-radius:5px; padding:6px 8px; background:var(--bp-base); }
.omp-blueprint .bp-menu button { display:flex; flex-direction:column; align-items:flex-start; width:100%; border:0; white-space:normal; text-align:left; }
.omp-blueprint .bp-menu small { color:var(--bp-muted); font-size:11.5px; }
.omp-blueprint .bp-drop-overlay { position:absolute; inset:12px; display:flex; align-items:center; justify-content:center; flex-direction:column; pointer-events:none; gap:6px; background:color-mix(in srgb,var(--bp-base) 84%,transparent); border:2px dashed var(--bp-accent); border-radius:10px; }
.omp-blueprint .bp-drop-overlay strong { font-size:18px; }
.omp-blueprint .bp-marquee { position:absolute; pointer-events:none; border:1px solid var(--bp-accent); background:color-mix(in srgb,var(--bp-accent) 15%,transparent); }
.omp-blueprint .bp-error { position:absolute; bottom:10px; left:10px; right:10px; display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 10px; border:1px solid var(--bp-danger); background:var(--bp-raised); border-radius:7px; color:var(--bp-fg); }
.omp-blueprint .bp-callout,.omp-blueprint .bp-output { padding:10px 12px; overflow-wrap:anywhere; }
.omp-blueprint .bp-callout button { margin-left:8px; }
.omp-blueprint .bp-output { border-top:1px solid var(--bp-border); max-height:31%; overflow:auto; flex:none; }
.omp-blueprint .bp-output pre { white-space:pre-wrap; font:inherit; padding:6px 9px; margin:6px 0 0; background:var(--bp-raised); border-radius:5px; }
.omp-blueprint .bp-output [role="alert"] { color:var(--bp-danger); }
`;
