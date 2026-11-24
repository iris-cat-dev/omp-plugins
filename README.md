# omp-plugins

Optional folder-installed plugins and source examples for [OMP Desktop](https://github.com/iris-cat-dev/omp).

- [agent-speed/](agent-speed/README.md): native local monitor, floating orbs, history, pricing, and leaderboards.
- [wallpaper/](wallpaper/README.md): wallpaper selection, loading, and transparency.
- [desktop-pet/](desktop-pet/README.md): desktop pet, authoring workflow, and bundled Iris assets.
- [qqbot/](qqbot/README.md): QQ gateway, account UI, agent conversations, image quotas, and external game integration.
- [schedules/](schedules/README.md): scheduled agents, existing-agent heartbeats, run history, and multi-host management.
- [blueprint-canvas/](blueprint-canvas/README.md): Infinite Canvas workspace panel for runnable node graphs and image-fed agent turns.
- [ask-notifier/](ask-notifier/README.md): optional Windows QQ reminders for questions, plan reviews, and other decisions awaiting your input, with phone, Pad, or both-device delivery.
- `examples/`: Catppuccin, Linear attachments, and the local counter plugin.

## Build in a Desktop checkout

Desktop pins this repository as its root `plugins/` Git submodule and includes the plugin packages in its npm workspaces. The shared SDK, compiler, and host implementation remain in Desktop's `packages/plugin`; plugin builds use that checkout rather than a second SDK copy. Keep exact `@omp-desktop/plugin` peer versions aligned with that package (currently `0.7.3`), and update Desktop's root `package-lock.json` when plugin workspaces or their dependencies change.

From the Desktop checkout root:

```sh
git submodule update --init --recursive
npm install
npm run build:plugin
node plugins/agent-speed/build.mjs
node scripts/build-desktop-plugins.mjs plugins/wallpaper plugins/desktop-pet
node plugins/qqbot/build.mjs
node plugins/schedules/build.mjs
npx tsc --noEmit -p packages/plugin/tsconfig.examples.json
```

Source-plugin examples use an id-only `omp-plugin.json` and import `@omp-desktop/plugin` or `@omp-desktop/plugin/server`. Load them from `plugins/examples/<name>` in Desktop.

Plugin callbacks access the host through `context.omp`; React surfaces use `useOmp()`. The client SDK exposes `OmpApi`, `OmpAgent`, `createOmpApi()` and `createOmpClient()`. Host-launched plugin workers/helpers and the Desktop development launcher use `OMP_ELECTRON_USER_DATA_DIR` to select the user-data directory. Plugin hosts and callers must use these names together; obsolete aliases are not provided.

Commit and push changes here before updating Desktop's submodule pointer. Generated `dist/` and `node_modules/` directories stay out of this repository.

## License

AGPL-3.0-or-later, except components carrying their own license; `qqbot/LICENSE` retains its MIT license.