# Wallpaper

An optional folder-installed plugin for [OMP Desktop](https://github.com/iris-cat-dev/omp), providing a local candidate library, file/URL backgrounds, transparency controls, and load recovery. It is not included in the default application.

## Set a wallpaper

Install a compatible wallpaper package through **Settings → Plugins → Discover** first; see [Plugin management](https://github.com/iris-cat-dev/omp/blob/main/docs/features/tools-and-plugins.md#plugin-management-and-native-commands). Then open that installation's **Configure**, enable it, choose **File**, and use **Add files** with the system picker. Configuration remains available while disabled. Ctrl/Shift multi-selection and files from different folders work. Candidates persist across restarts; originals remain where they are. Adding a candidate does not apply it: select a card manually.

Media, candidate records, and Desktop selection stay on this computer. Pairing a phone/tablet does not copy them. A Web browser can independently configure URL wallpaper in browser-local settings; that is not Desktop synchronization. Remote connections, project switching, and pairing do not transmit local resources, paths, selections, or playback authorization. For connecting clients see [Remote hosts](https://github.com/iris-cat-dev/omp/blob/main/docs/remote-hosts.md) and [Deployment](https://github.com/iris-cat-dev/omp/blob/main/docs/deployment.md).

With Wallpaper enabled, the home screen hides decorative-motion controls and its poster overlay so media stays visible. Turning it off restores the control and previous value. Project/conversation shortcuts remain available either way.

## Candidate management and formats

The candidate grid is continuously scrollable and virtualized, not paginated or limited to 48 entries. Covers are static, including video covers. There is no rotation. Candidate IDs and their order are preserved.

**Manage** selects/removes multiple records, including offscreen candidates, without deleting source files. Removing the active candidate restores theme background rather than choosing another. Re-adding the same file makes a new candidate and does not reactivate the old selection. Missing/undecodable files remain listed: restore and retry or remove the record.

Accepted file extensions: `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `avif`, `mp4`, `m4v`, `webm`, `mov`, `ogv`. Playback depends on the runtime and codec; Desktop does not transcode. **URL** accepts HTTP(S) images/videos and detects type from pathname, including signed video URLs with query strings. Query strings and fragments are preserved.

**Last verified Windows mini-electron 0.1.28 package:** its media-player factory is not implemented. Valid MP4 and WebM files fail with “error creating media player” even over HTTP; changing a filename or codec does not repair that missing player. Images remain usable. Newer Windows runtime and video-wallpaper support require actual Windows artifact verification. This is a version-specific historical result, not qualification of every newer runtime.

## Transparency and loading

**Interface transparency** spans 0–100%. At 0% regular surfaces use solid theme backgrounds; increasing reveals media, and 100% removes sidebar/titlebar/composer veils. Slider changes preview without persisting every intermediate value. Dragging preserves Settings mount, focus, and scroll position.

Base workspaces become transparent only after media loads, including newly selected tabs. Each window waits for its current image/video to be truly ready; a successful load in another window does not establish readiness. With transparency `p`, media alpha is `p`, normal-panel alpha is `1-p`, and the base canvas becomes fully transparent only after readiness. Floating menus, palettes, tooltips, dialogs, notifications, and model lists stay opaque. Text still follows theme: match wallpaper/theme or reduce transparency if contrast suffers. Load errors appear in Wallpaper settings and retain normal surfaces. Source switching or load recovery preserves focused inputs and pet-creation drafts. Background/theme/transparency changes do not rebuild conversations or lose input identity, focus, selection, drafts, or scroll position. Selected media and committed transparency persist across restarts.

Local media uses app-scoped opaque IDs rather than whole-file renderer IPC. The mini-electron 0.1.28 protocol adapter buffers each response before delivery, so that runtime does not provide end-to-end media streaming. Files use durable authorized resource references; playback URLs and handles are temporary and must not be persisted.

Windows/Linux native caption controls use a transparent overlay on the HTML titlebar, not an opaque patch; the top resize strip remains inside titlebar bounds and aligned with the right edge when restored/maximized. Model lists and Thinking/Fast/Context window settings remain opaque, theme-matched, and readable over media.

## Persistence and integration

This plugin owns candidate-library behavior, file/URL selection, configuration, and retry UI. It publishes background intent to the generic host. The background root, appearance policy that preserves the business component tree, authorized native media route, and resource-lifecycle mechanisms remain host responsibilities; see the [host plugin design](https://github.com/iris-cat-dev/omp/blob/main/docs/desktop-plugin-system-design.md) and [native runtime contracts](https://github.com/iris-cat-dev/omp/blob/main/docs/packaging.md#native-runtime-contracts).

For installed plugins, committed configuration is authoritative in local main-process/profile storage through scoped SDK storage. Field patches carry revisions. Transparency previews stay in the current window; commits broadcast to other windows. Renderer drafts and media readiness remain local. Integration reuses document epochs, independent background/preview revisions, bounded preview leases, Range reads, and acquire/release semantics. Releasing or failing one window must not interrupt media reads already accepted in another.

Original configuration, candidate IDs, revisions, and import markers remain saved without automatically mounting a background. Explicit installation, authorization, and enablement are required. Old `wallpaperEnabled` restoration input does not become an enabled plugin selection; actual trusted installation, plugin enablement, background selection, and media readiness are separate conditions. Removal preserves configuration but stops execution; reinstallation does not automatically restore a removed background selection. Removing a candidate still never deletes the original file.

If data import is offered, validate the source and report failures explicitly. Preserve old restoration input and existing data rather than replacing damaged data with an empty library. Plugin-specific migration and storage are not a second host settings authority.

## Build and qualification

Build from an initialized Desktop checkout root with this repository at `plugins/`:

```sh
npm run build --workspace=@omp-desktop/plugin-wallpaper
```

The existing external-package builder also accepts this package explicitly:

```sh
node scripts/build-desktop-plugins.mjs plugins/wallpaper
```

The builder clears the selected package's `dist` and preserves an already staged release SDK; `build:server` selects the development SDK instead. Build/deployment machinery stays documented by the [host development guide](https://github.com/iris-cat-dev/omp/blob/main/docs/development.md).

A successful build does not qualify native input or media support. Use the [plugin regression requirements and historical qualification evidence](docs/qualification.md), including known version-specific limits and paused acceptance scenarios. Source entry points are [plugin declaration](src/builtin.ts), [client](src/client.tsx), and [controller](src/controller.ts).
