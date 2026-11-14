# omp-plugins

Optional folder-installed plugins and source examples for [OMP Desktop](https://github.com/iris-cat-dev/omp).

- `agent-speed/`: live agent output speed.
- `wallpaper/`: wallpaper selection and rendering.
- `desktop-pet/`: desktop pet, authoring workflow, and bundled Iris assets.
- `qqbot/`: QQ gateway, account UI, and agent conversations.
- `schedules/`: scheduled agents, existing-agent heartbeats, run history, and multi-host management.
- `examples/`: Catppuccin, Linear attachments, and the local counter plugin.

## Build in a Desktop checkout

Desktop pins this repository as its root `plugins/` Git submodule and includes the five plugin packages in its npm workspaces. The shared SDK, compiler, and host implementation remain in Desktop's `packages/plugin`; plugin builds use that checkout rather than a second SDK copy.

From the Desktop checkout root:

```sh
git submodule update --init --recursive
npm install
npm run build:plugin
node scripts/build-desktop-plugins.mjs plugins/agent-speed plugins/wallpaper plugins/desktop-pet
node plugins/qqbot/build.mjs
node plugins/schedules/build.mjs
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

QQ conversations share a serial queue per peer. Timeline sequence numbers belong to an epoch; idle resume or history reconstruction can renumber them. The gateway resets its sequence and revision caches when the epoch changes and recognizes submitted inputs by `clientMessageId`, including lower-sequence events. Completing and delivering a reply releases the next queued message unless native context maintenance is required. Static delivery errors reject the input with the original error instead of silently reporting success; the generated reply remains in the Desktop conversation.

The persisted `lastDeliveredSequence` is a processed timeline watermark, not a Tencent delivery receipt. Failed replies are not automatically retried.

Live assistant timeline rows are incremental fragments, not cumulative snapshots. New sequence numbers append to a stable `messageId`; a newer `contentVersion` at the same sequence replaces only that fragment. Group and game-enabled conversations assemble complete messages without inserting line breaks inside fragments, then validate internal protocols before QQ delivery. Executable protocols must come from one complete assistant message. Non-game C2C conversations retain native streaming.

## QQ context maintenance

The original QQ envelope, attachments, and vision input are sent once per admitted message. Member-query and multi-step game continuations carry only the latest host feedback and current player state. Identity and game rules live in the agent's versioned system prompt instead of being repeated in every input.

After plugin reload, a safe legacy conversation stays attached while its current turn runs. Its next admitted QQ message waits for that turn, requests a silent bounded handoff, and creates a new agent with the current protocol and latest peer model/preset selections. The handoff retains confirmed memory, unfinished requests, complete relevant OpenIDs, and necessary attachment paths; it is consumed by the first accepted input. Old Desktop history and sandbox files remain available. Invalid handoffs leave the old conversation intact; `/reset` starts a new conversation without that handoff. Sandbox or capability changes still retire unsafe agents immediately.

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

Trusted host clients can invoke `qqbot.group-members` with `{agentId, nickname?, member_openid?, refresh?}`. The persisted agent mapping selects the current QQ group; private chats, foreign hosts, revoked groups, and replaced mappings are rejected. QQ agents retain their mandatory sandbox: this RPC is not exposed as a model-accessible host tool or MCP connection.

## QQ controlled game execution

The trusted standalone engine defaults to `~/.omp/qqbot-games`. Enable it in the existing QQ configuration JSON editor; only Desktop can change this host-controlled setting:

```json
{"game":{"enabled":true,"engineDirectory":"~/.omp/qqbot-games"}}
```

`engineDirectory` may be omitted or left empty to use the default. A custom value must be an absolute or `~/` path outside the QQ sandbox. The host resolves its canonical `engine.js` and CommonJS `createGame(options)` export at startup. A missing or invalid entry fails explicitly; there is no bundled engine or fallback. Changes take effect after the existing plugin reload; safe conversations using the other protocol migrate on their next admitted message while preserving Desktop history.

Players can use normal commands such as `我要修仙`, `新手礼包领取`, `闭关`, `我的背包`, and `突破`, or ask naturally. The agent understands wording and typos, submits normal actions, and explains the engine's actual result. Short breakthrough answers need no prefix or quotation; the engine allows at most one follow-up.

The standalone CommonJS engine can be used by ordinary Node code with `require(path.join(require('node:os').homedir(), '.omp/qqbot-games')).createGame(options)`, or with its configured absolute path. Production data remains outside the sandbox at `~/.omp/qqbot-data/installation-<encodeURIComponent(installation.id)>/xiuxian.sqlite`; changing the source directory does not migrate or reset it. There is no configurable sandbox save path or JSON import. GM, sect extensions, sandbox runners, test routes, and synchronization paths are removed.

Actions use the original QQ event's account, scene, peer, sender, and single explicit mention target. The model cannot supply identities, paths, time, randomness, or permissions. Completed assistant output is validated before QQ delivery; action JSON, malformed protocol output, and breakthrough scoring are never sent to players. The host validates the full scoring result and binds its trial/revision before settlement; invalid model results remain recoverable and do not count as a player's failed attempt.

Breakthrough and rift reviews run in a fresh background child session using the parent's current model. The child shares workspace ownership, not conversation history; it receives only the current review request, complete schema, and real correction feedback. Its system prompt replaces chat rules, MCP connections are cleared, and permission requests are denied. Complete canonical output is returned to the engine for validation, never to QQ or as a parent completion notification. The plugin archives the child after success or failure; cancellation, timeout, `/stop`, and replacement input discard its result and stop the child without stopping unrelated sessions.

Keep administrative commands separate from chat admission: set `access.commandMode` to `allowlist` and configure account-local `owners`. A group owner requires `scene: "group"`, the exact member `openid`, and the exact `groupOpenid`. `nickname` and `sceneName` are display data, not authorization. Legacy group owners without `groupOpenid` do not grant access. C2C identities and other groups cannot inherit that owner permission. Owner checks also protect permission approvals; ordinary question answers remain bound to their original sender. Administrators have no GM game mode.

Trusted host clients can invoke `qqbot.game.inspect` with `{scope, openid, userId, text?}` to read the fixed database path, command recognition, and player snapshot. It does not execute actions, create players, invoke an agent, or send QQ messages; C2C queries require `openid === userId`. It is not exposed as a sandbox tool or MCP connection.

From the standalone engine directory, run its behavior suite with `npm test`. From the Desktop repository root, build and test the plugin against that real external engine:

```sh
npm run build --workspace=@omp-desktop/plugin-qqbot
QQBOT_TEST_ENGINE_DIRECTORY=~/.omp/qqbot-games \
  OMP_DESKTOP_TEST_SDK_ROOT=/path/to/built/omp-sdk-node-root \
  npm run test --workspace=@omp-desktop/plugin-qqbot
```

The plugin suite never copies or falls back to an embedded engine. `OMP_DESKTOP_TEST_SDK_ROOT` must contain the built Desktop Node SDK and its native `SandboxFs` addon.

## License

AGPL-3.0-or-later, except components carrying their own license; `qqbot/LICENSE` retains its MIT license.