# QQ connection

Connect private chats and QQ groups to Desktop agent conversations with an optional daemon-owned plugin. Account settings, access control, conversation routing, media delivery, and image quotas belong to this package.

## Install and bind an account

After installing the **QQ connection** plugin from its folder, choose **Configure** on its daemon installation. Grant declared capabilities in **Permissions**, then open **Configuration**. The account page provides **QQ AppID**, **QQ AppSecret**, **Save/replace account** (`保存／替换账号`) and **Scan to bind** (`扫码绑定`). Configuration remains available while execution is paused or the installation is disabled.

Choose **Scan to bind** to request a QR code; opening the settings page alone does not generate one. The selected daemon needs internet access to obtain a Tencent binding URL, which it converts to the displayed QR image. You do not need to enter AppID/AppSecret first. Binding failures appear on the account page; **Refresh QR code** requests a replacement after expiry.

## Sandbox, model access, and tool output

QQ agents default to the **QQ sandbox** (`QQ 沙箱`) switch being on (`sandboxEnabled: true`). Toggle it and choose **Save configuration** to apply. Turning it off creates a normal host agent: authorized QQ users can request system commands, host files and ordinary tools, including access outside the dedicated directory. Approval mode remains `ask`, with no automatic permissions; restrict private/group access to trusted lists before disabling isolation. A mode change stops the previous agent and creates a new conversation while preserving its Desktop history, account, credentials, access lists and model preferences.

The **QQ sandbox path** (`QQ 沙箱路径`) is the dedicated working/media directory in both modes. Edit an absolute path (or `~/...`) and save; blank uses an installation-private directory. Existing `cwd` settings migrate to `sandboxPath`. The sandbox switch, path, **JavaScript**, **Public requests** and **Host image generation** (`主机生图`) share the JSON draft. All three optional capabilities default to off; enable the required grants with `sandboxCapabilities: { javascript: true, network: true, imageGeneration: true }`. JavaScript and public-request grants apply to sandboxed agents; normal host agents use their ordinary tool catalog. Public requests let authorized QQ users send sandbox data off-host. Changing the directory or capabilities also stops the old agent and creates a new conversation.

When enabled, the agent receives real `config.sandbox` filesystem confinement. This restricts model capabilities, not the daemon's operating system. Sandboxed QQ models cannot run shell/host eval/browser tools, obtain system identity, load ambient skills/MCP/extensions, or access files outside their sandbox. Opt-in JavaScript runs in a fresh QuickJS WASM guest without Node globals or host imports. Opt-in networking rejects private/localhost/metadata destinations and uses no host proxy, Cookies or credentials. Presets retain model/thinking/prompt preferences but cannot override the top-level sandbox switch, `ask` mode or tool preapproval. QQ attachment storage and automatic file delivery remain confined to the dedicated directory in either mode; `qqbot_send_file` is unavailable and `sendFile.extraRoots` never grants outside access. Presented-file delivery requires `sendFile.sendPresentedFiles: true`. Unrestricted text connections open no native sandbox handle; media opens one on demand and reports an explicit failure if secure file access is unavailable. Game review subagents remain separately sandboxed; scene drawing runs through the plugin's image-generation entry point.

Enabled model-provider plugins run in a separate, tool-free host inference gateway. A sandboxed QQ session keeps the original provider/model selection at creation, resume and model changes; provider-plugin tools, ambient prompts and hooks do not enter it. Model requests expose `sandbox_read`, `sandbox_write` and `sandbox_list` by default; explicit grants add `sandbox_js` and/or `sandbox_fetch`. JavaScript/public requests require Node RPC sandbox profile 2. QQ image requests are handled by the plugin through the existing host image API, without granting the sandboxed model a native image tool or requiring a QQ-specific SDK profile. Older profiles retain their existing file-only or JavaScript/network support. An unavailable selected model fails startup. Inference failures remain failed turns, and QQ receives a failure notice instead of a silently successful empty turn.

Tool-call failures stay in the agent/Desktop timeline and are not posted to QQ. With `showToolResults: true`, QQ receives successful completion notices only; normal assistant replies and whole-turn failure notices keep their existing delivery behavior.

`sandbox_fetch` returns locally rendered Markdown for HTML, with browser request headers and a bounded 5 MiB response / 100,000-character preview. Use `raw: true` for source text; guest JavaScript `fetch()` keeps its complete 1 MiB raw-response contract. Captcha and JavaScript-only pages still require an accessible source.

QQ attachment handles exposed to tools and model-visible text use `pinnedSandboxFiles`; host-side absolute paths remain internal. Review children retain independent sandbox isolation even when the main QQ conversation has sandbox mode disabled.

## Image generation and daily quotas

