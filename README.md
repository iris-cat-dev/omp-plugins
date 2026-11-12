# omp-plugins

Optional folder-installed plugins and source examples for [OMP Desktop](https://github.com/iris-cat-dev/omp).

- `agent-speed/`: live agent output speed.
- `wallpaper/`: wallpaper selection and rendering.
- `desktop-pet/`: desktop pet, authoring workflow, and bundled Iris assets.
- `qqbot/`: QQ gateway, account UI, and agent conversations.
- `examples/`: Catppuccin, Linear attachments, and the local counter plugin.

## Build in a Desktop checkout

Desktop pins this repository as its root `plugins/` Git submodule and includes the four plugin packages in its npm workspaces. The shared SDK, compiler, and host implementation remain in Desktop's `packages/plugin`; plugin builds use that checkout rather than a second SDK copy.

From the Desktop checkout root:

```sh
git submodule update --init --recursive
npm install
npm run build:desktop-plugins
npx tsc --noEmit -p packages/plugin/tsconfig.examples.json
```

Source-plugin examples use an id-only `omp-plugin.json` and import `@omp-desktop/plugin` or `@omp-desktop/plugin/server`. Load them from `plugins/examples/<name>` in Desktop.

Plugin callbacks access the host through `context.omp`; React surfaces use `useOmp()`. The client SDK exposes `OmpApi`, `OmpAgent`, `createOmpApi()` and `createOmpClient()`. The pet authoring helper and Desktop development launcher use `OMP_ELECTRON_USER_DATA_DIR` to select the user-data directory. Plugin hosts and callers must use these names together; obsolete aliases are not provided.

Commit and push changes here before updating Desktop's submodule pointer. Generated `dist/` and `node_modules/` directories stay out of this repository.

## Desktop pet authoring

The Desktop pet package owns [`assets/skills/hatch-pet/SKILL.md`](desktop-pet/assets/skills/hatch-pet/SKILL.md). Desktop's core `skills/` catalog does not contain it. **Create with OMP** copies it into the new workspace's `.omp/skills/hatch-pet/`, alongside the installation helpers and optional Iris reference.

Build the plugin from the Desktop checkout root:

```sh
npm run build --workspace=@omp-desktop/plugin-desktop-pet
```

`PetLibraryOptions.pluginDirectory` is the installed plugin package root; the creator resolves both its skill and `dist/cjs/install-pet.js` from that directory. The helpers execute the plugin installer with bundled Electron in Node mode and `OMP_ELECTRON_USER_DATA_DIR`, keeping the existing local `pets/` library. They do not launch Desktop's GUI or invoke `--desktop-pet-install`. New image-based authoring requires a complete bubble profile; existing completed packages without profiles remain importable.

Distribute the plugin with its runtime dependencies, including `sharp` and its native libraries for the target OS/architecture. The converter supports PNG/JPEG/WebP, keys opaque green backgrounds, and preserves already-transparent artwork. Verify the helper with the target bundled runtime rather than assuming a development Node run establishes native compatibility. Removing the plugin leaves ordinary authoring workspaces and conversations intact; helpers still require the installed plugin. Open a new authoring workspace to use updated copied instructions and scripts.

## QQ message completion

QQ conversations share a serial queue per peer. Timeline sequence numbers belong to an epoch; idle resume or history reconstruction can renumber them. The gateway resets its sequence and revision caches when the epoch changes and recognizes submitted inputs by `clientMessageId`, including lower-sequence events. Completing a reply releases the next queued message immediately. Static delivery errors reject the input with the original error instead of silently reporting success; the generated reply remains in the Desktop conversation.

The persisted `lastDeliveredSequence` is a processed timeline watermark, not a Tencent delivery receipt. Failed replies are not automatically retried.

## License

AGPL-3.0-or-later, except components carrying their own license; `qqbot/LICENSE` retains its MIT license.