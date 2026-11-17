# omp-plugins

Optional folder-installed plugins and source examples for [OMP Desktop](https://github.com/iris-cat-dev/omp).

- `agent-speed/`: conversation output speed, native local monitor, floating orbs and leaderboards.
- `wallpaper/`: wallpaper selection and rendering.
- `desktop-pet/`: desktop pet, authoring workflow, and bundled Iris assets.
- `qqbot/`: QQ gateway, account UI, and agent conversations.
- `schedules/`: scheduled agents, existing-agent heartbeats, run history, and multi-host management.
- `ask-notifier/`: optional Windows QQ/WeChat reminders for pending agent questions, using native self-device sends without mouse or keyboard automation.
- `examples/`: Catppuccin, Linear attachments, and the local counter plugin.

## Build in a Desktop checkout

Desktop pins this repository as its root `plugins/` Git submodule and includes the plugin packages in its npm workspaces. The shared SDK, compiler, and host implementation remain in Desktop's `packages/plugin`; plugin builds use that checkout rather than a second SDK copy. Keep exact `@omp-desktop/plugin` peer versions aligned with that package (currently `0.7.1`), and update Desktop's root `package-lock.json` when plugin workspaces or their dependencies change.

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

Plugin callbacks access the host through `context.omp`; React surfaces use `useOmp()`. The client SDK exposes `OmpApi`, `OmpAgent`, `createOmpApi()` and `createOmpClient()`. The pet authoring helper and Desktop development launcher use `OMP_ELECTRON_USER_DATA_DIR` to select the user-data directory. Plugin hosts and callers must use these names together; obsolete aliases are not provided.

Commit and push changes here before updating Desktop's submodule pointer. Generated `dist/` and `node_modules/` directories stay out of this repository.

## Agent Speed native monitor

Build `agent-speed/`, then install that folder in **Host Settings → Plugins**. Review and grant `native.main`, then enable the installation. Existing installations need their folder metadata reloaded after upgrading Desktop; older hosts cannot load `entries.native`. Restart the updated Desktop before enabling the native entry.

`native.main` runs trusted plugin code in Desktop's main process, not an isolated worker. The host owns its document URLs, tray items and activation lifetime. Agent Speed owns its collector, workers, native windows, dashboard, up to eight floating orbs, boards/leaderboards, history and CSV export, pricing, performance cards, title themes and settings. Open it from **Agent Speed…** in the tray/menu bar, the command center or its plugin settings page. Conversation live/average speed remains available in Desktop when the optional plugin is disabled.

For the default `agent-speed` installation, first native activation copies `userData/local-monitor` only when its native data directory is absent. Window state, settings, history, pricing caches and custom titles are copied unchanged; existing plugin data and legacy originals are preserved. Native state lives in `userData/desktop-plugins/data/agent-speed/native`. The one-time decision is stored separately in `userData/desktop-plugins/agent-speed-legacy-migration.json`, outside the entire installation data subtree.

Disabling or reloading saves pending preferences and stops native resources. **Clear data** follows the existing host contract: disable the installation and remove its data/configuration. Re-enabling starts fresh; the durable migration marker prevents cleared legacy contents from being imported again.

Native entry points and the bundled preload are built by `node plugins/agent-speed/build.mjs`; the generic folder builder alone does not produce that preload. Integration and Windows surface qualification commands are in Desktop's `docs/development.md`.

## Desktop pet authoring

The Desktop pet package owns [`assets/skills/hatch-pet/SKILL.md`](desktop-pet/assets/skills/hatch-pet/SKILL.md). Desktop's core `skills/` catalog does not contain it. **Create with OMP** copies it into the new workspace's `.omp/skills/hatch-pet/`, alongside the installation helpers and optional Iris reference.

Build the plugin from the Desktop checkout root:

```sh
npm run build --workspace=@omp-desktop/plugin-desktop-pet
```

`PetLibraryOptions.pluginDirectory` is the installed plugin package root; the creator resolves both its skill and `dist/cjs/install-pet.js` from that directory. The helpers execute the plugin installer with bundled Electron in Node mode and `OMP_ELECTRON_USER_DATA_DIR`, keeping the existing local `pets/` library. They do not launch Desktop's GUI or invoke `--desktop-pet-install`. New image-based authoring requires a complete bubble profile; existing completed packages without profiles remain importable.

Distribute the plugin with its runtime dependencies, including `sharp` and its native libraries for the target OS/architecture. The converter supports PNG/JPEG/WebP, keys opaque green backgrounds, and preserves already-transparent artwork. Verify the helper with the target bundled runtime rather than assuming a development Node run establishes native compatibility. Removing the plugin leaves ordinary authoring workspaces and conversations intact; helpers still require the installed plugin. Open a new authoring workspace to use updated copied instructions and scripts.

Directory loading uses the service's `setup` and `manage` exports. The host injects `OMP_ELECTRON_USER_DATA_DIR` into both workers; the service reads its own library during initialization, returns validated PNG data URLs, and uses wire overlay leases. The client uses only public plugin context APIs. Update the host runtime as well as the plugin when adopting this integration; plugin reload alone cannot add the host environment or `client.identity` support.

Creation controls read provider data with `agents.events`; creating a new workspace and conversation requires `agents.create`, including while the plugin is disabled. Review newly declared permissions after updating an existing installation. Opening Settings reads creation context without creating an authoring workspace; only **Create with OMP** prepares one.

## QQ sandbox settings

Open **QQ 连接 → QQ 沙箱**. The **沙箱** switch and JSON editor share one draft; click **保存配置** to apply it. `sandboxEnabled` defaults to `true`, including saved configurations that omit it. Enabled agents keep the dedicated native sandbox and use `ask` mode. JavaScript, public network requests, and image generation remain explicit capabilities; presets cannot override the top-level switch or grant tools preapproval.

Setting `sandboxEnabled` to `false` creates an ordinary host agent without `config.sandbox`. Its normal host tools can access files outside the QQ directory and run system commands, subject to the usual `ask` permissions; no permission is automatically approved. Restrict private/group access to trusted allowlists before disabling isolation. Model, thinking, and prompt preferences remain unchanged.

Saving either toggle direction, a directory change, or capability changes retires old routes and stops their agents before replacement. Delayed messages, permission cards, game callbacks, and stale agent-creation results cannot deliver through the replaced generation. Desktop conversation history, account credentials, owner/access lists, model selections, and game saves remain intact.

QQ attachments, presented-file uploads, and game images always use a pinned `SandboxFiles` handle for the dedicated directory; `sendFile.extraRoots` never widens it. With isolation disabled, text connection and ordinary agent creation do not open the native sandbox. Media and restricted game children open it only when needed and report an explicit failure if the secure filesystem is unavailable. Review and drawing children remain independently sandboxed even when the parent is an ordinary host agent.

## QQ message completion

QQ conversations share a serial queue per peer. Timeline sequence numbers belong to an epoch; idle resume or history reconstruction can renumber them. The gateway resets its sequence and revision caches when the epoch changes and recognizes submitted inputs by `clientMessageId`, including lower-sequence events. Completing and delivering a reply releases the next queued message unless native context maintenance is required. Static delivery errors reject the input with the original error instead of silently reporting success; the generated reply remains in the Desktop conversation.

The persisted `lastDeliveredSequence` is a processed timeline watermark, not a Tencent delivery receipt. Failed replies are not automatically retried.

Live assistant timeline rows are incremental fragments, not cumulative snapshots. New sequence numbers append to a stable `messageId`; a newer `contentVersion` at the same sequence replaces only that fragment. Group and game-enabled conversations assemble complete messages without inserting line breaks inside fragments, then validate internal protocols before QQ delivery. Executable protocols must come from one complete assistant message. Non-game C2C conversations retain native streaming.

## QQ context maintenance

The original QQ envelope, attachments, and vision input are sent once per admitted message. Member-query and multi-step game continuations carry only the latest host feedback and engine-provided context. QQ identity rules belong to the plugin; gameplay rules and the game protocol version come from the external engine and are installed in the agent's system prompt.

After plugin reload, a safe legacy conversation stays attached while its current turn runs. Its next admitted QQ message waits for that turn, requests a silent bounded handoff, and creates a new agent with the current protocol and latest peer model/preset selections. The handoff retains confirmed memory, unfinished requests, complete relevant OpenIDs, and necessary attachment paths; it is consumed by the first accepted input. Old Desktop history and sandbox files remain available. Invalid handoffs leave the old conversation intact; `/reset` starts a new conversation without that handoff. Sandbox mode, directory, or capability changes retire old agents immediately.

Configure automatic native compression in the existing JSON editor:

```json
{"autoCompactTokens":64000}
```

The default is 64,000 context tokens; `0` disables automatic maintenance. After a complete QQ message and its delivery, the gateway checks native usage and requests compression only when the threshold is reached and the peer has no active turn or review. It holds the peer queue until the observed manual compression completes and confirms a new compression result; command acknowledgement alone does not release it. `/compact` uses the same completion check and replies after completion. An acknowledgement failure or timeout pauses subsequent input until the outstanding operation completes or `/reset` replaces the peer; errors are reported in Desktop rather than silently treated as successful compression.

## QQ group member identities

In a QQ group, mention the bot and ask for a member's OpenID. The initial model input includes the current group, complete sender and mention-target identities, and known quoted/history-author identities; it does not include the full member directory. Duplicate names remain separate identities; OpenIDs are not QQ numbers, and group/C2C identities are not merged.

When a natural request needs a directory lookup, the model can emit one bare JSON object: `{"type":"member_query","nickname":"小明"}`, `{"type":"member_query","member_openid":"COMPLETE_MEMBER_OPENID"}`, or `{"type":"member_query"}` for the known directory. The plugin intercepts it, binds the currently authorized group, queries only its cached identities, and returns data for the natural reply. Query JSON is never delivered to QQ. Other group, account, agent, scope, permission, and refresh fields are rejected; refresh remains on the existing command path below.

For an explicit read-only lookup, mention the bot and send:

```text
/members 小明
/members --id COMPLETE_MEMBER_OPENID
/members --refresh
/members 小明 --refresh
/members --id COMPLETE_MEMBER_OPENID --refresh
```

The command always uses the current group and respects the existing slash-command access policy. Nicknames match case-insensitive substrings and return every match. `--refresh` reads every official roster page; with `--id`, it refreshes only that member's details. List requests are spaced at least one second apart per account; detail requests at least two seconds apart.

Results contain `group_openid`, `members`, `source`, and `complete`. The learned directory always returns `source:directory, complete:false` and may include former members. Only a successful refresh of every roster page returns `source:platform, complete:true`; single-member details remain incomplete. The official [roster](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members.get.html) and [detail](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members_member_openid.get.html) APIs require QQ platform allowlist permission. Error `11253` returns known identities with an explicit `platform_error`; other errors propagate without caching a partial roster.

The directory is stored in host-scoped plugin settings as `groupMembers`, keyed by account and group. Only admitted group messages are observed, including non-mention messages QQ delivers. Learning identities never grants access or command permissions. Quote caches are conversation-scoped; unavailable authors are labeled explicitly.

Trusted host clients can invoke `qqbot.group-members` with `{agentId, nickname?, member_openid?, refresh?}`. The persisted agent mapping selects the current QQ group; private chats, foreign hosts, revoked groups, and replaced mappings are rejected. This RPC is not exposed as a model-accessible host tool or MCP connection; changing sandbox mode does not grant access to other groups.

## QQ external game integration

The game implementation lives outside the plugin, by default in `~/.omp/qqbot-games`. Enable it in the existing QQ configuration JSON editor; only Desktop can change this host-controlled setting:

```json
{"game":{"enabled":true,"engineDirectory":"~/.omp/qqbot-games"}}
```

`engineDirectory` may be omitted or left empty to use the default. A custom value must be an absolute or `~/` path outside the QQ sandbox. The loader resolves the canonical `engine.js` and CommonJS `createGame(options).host` API at startup. It loads the external entry at runtime rather than bundling game code. Missing entries or incomplete host APIs fail explicitly.

The external engine owns gameplay commands and aliases, rules and numerical thresholds, player data structures, context and receipt interpretation, target selection, destructive-action confirmation, model-review policy, and scene validity. Its standalone `createGame(options)` entry remains usable by ordinary Node consumers. QQBot owns QQ messages and native mentions, access control, peer queues, callback ownership, agent routing, independently sandboxed review/drawing children, and media delivery.

The generic host contract is described by `qqbot/src/game-api.ts` and the external engine's `host.d.ts`:

- `protocol` supplies the engine's version and system prompt.
- `parseInput`, `handleMessage`, and `executeAction` recognize and execute engine-owned actions. The plugin passes original text and trusted QQ identities; models cannot supply identity, paths, time, randomness, or permissions.
- `context` and `feedback` supply the model's current context and actual execution results. `inspect` returns an opaque player snapshot and command recognition without executing actions.
- `resolveReview` accepts the engine's opaque request kind, ID, revision, and completed model output. Each request supplies its system prompt, schema, announcement flag, diagnostic label, and failure message.
- `getChoiceState` supplies an opaque selection snapshot, including any target state the engine requires. `getSceneState` returns `active`, `pending`, or `obsolete`; the plugin does not inspect player or world fields.
- `close` releases the same underlying game store.

The installed game now supplies `qqbot-host-game-v6`; the plugin consumes its version instead of pinning one. After rebuilding and reloading the plugin, safe older conversations migrate on their next admitted QQ message using the existing handoff. Desktop history, model preferences, sandbox files, and game saves remain available.

Production data retains its existing path outside the sandbox: `~/.omp/qqbot-data/installation-<encodeURIComponent(installation.id)>/xiuxian.sqlite`. The filename is storage compatibility metadata, not a gameplay implementation. Changing the engine source directory does not migrate or reset data. The QQ sandbox cannot contain the engine or its saves.

### Engine results become QQ messages and buttons

Recognized commands return the engine's actual messages without model paraphrasing. Explicit multi-step requests remain result-driven and execute at most four actions. Complete assistant output is validated before delivery; action JSON, malformed protocols, and internal review JSON never reach QQ players.

Group replies @ the original requester with QQ's [native mention format](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html), including every delayed chunk. Passive reply-ID fallback cannot replace that recipient. The mention counts toward the message length limit; private replies remain plain.

Engine `choices: [{label, command}]` become native callback buttons. Callbacks carry only generation, nonce, and index; their server-side bindings retain the requester, scope, peer, route, turn, and engine selection snapshot. Menus use two buttons per row and at most five rows, rotate the nonce on page changes, and attach only to the final message chunk. Type-11 interactions are acknowledged before joining the peer queue. Stale, duplicate, expired, stopped, or revoked callbacks cannot execute.

[Custom keyboards require QQ platform permission](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html). Only QQ's explicit keyboard rejection, error `304037`, resends the rejected chunk with the engine's exact text commands. Previously accepted chunks, asynchronous-acceptance responses, and unknown outcomes are not replayed.

### Engine scene requests use native image generation

Each scene supplies an opaque token, title, description, drawing system prompt and input, expected image dimensions, and progress message. QQBot runs a fresh background drawing child through Desktop's native `generate_image` and configured image backend. It does not select a game-specific image model or impose gameplay art rules.

Original PNG files are cached by sandbox root, scene ID, and the engine's drawing input; the existing game's cache keys and paths remain unchanged. PNG validation checks dimensions supplied by the engine, chunk integrity, compressed pixels, and scanline layout. The current game requests 512×512 images; that policy lives in the engine.

The combined Markdown message contains the native image, unchanged scene text, and buttons only while the engine reports `active`. `pending` retains the current scene without action buttons; `obsolete` discards late messages. QQBot separately enforces route, configuration, sandbox, access, and cancellation checks at delivery. Disabled image generation sends text and buttons immediately; generation or material-upload failure retains the original text and usable buttons.

Uploads use QQ's [material-management API](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html) and `qqbot-media://` references. Up to 64 owned references are retained per account; sends lease their references, and eviction deletes only owned materials, never original PNGs. Explicit image-resource rejection falls back to text, while an unknown final-send outcome is not retried.

### Game children retain independent sandbox isolation

Review and drawing children belong to the original QQ root and workspace, without inheriting its conversation history. A closed root is restored with its saved model selection before child creation. Review children keep a dedicated sandbox, use `ask` mode, clear MCP and parent tool preapprovals, and deny all tool permissions. Drawing children keep only the dedicated sandbox root and native image permission; approvals use the requester's QQ cards. The gateway confirms each child's actual sandbox before submitting work, including when the parent has sandbox isolation disabled.

Canonical review output returns to the engine for validation, not to QQ or as a parent completion notification. Children are archived after completion or failure. Cancellation, timeout, `/stop`, or route replacement discards results; delayed cleanup cannot hold the QQ queue beyond the review deadline.

Administrative commands remain separate from chat admission. With `access.commandMode: "allowlist"`, group owners require the exact account, member `openid`, and `groupOpenid`; names and other groups confer no authorization. Permission approvals remain requester-bound.

Trusted host clients can invoke `qqbot.game.inspect` with `{scope, openid, userId, text?}` for the unchanged database path, command recognition, and opaque player snapshot. It does not execute actions, create players, start models, or send QQ messages. C2C inspection requires `openid === userId`; this RPC is not exposed as a sandbox tool or MCP connection.

### Verify against the external engine

Run `npm test` from the game directory. From the Desktop checkout, build and test QQBot against the real external engine and a built Node SDK:

```sh
npm run build --workspace=@omp-desktop/plugin-qqbot
QQBOT_TEST_ENGINE_DIRECTORY="$HOME/.omp/qqbot-games" \
  OMP_DESKTOP_TEST_SDK_ROOT="$PWD/packages/desktop/sdk-dist/node_modules/@oh-my-pi/pi-coding-agent" \
  npm run test --workspace=@omp-desktop/plugin-qqbot
```

The SDK root must contain the Node modules and native `SandboxFs` addon. Tests use temporary databases; they never copy a bundled game fixture or fall back to a different engine.

## License

AGPL-3.0-or-later, except components carrying their own license; `qqbot/LICENSE` retains its MIT license.