To let QQ generate and send images, grant the plugin's `images.generate` capability under **Permissions**, enable **主机生图**, and choose **Save configuration**. The host's image-generation settings must also be enabled with a usable model and credentials. Asking QQ to draw a picture makes the model return one plugin control object, for example `{"type":"qqbot_generate_image","prompt":"Draw a red fox.","images":[]}`. Optional image-editing references are sandbox-relative PNG/JPEG/WebP paths, each at most 4 MiB and 8 MiB total, also bounded by `media.maxMB`. The plugin obtains the real sender from the consumed QQ input; models cannot supply or replace the account, sender, or quota identity. With image generation enabled, replies are collected until the turn finishes so control JSON is consumed rather than posted to QQ. New QQ sandbox sessions do not receive the SDK's native `generate_image` tool; native image approval requests are denied by the plugin. Legacy image-enabled sessions hand off their conversation on the next authorized input.

Open **QQ 连接 → 沙箱与扩展** and set **每人每日生图上限** below **主机生图**, then choose **Save configuration**. The JSON field `imageDailyLimit` accepts positive integers and defaults to **10** when omitted. Changing the ceiling preserves today's usage: raising it makes only the additional slots available; lowering it below current usage blocks new generations until usage is below the ceiling on a later day or the ceiling is raised.

Ordinary QQ drawing and game scene drawing share the configured limit of new image generations per sender per Beijing calendar day, refreshed at **00:00 Beijing time**. The identity is AppID + private/group scope + the actual sender OpenID; private and group identities are never linked or assumed equivalent. Reservations are atomic and persisted outside the sandbox in `~/.omp/qqbot-data/image-quota.sqlite`, shared across plugin installations of the same AppID. Each installation applies its configured ceiling to that shared usage. Restarting, reinstalling, `/new`, and `/reset` do not reset today's usage. Cached scene images and delivery of existing images are free. A shared in-flight scene generation is charged once to its first requester, not to every waiter. Exhaustion is reported to QQ without calling the image provider. The host, public protocol, and SDK carry no QQ identity or quota policy; non-QQ host/SDK image generation is unaffected.

A pending generation reserves one slot on its Beijing admission date; a result arriving after midnight stays charged to that date. An API response containing a generated image commits usage immediately, even if image validation, saving, upload, or QQ delivery subsequently fails. Only an explicit pre-generation rejection or an authoritative no-image result releases a reservation. Unknown provider failures, timeouts, and cancellation keep their pending reservations; they do not expire automatically. This prevents uncertain outcomes from granting extra paid calls.

Generated files are saved under `.qqbot-media/generated/` and uploaded to the current authorized QQ conversation, independently of **Public requests** and `sendFile.sendPresentedFiles`. Cancelled or failed turns do not send queued generated images; images without a known current-turn origin are not replayed into another conversation. `media.ttlHours` also cleans expired generated UUID images.

## Conversations and permissions

At startup or reset, QQ checks whether the saved Agent ID still exists, including archived agents and every directory page. A missing ID creates a fresh agent under the configured sandbox mode and replaces only that peer mapping; AppID, credentials, access lists, model/thinking choices, and literal prompts stay intact. Lookup and stop failures remain errors rather than being treated as missing agents. A sandbox configuration change invalidates in-flight lookups, creation, permissions and delivery. The observed agent must confirm the configured sandbox state before the new peer mapping is saved. An inaccessible replacement directory still stops the old turn. Sender access is checked again after attachment preparation, immediately before submitting the turn.

Private chats and groups have separate peer mappings and independent root conversations. New conversations, including `/new` and `/reset`, receive a fresh workspace record backed by the same configured sandbox directory; they never reuse another peer's workspace. Existing mapped agents keep their IDs at startup, and reset preserves the previous Desktop history. Sandbox stop/reset does not require host background-job extensions; retained daemons remain scoped to their recorded owner.

QQ's service requires the declared `agents.prompt` capability to send messages, stop legacy peers, change models, and cancel timed-out turns. This permission belongs to the trusted plugin service; it does not add model tools or relax the model's sandbox. Grant it under **Permissions** if the installation reports a missing capability.

## Connection state and recovery

To use the **QQ connection** sidebar entry, enable both **Allow host plugins to run** and the QQ installation's own switch. It joins the optional plugin entries in the main sidebar. The shared QQ page in **Configure**, the sidebar surface, and workspace panels shows **Connection status** (`连接状态`) separately from error details. In active mode, **Restart QQ connection** (`重启 QQ 连接`) appears on that page, scoped to the selected host and installation; there is no sidebar puzzle menu or QQ application-menu action. An enabled connection waiting for account credentials keeps its sidebar entry and settings actions available. Pausing host execution hides execution entries and actions but retains the QQ switch selection and account configuration.

QQ retries transient network failures with backoff, including temporary token-service failures, without an eight-attempt cutoff.

