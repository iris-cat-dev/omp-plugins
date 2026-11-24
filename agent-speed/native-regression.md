# Agent Speed native regression

These commands run from an [OMP Desktop checkout](https://github.com/iris-cat-dev/omp) root, with this repository initialized as its `plugins/` submodule and workspace dependencies installed. The shared SDK, main/preload build and host integration smoke remain in Desktop. See [Install and open](README.md#install-and-open) and [Desktop development and verification](https://github.com/iris-cat-dev/omp/blob/main/docs/development.md#verification-policy) for the surrounding host setup and policy.

The qualifications below retain their original platform and evidence boundaries. Folder-plugin integration on macOS covers owned IPC, rendered surfaces and lifecycle; Windows surface/input checks are separate. A surface smoke does not qualify an installer, upgrade or full packaged application. No new acceptance run is recorded by this documentation migration.

## Folder-plugin integration

```bash
npm run build --workspace=@omp-desktop/plugin-agent-speed
npm run build:main:compiled --workspace=@omp-desktop/desktop
node packages/desktop/e2e/agent-speed-plugin-smoke.cjs
```

This smoke installs the actual folder package through production main-preload IPC in an isolated mini-electron profile. It grants `native.main`, checks disabled/startup gating, native menu and RPC dispatch, and observes 100 output tokens over a measured 1000 ms in the real collector. It visits dashboard, orb, history, settings, 38-currency pricing, orb preview, board and performance-card documents. Disable/re-enable must close and restore owned resources while preserving saved preferences. Clear-data disables the installation; enabling it again must keep cleared usage empty and leave legacy originals intact. Quit must close open native windows and revoke documents/menu entries.

The script prints an evidence directory containing native PNGs, numeric reports and runtime logs. It uses synthetic numeric sessions, not provider credentials or model calls. macOS proves the owned IPC, rendered surfaces and lifecycle; Windows compositor, file-dialog and physical-input qualification remains separate. The monitor retains its original Windows-specific icon font, which can produce fallback squares on macOS.

## Windows surface qualification

```bash
npm run build --workspace=@omp-desktop/plugin-agent-speed
npm run build:main --workspace=@omp-desktop/desktop
node plugins/agent-speed/e2e/local-monitor-smoke.cjs
```

This Windows surface smoke copies the configured official mini-electron runtime into an owned temporary profile and uses the real product controller, both production preloads, HTML, collector, and worker with synthetic numeric OMP files. It exercises a transparent orb plus separate dashboard/history/settings panels: original instruments and dark/porcelain pixels, nine title themes, four effect levels, measured-completion/peak feedback, independent project scopes, eight-orb capacity, hidden/click-through recovery, native pinning/menu/geometry, full and selected-date CSV, 38 offline currencies, worker failure, missing sources and cold reopen.

The native file-dialog driver modifies only the unique filename edit and Save button of a dialog owned by that disposable runtime; it never changes the system clipboard or another application's controls. Hit-policy checks use owned native pointer IPC plus Win32 point routing between two owned runtime processes, with both interactive and passthrough controls. Two desktop pixels are sampled only over an owned solid backdrop to check transparent corners and a still-visible instrument; the observer uses physical screen coordinates in its own subprocess. Positioning uses owned `BrowserWindow.setBounds`, real begin/end-drag commands and persisted reopen, not physical mouse dragging. Reduced motion uses a reversible fixture on the owned renderer's cached `MediaQueryList`, exercising its real change listener and art path without requiring CDP or changing operating-system preferences.

Native compositor captures check original-sized transparent viewports, alpha-zero corners and painted instrument pixels, not just text or DOM attributes. GPU observations also include the detached shared thumbnail owner; static thumbnails must not evict live orb contexts. These checks do not establish the original project's CPU/GPU benchmark budgets.

No provider credentials, daemon, or model requests are used. This is monitor-surface qualification, not a complete installer, upgrade, or packaged-application acceptance run.

### Native input and clipping

Programmatic DOM clicks do not qualify native panel input. When the user's mouse and focus must remain available, use a fresh, non-input Win32 desktop without switching to it, isolated profiles, exact owned HWNDs and directed native mouse messages. Observe trusted DOM events, actual navigation and persisted preferences; check caption `WM_NCHITTEST = HTCAPTION` separately from control `HTCLIENT`. A geometry setter is not an OS caption-drag test. Report physical dragging and current-desktop hardware routing as untested when no physical input is permitted.

For settings clipping regressions, use the real 800×680 viewport and native wheel messages to reveal the complete martial-arts title-card caption, `name-mode` and `title-theme`. Require the actual `settings-scroller` to have `overflow-y: auto` and a viewport-bounded client height; an overflowing body or an `overflow: hidden` ancestor is not a replacement scroll port. Check trusted pointer sweeps leave ordinary UI labels unselected while existing attribution/license selection remains possible without clipboard access.

### Orb navigation and selectors

For Orb-tab navigation, observe actual shared WebGL context/program identities across repeated General↔Orb switches. A zero-lease preview pool is cached but idle: hidden previews must not draw, returning to Orb must not recreate the context or recompile its programs, and independent live orbs must continue rendering. Renderer teardown destroys instances before disposing the shared cache. Distinguish native-driver round-trip time from click-to-frame timing and hardware presentation latency; invalid or negative raw RAF timestamp differences are not usable latency samples.

Selector acceptance requires a pointer-opened, visibly painted option list and a pointer-selected real option. A focus ring or a value changed only with the keyboard does not qualify popup expansion. Cover all Monitor and History selectors, all 38 currencies including off-screen options, Escape/outside cancellation, reopening, live state arriving while a list is open, saved values and subsequent navigation. Bind the run to the extracted installer's exact compiled modules and verify that the in-document picker creates no separate native popup window. Physical-mouse runs need explicit user permission and must abort on unrelated input, foreground changes or foreign-window occlusion; never target the user's installed application.

### Collector redraw

For redraw regressions, drive the production collector with owned numeric JSONL, including a large backfilled file and many project scopes. Measure incoming state messages and option/ladder mutations separately from trusted click-to-frame callbacks; do not substitute a prebuilt snapshot or infer hardware input latency from those callbacks. Also visit the lazily rendered Cost/Orb/Data pages, change a currency, persist it, and verify a real project filter reduces the displayed usage. A worker publication is one scoped batch: an obsolete scope entry must not discard valid sibling entries from the same poll.

## Evidence and focused regressions

Set `PASEO_DESKTOP_SMOKE_ARTIFACT_DIR` to retain the Windows smoke's numeric report and native compositor PNGs elsewhere. Focused filesystem/pricing/lifecycle/CSV/resource regressions are under [`src/monitor`](src/monitor); run that directory only, not the full repository suite. Migration regressions are in [`src/migration.test.ts`](src/migration.test.ts); generic native-entry lifecycle/authorization regressions remain in Desktop's [`packages/desktop/src/plugins/native-entry.test.ts`](https://github.com/iris-cat-dev/omp/blob/main/packages/desktop/src/plugins/native-entry.test.ts). The pricing tests use deterministic transports; a separate real public-data exercise is needed to qualify live network availability.
