# omp-plugins

Builtin plugins and source examples for [OMP Desktop](https://github.com/iris-cat-dev/omp).

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

## QQ message completion

QQ conversations share a serial queue per peer. Timeline sequence numbers belong to an epoch; idle resume or history reconstruction can renumber them. The gateway resets its sequence and revision caches when the epoch changes and recognizes submitted inputs by `clientMessageId`, including lower-sequence events. Completing a reply releases the next queued message immediately. Static delivery errors reject the input with the original error instead of silently reporting success; the generated reply remains in the Desktop conversation.

The persisted `lastDeliveredSequence` is a processed timeline watermark, not a Tencent delivery receipt. Failed replies are not automatically retried.

## License

AGPL-3.0-or-later, except components carrying their own license; `qqbot/LICENSE` retains its MIT license.