Idle connections remain open while gateway heartbeats are acknowledged; incoming chat messages are not required. Each heartbeat ACK has a deadline of one heartbeat interval or 15 seconds, whichever is shorter. A missing ACK retires the half-open socket and immediately attempts to resume the QQ session. If sleep delays a heartbeat tick by more than two heartbeat intervals (with a 30-second minimum), the first tick after wake also reconnects immediately. These recoveries preserve existing Desktop agents and peer mappings.

A successful session resume restores **Connected** and clears the disconnect reason. Rejected credentials and Tencent account/permission bans remain failures requiring correction and an explicit restart; disabling the installation cancels pending retries and heartbeat deadlines.

`Selected daemon host is not connected` refers to the plugin worker's daemon API connection, not QQ authentication. This trusted local IPC follows the worker channel's lifetime and is exempt from network-socket heartbeat leases, so system sleep cannot expire that lease. Closing the actual IPC channel still releases its daemon session immediately, without waiting for the worker process to exit.

When the worker process exits, pending plugin RPCs fail immediately and the installation stops appearing as running. This follows the process exit rather than waiting for its output streams to close.

## Incoming images

To ask about a QQ image, attach it to the message and @ the bot in a group. With `media.enabled` and `vision.enabled`, the service downloads supported images into `.qqbot-media` inside the configured sandbox and includes their image content in the model input.

