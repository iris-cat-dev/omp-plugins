# Desktop pet

An optional folder-installed plugin for [OMP Desktop](https://github.com/iris-cat-dev/omp), with the pink fluffy kitten Iris, a local pet library, and custom-pet authoring. Desktop ships neither the pet implementation nor its assets. Install a compatible folder package and its pet assets through [Plugin management](https://github.com/iris-cat-dev/omp/blob/main/docs/features/tools-and-plugins.md#plugin-management-and-native-commands) first. The pet requires the native app; see the [Wallpaper plugin](../wallpaper/README.md) and [host appearance settings](https://github.com/iris-cat-dev/omp/blob/main/docs/features/appearance.md) for backgrounds and themes.

## Contents

- [Enable and interact](#enable-and-interact)
- [Task status and freshness](#task-status-and-freshness)
- [Iris animation](#iris-animation)
- [Create and import pets](#create-and-import-pets)
- [Independent custom bubbles](#independent-custom-bubbles)
- [Build and authoring integration](#build-and-authoring-integration)
- [Data preservation](#data-preservation)
- [Qualification and historical evidence](docs/qualification.md)

## Enable and interact

Open the pet installation's **Configure** page under **Settings → Plugins**. Enable it to show Iris in a separate transparent always-on-top window. Size (**Small**, **Medium**, **Large**), library, import/refresh, and creation settings remain available while disabled. Disabling preserves configuration, the creation draft, and model selection.

Pet packages, selection, visibility, size, and position are local to this computer. A phone/tablet connected to its daemon receives neither pet assets nor overlay state. The authoring conversation is an ordinary OMP conversation, not an asset-sync channel. Multiple main windows share one pet.

On macOS, enabling does not activate the pet window or steal keyboard focus. It remains visible across Spaces, including fullscreen apps. On launch, an enabled pet waits for initial service startup and restoration of main-interface appearance, saved layout, and navigation. Offline, disabled-daemon-management, and startup-error screens also satisfy readiness. Pre-readiness changes use the latest settings; disabling prevents a startup flash. Native overlay support depends on the installed runtime; see [qualification](docs/qualification.md#runtime-support-boundary).

- **Drag** the kitten to move it; dragging starts at 4 logical screen pixels of movement and stays within display work-area boundaries. Position, size, selection, and visibility persist locally. Transparent space passes mouse input through to other apps.
- **Click** the kitten to pet it, showing a happy pose, soft squash/rebound, and floating hearts. Dragging does not pet it.
- **Click the status bubble** to restore OMP and open the task needing attention, or simply open the app when nothing is pending.
- **Right-click** to hide or reset position. Minimizing OMP does not hide it. Quitting detaches only after in-flight activity publications settle, then follows existing desktop/daemon shutdown settings.

The status bubble stays near the upper-left and scales with the pet. Its nearest corner stays anchored as captions/counts change; long captions grow left and ellipsize within available space. Main-window zoom does not scale the pet. Viewport changes refresh layout and pointer hit bounds. Language and font updates are reflected in the companion.

## Task status and freshness

Only main conversations contribute status, counts, menus, and click targets. Subagents are excluded even with missing parents or different workspaces; independent main conversations sharing one workspace remain separate tasks.

Task names follow workspace tabs: primary conversations use renamed workspace titles, while other independent conversations retain their own names. Renames refresh immediately without new activity. Native context menus shorten names after 20 displayed characters and add an ellipsis without splitting composed characters or altering the full title/click target.

Connected hosts supply real task state. Permissions outrank errors, unread completions, and running work. Neither task state nor animation triggers model calls.

On daemons supporting directory revisions, completed directory reads determine freshness, not window arrival order. Older reports cannot restore acknowledged/archived tasks. Identity is host plus conversation, not a shared workspace entry. Closing a publishing window does not discard known pending work while another window remains connected to that host.

## Iris animation

While the highest-priority task runs, Iris displays a random five-second work caption every 30–60 seconds:

- `智商变高了！`
- `不想上班...`
- `大佬！`
- `wooo！wow！`
- `Tibo什么时候重置...`

The two complaints use a wistful working face, the other three a happy face, without changing task status. Captions stop as soon as work ends, a higher-priority task needs attention, the host disconnects, or the pet is dragged/petted. Idle/non-running tasks never cause captions. Custom pets are unchanged. Reduced motion keeps the selected expression static.

Iris has six registered 24-frame, 12-fps action sequences with continuous local breathing/sway. Idle actions run two seconds and rest six; waiting/completed/blocked states also pause quietly. Working/carried loops continue outside temporary reactions. Only the working face remains wistful; others are relaxed/happy. Blinks use short tapered eyelids. System reduced-motion preference keeps the pose static.

## Create and import pets

**Create with OMP** opens an independent local authoring workspace and normal OMP conversation with selected model, Thinking, and approval mode. Model/mode/thinking/feature selections are local to authoring, not defaults for ordinary conversations. Describe the pet in Settings or attach references in chat.

Creation requires a connected local Desktop-managed host and the plugin's `agents.create` permission, including while the plugin is disabled. Model controls read provider data with `agents.events`. Review new permissions after updating an existing installation. Opening Settings reads creation context without creating an authoring workspace; the workspace is prepared only when you choose **Create with OMP**.

Creation copies the plugin's [`hatch-pet` skill](assets/skills/hatch-pet/SKILL.md) into the authoring workspace's `.omp/skills/hatch-pet/`, alongside installation helpers and an optional Iris reference; it is not a global skill. The skill uses the [configured image-generation tool](https://github.com/iris-cat-dev/omp/blob/main/docs/features/tools-and-plugins.md#image-generation-with-references) to create a coherent animation atlas, a complete per-pet bubble profile, and `pet.json`, then runs the plugin's conversion/install helper. Keep the plugin and its runtime dependencies installed while using the helper. It uses bundled Electron in Node mode without launching the GUI. New image-based authoring requires the complete profile before conversion. Ordinary animation and dialogue make no model calls.

After installation, **Refresh** and select the new pet. **Import folder** accepts completed resource packages, distinct from installing executable plugins. Imports contain only a validated manifest and transparent PNG data, never executable scripts or HTML. Images are limited to **20 MiB** and **4096 × 4096** pixels. Plugin-provided Iris and existing custom packages are not replaced. Import does not execute extra files, automatically select the new pet, or enable it.

The skill's default 1536 × 1024 atlas uses 128 × 128 cells and twelve frames per action; Iris's 3840 × 960 atlas instead uses 160 × 160 cells and twenty-four frames. Both are supported. The actual image and manifest must describe the same grid. The plugin's converter accepts PNG, JPEG, and WebP, removes green from opaque chroma-key images, and preserves existing transparency and green characters. It does not resize, retile, or invent frames; contact-sheet and motion-preview inspection remain necessary to catch visual fragments or inconsistent poses.

The five required animation states are `idle`, `running`, `needs_input`, `ready`, and `blocked`; `dragging` is optional for imported packages. See the skill's [manifest example](assets/skills/hatch-pet/SKILL.md#write-petjson) and [manifest validator](src/manifest-schema.ts).

## Independent custom bubbles

Each newly authored pet supplies its own `bubble.appearance` and all eight `bubble.states`: `idle`, `offline`, `running`, `needs_input`, `ready`, `blocked`, `dragging`, and `petted`. See the plugin's [hatch-pet manifest example](assets/skills/hatch-pet/SKILL.md#write-petjson) for the full schema.

- Appearance controls colors, speech/rounded/thought shape, typography, padding, corner radius, maximum width, and fade/pop/no entry animation. Layout stays within the companion viewport; reduced-motion preferences disable entry motion.
- Each state owns plain-text messages, initial delay, visible duration, and delay before repetition. An empty message list explicitly means silence; it never falls back to Iris's dialogue.
- Duration zero persists until a real state/event change. Repeat delay zero means no repetition. Petting is a one-shot event and cannot repeat; a timed response can outlast the physical gesture. Dragging and relevant task changes interrupt stale responses.
- Unchanged activity snapshots, task renames, and secondary-task updates do not restart the current message clock. The real highest-priority task still controls attention and click targets; persona text does not change task status.

Profiles are bounded, strictly validated data: hex colors and enumerated style choices, not executable CSS, HTML, scripts, or model-call instructions. Runtime dialogue is local and makes no API requests. Plugin-provided Iris and existing imported version-1 packages without profiles retain their prior behavior without rewriting stored packages. Existing authoring workspaces keep their copied skill and scripts; open a new **Create with OMP** workspace to use the plugin-owned instructions and installer. Disabling or removing the plugin does not delete these ordinary workspaces or conversations.

## Build and authoring integration

Build the plugin from an initialized Desktop checkout root, with this repository at `plugins/`:

```sh
npm run build --workspace=@omp-desktop/plugin-desktop-pet
```

The package includes `dist`, `src`, and `assets` (excluding source tests); its `files: ["dist", "src", "assets", ...]` packaging includes the skill and compiled installer. The core Desktop `skills/` catalog does not contain `hatch-pet`, and neither Desktop nor remote-backend packages carry the pet resources or this skill.

`PetLibraryOptions.pluginDirectory` is the installed plugin package root; the creator resolves both its skill and `dist/cjs/install-pet.js` from that directory. The helpers execute the plugin installer with bundled Electron in Node mode and `OMP_ELECTRON_USER_DATA_DIR`, keeping the existing local `pets/` library. They do not launch Desktop's GUI or daemon, invoke the removed `--desktop-pet-install` command, or participate in upgrade/quit cleanup. Existing completed packages without profiles remain importable, while new image-based authoring requires a complete bubble profile.

Distribute the plugin with its runtime dependencies, including `sharp` and its native libraries for the target OS/architecture. Verify the helper with the target bundled runtime rather than assuming a development Node run establishes native compatibility. Removing the plugin leaves ordinary authoring workspaces and conversations intact; helpers still require the installed plugin. Open a new authoring workspace to use updated copied instructions and scripts.

Directory loading uses the service's `setup` and `manage` exports. Both register the same library/creation RPCs, and the host injects `OMP_ELECTRON_USER_DATA_DIR` into both workers. The service initializes its own `PetLibrary` and loads the selection directly rather than calling its not-yet-active RPC. It returns validated PNG data URLs without a pet-specific resource route, and uses wire overlay leases with `pet.overlay-action` and `pet.overlay-position`; it does not pass functions or lease objects across IPC, and stopping waits for release.

The client uses only public plugin context APIs and shared modules, not a fixed builtin or an extra host configure call. Shared settings publication remains independent of the pet switch. Activity publication obtains actual window identity through authorized `client.identity` and reuses the application's workspace-directory subscription without taking it over. Update the host runtime as well as the plugin when adopting this integration; plugin reload alone cannot add the host environment or `client.identity` support. Generic host lifecycle, navigation, and native authorization contracts remain in the [host plugin design](https://github.com/iris-cat-dev/omp/blob/main/docs/desktop-plugin-system-design.md).

Implementation entry points: [service](src/service.ts), [local library](src/library.ts), [authoring workspace](src/creation-workspace.ts), [resource manifest](src/manifest.ts), and [installer](src/install-pet.ts).

## Data preservation

Old `settings.pet`, plugin-private configuration, original pet resources and IDs, workspace roots, and ordinary authoring agents remain saved. They do not install or execute the plugin. Explicit same-ID folder reinstallation retains record configuration and generation; a local installation starts disabled. Existing `pet.enabled` restoration input is not converted into an enabled selection: execution requires an actual trusted, enabled installation. Removal preserves configuration but stops execution, and reinstallation does not automatically restore a removed selection.

If the plugin offers data import, it must validate the source and report failures explicitly. Keep old restoration input; damaged data must not be replaced with an empty library or default Iris. User resources and workspaces are not deleted by the default-distribution cutover.