Supported HTTPS media origins include the exact `multimedia.nt.qq.com.cn` host shown in [Tencent's group-message attachment example](https://bot.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html). Downloads remain size-limited and reject redirects, lookalike hostnames and unrelated `qq.com.cn` subdomains. This trusted service operation does not require enabling sandbox JavaScript or public-network access.

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

The external engine owns gameplay commands and aliases, rules and numerical thresholds, player data structures, context and receipt interpretation, target selection, destructive-action confirmation, model-review policy, and scene validity. Its standalone `createGame(options)` entry remains usable by ordinary Node consumers. QQBot owns QQ messages and native mentions, access control, peer queues, callback ownership, agent routing, independently sandboxed review children, plugin-owned image generation, and media delivery.

The generic host contract is described by [`src/game-api.ts`](src/game-api.ts) and the external engine's `host.d.ts`:

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

The default engine's `我的修仙信息`, `我的状态`, and `状态` replies show the current stone balance on a separate line below the player's name, realm, and spiritual root, with thousands separators.

Group replies @ the original requester with QQ's [native mention format](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html), including every delayed chunk. Passive reply-ID fallback cannot replace that recipient. The mention counts toward the message length limit; private replies remain plain.

Engine `choices: [{label, command}]` become native callback buttons. Callbacks carry only generation, nonce, and index; their server-side bindings retain the requester, scope, peer, route, turn, and engine selection snapshot. Menus use two buttons per row and at most five rows, rotate the nonce on page changes, and attach only to the final message chunk. Type-11 interactions are acknowledged before joining the peer queue. Stale, duplicate, expired, stopped, or revoked callbacks cannot execute.

[Custom keyboards require QQ platform permission](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html). Only QQ's explicit keyboard rejection, error `304037`, resends the rejected chunk with the engine's exact text commands. Previously accepted chunks, asynchronous-acceptance responses, and unknown outcomes are not replayed.

### Engine scene requests use native image generation

Each scene supplies an opaque token, title, description, drawing system prompt and input, expected image dimensions, and progress message. QQBot calls the host image API through its shared `QQImageGenerator`, using the trusted sender and the same daily quota as ordinary QQ drawing requests. It uses Desktop's configured image backend without creating a drawing child, selecting a game-specific image model, or imposing gameplay art rules.

Original PNG files are cached by sandbox root, scene ID, and the engine's drawing input; the existing game's cache keys and paths remain unchanged. PNG validation checks dimensions supplied by the engine, chunk integrity, compressed pixels, and scanline layout. The current game requests 512×512 images; that policy lives in the engine.

The combined Markdown message contains the native image, unchanged scene text, and buttons only while the engine reports `active`. `pending` retains the current scene without action buttons; `obsolete` discards late messages. QQBot separately enforces route, configuration, sandbox, access, and cancellation checks at delivery. Disabled image generation sends text and buttons immediately; generation or material-upload failure retains the original text and usable buttons.

Uploads use QQ's [material-management API](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html) and `qqbot-media://` references. Up to 64 owned references are retained per account; sends lease their references, and eviction deletes only owned materials, never original PNGs. Explicit image-resource rejection falls back to text, while an unknown final-send outcome is not retried.

### Review children retain independent sandbox isolation

Review children belong to the original QQ root and workspace, without inheriting its conversation history. A closed root is restored with its saved model selection before child creation. Review children keep a dedicated sandbox, use `ask` mode, clear MCP and parent tool preapprovals, and deny all tool permissions. The gateway confirms each child's actual sandbox before submitting work, including when the parent has sandbox isolation disabled.

Canonical review output returns to the engine for validation, not to QQ or as a parent completion notification. Children are archived after completion or failure. Cancellation, timeout, `/stop`, or route replacement discards results; delayed cleanup cannot hold the QQ queue beyond the review deadline.

Administrative commands remain separate from chat admission. With `access.commandMode: "allowlist"`, group owners require the exact account, member `openid`, and `groupOpenid`; names and other groups confer no authorization. Permission approvals remain requester-bound.

Trusted host clients can invoke `qqbot.game.inspect` with `{scope, openid, userId, text?}` for the unchanged database path, command recognition, and opaque player snapshot. It does not execute actions, create players, start models, or send QQ messages. C2C inspection requires `openid === userId`; this RPC is not exposed as a sandbox tool or MCP connection.

### Verify against the external engine

Run `npm test` from the game directory. From the Desktop checkout, build and test QQBot against the real external engine and a built Node SDK:

```sh
npm run build --workspace=@omp-desktop/plugin-qqbot
sdk_dir="$(mktemp -d)"
tar -xzf packages/desktop/sdk-dist/omp-sdk.tgz -C "$sdk_dir"
QQBOT_TEST_ENGINE_DIRECTORY="$HOME/.omp/qqbot-games" \
  OMP_DESKTOP_TEST_SDK_ROOT="$sdk_dir/package" \
  npm run test --workspace=@omp-desktop/plugin-qqbot
```

The SDK root must contain the Node modules and native `SandboxFs` addon. Tests use temporary databases; they never copy a bundled game fixture or fall back to a different engine. Remove the temporary SDK staging directory after the test run.

## Updating a folder installation

### QQ plugin still shows the old settings after a source update

The `plugins/` submodule tracks QQ source code, not the generated `qqbot/dist/` directory. Updating the submodule leaves any existing build in place. The folder installation loads `dist/client.mjs` and `dist/service.cjs`, not `src/`, so updated source can still show the old settings. The displayed package version can also stay unchanged between source commits.

From the Desktop checkout root, after installing workspace dependencies, build first and reload the existing daemon installation only if the build succeeds:

```bash
npm run build --workspace=@omp-desktop/plugin-qqbot && omp-desktop plugin reload qqbot
```

Use the actual installation ID if it differs from `qqbot`, and target the daemon that owns the installation (`--host` if needed). Alternatively, after the build succeeds, choose **Restart/reload** at the bottom of the plugin's **Configure** dialog. Reopen **Configuration** and look for the QQ settings tabs **模型与对话** and **账号与绑定**. The plugin can remain disabled; there is no need to reinstall it or clear its data.

Keep `dist/` ignored. **Restart/reload** reloads the declared built entries; it does not run package build scripts or install dependencies. Keep any developer build-and-reload shortcut explicit and conditional on a successful build. For end-user releases, the recommended approach is to build in CI and distribute a versioned installable package containing `dist/`, not to build from source on the daemon.

## Runtime dependencies

The QQ package declares React Native as an optional, host-provided UI peer. Its daemon service and remote backend install without React Native; the Desktop renderer still provides it when loading the QQ client. Host backend assembly is described in the [development guide](https://github.com/iris-cat-dev/omp/blob/main/docs/development.md).

The QQ service compiles the QQ SDK into its CJS/MJS entries and distributes the connector, WebSocket, and audio-codec runtime dependency closure separately. Verify these dependencies from the actual installed package, not development workspace resolution; see the [host SDK dependency rules](https://github.com/iris-cat-dev/omp/blob/main/docs/omp-desktop-plugin-migration.md#3-保留宿主-sdk-的共享实例).

## Host integration and migration history

Integration constraints, data migration rules, required acceptance, and historical native evidence are maintained in [QQ migration and qualification](docs/qualification.md). These historical runs retain their original artifacts, failures, and unverified Tencent/platform boundaries.

## Verification

For an isolated integration check, use [tests/sandbox-smoke-inputs.json](tests/sandbox-smoke-inputs.json) with a fresh test daemon/HOME/USERPROFILE/PASEO_HOME and a real model; leave the user's existing daemon and App untouched. Prepare the listed inside canary, sibling outside canary, directory link (a junction on Windows) and hardlink, then send the exact prompts through QQ with the sandbox enabled. In the UI, confirm the sandbox switch, path and capability edits update JSON, JSON edits update the controls, invalid JSON is preserved, and blank selects the installation-private default. Exercise both sandbox mode transitions: old agents stop, stale replies and approvals are blocked, and AppID, access lists, credentials, history and model preferences remain available. Windows secure roots support local drive directories; UNC, network mappings and SUBST roots fail closed.

