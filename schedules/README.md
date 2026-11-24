# Schedules

Create recurring new-Agent tasks and send recurring heartbeat prompts to existing Agents. This optional daemon-owned plugin supplies the **Schedules** sidebar and command-center entries, management page, scheduler, persistence, run history, and eleven Agent tools. Desktop application packages do not include or start it; these tools are not built-in Desktop capability tools.

## Install and enable

Install `plugins/schedules` through **Settings → Plugins → Discover** on the target daemon. Confirm its declared capabilities and this device's client-code trust, enable **Allow host plugins to run**, then enable the installation.

The package declares `agents.create`, `agents.events`, `agents.prompt`, `agents.configuration`, `agents.tools`, `events.changed`, and `files.scoped`. General installation, permissions, and trust rules belong to the [host plugin guide](https://github.com/iris-cat-dev/omp/blob/main/docs/features/tools-and-plugins.md#plugin-management-and-native-commands).

## Create and edit tasks

Open **Schedules**, then choose **New schedule** for a new-Agent task. Select the host and project, enter a prompt and optional name, and select the available provider/model, mode, thinking, and `local` or `worktree` isolation. Worktree isolation is available only for an eligible project. Set completion archiving, maximum runs, and expiry as needed. A new task's **Run on create** switch is off by default.

Choose a cron preset or custom cron expression with an IANA timezone, or an exact interval in milliseconds. For example, `15 9 * * 1-5` with `Asia/Tokyo` runs at 09:15 on weekdays in that timezone. Exact intervals are retained without rounding or conversion: editing only the name must preserve a value such as `1000001` ms. Existing cron tasks keep their timezone; a missing stored timezone is displayed as `UTC`. Switching an interval to cron starts with the device timezone. Switching cron to interval starts at `3600000` ms.

Intervals must be positive safe integers. Maximum runs must be a positive safe integer; leave it empty for unlimited runs. Expiry must be a parseable date/time; an empty value removes the expiry. The form shows cron, timezone, interval, maximum-run, expiry, provider, and submission errors rather than silently saving invalid values. Provider loading and failures are shown alongside a retry control. Creation requires a provider and project path.

Existing-Agent heartbeats appear on the same page. Their edit form retains the existing target and changes cadence, maximum runs, and expiry, rather than replacing the target's new-Agent configuration. Editing a completed heartbeat's maximum runs does not reactivate it.

The page aggregates tasks across hosts with the same package/installation and supports filtering. Every task and action retains its actual owning host; editing cannot move a task to another host. Disabling the selected host's installation removes its sidebar entry, while another enabled host can still be managed through the plugin command. Re-enabling restores aggregation, saved tasks, and paused state.

## Controls and lifecycle

Tasks provide **Edit**, **Pause / Resume**, **Run now**, **Run history**, and **Delete**, with deletion confirmation. Run history retains errors, logs, and the execution's Agent/workspace details.

- **Pause** prevents future triggers without interrupting executions that have already started.
- **Resume** computes the next trigger from the original cadence without replaying missed runs.
- **Run now** runs immediately without changing cadence. Completed schedules cannot be run again through this action.
- Disabling the installation or host execution stops future triggers and retains tasks, history, and paused state. Re-enabling computes the next trigger from the current time and does not replay missed runs. Ordinary Agents already executing are not terminated when the plugin stops.
- Heartbeats observe the actual target Agent lifecycle. Archiving or deleting the target completes its heartbeats, including paused heartbeats. A temporarily missing project does not mean the target Agent was deleted.

For remote hosts using models configured on this computer, the local model source must remain connected for schedules and unattended work. See the [host model-source requirements](https://github.com/iris-cat-dev/omp/blob/main/docs/remote-hosts.md).

## Persistence and migration

Only the canonical installation ID `schedules` imports the daemon's old `<daemon home>/schedules` records, once. A durable import marker prevents repeated imports. Original files are retained, existing plugin records are not overwritten, and task IDs, paused state, and history are preserved. Other installation IDs use independent storage and do not import these historical records.

Legacy CLI and WebSocket schedule calls forward through a thin adapter to the enabled canonical installation; the core does not run a second scheduler or register another set of schedule tools. An absent, unauthorized, or disabled installation reports `plugin_unavailable`.

## Agent tools

Tool names are installation-bound. The canonical installation exposes:

- `schedules__create_schedule`
- `schedules__list_schedules`
- `schedules__inspect_schedule`
- `schedules__update_schedule`
- `schedules__pause_schedule`
- `schedules__resume_schedule`
- `schedules__delete_schedule`
- `schedules__schedule_logs`
- `schedules__run_schedule_once`
- `schedules__create_heartbeat`
- `schedules__delete_heartbeat`

Schedule CRUD tools manage only new-Agent schedules. Heartbeats do not appear in `list_schedules`; manage them on the page or through the caller's heartbeat tools. Heartbeat creation requires an authenticated Agent-scoped session and targets the caller. `delete_heartbeat` cannot delete another Agent's heartbeat.

Creation tools take a nonblank `prompt` and `cron`, optional IANA `timezone` (for example, `America/New_York`), `name`, positive integer `maxRuns`, and `expiresIn`. `create_schedule` also accepts `provider` as `<provider>` or `<provider>/<model>`, `cwd`, and `isolation` (`local` or `worktree`); provider/model defaults come from the authenticated caller. The tools create on cron cadence; the page and engine additionally retain exact `every` intervals. Expiry duration examples are `5m`, `30s`, `1h`, and `2h30m`; a digits-only duration is seconds.

Updating changes only provided fields; omitted fields remain unchanged. `timezone` requires `cron`, and `expiresIn` and `clearExpires` are mutually exclusive. A provider/model string cannot conflict with a separate model value. See [tool definitions](tools.ts), [RPC definitions](rpc.ts), [engine](engine.ts), [legacy importer](importer.ts), and [management page](ui/page.tsx).

## Build

From an initialized OMP Desktop workspace with its dependencies and shared SDK prepared:

```sh
node plugins/schedules/build.mjs
```

The package-local equivalent is `node build.mjs`. This emits declarations plus ESM/CJS client and service bundles. Host workspace/submodule and SDK setup remain in the [development guide](https://github.com/iris-cat-dev/omp/blob/main/docs/development.md).

## 历史迁移验收记录

以下是迁移时已经记录的专项验收事实，不是本次文档迁移重新执行的结果。

计划任务迁移已在两台隔离测试 daemon 与真实插件 worker 中执行：未安装／禁用错误、旧暂停记录及历史接管、cron 手动运行、暂停心跳随目标归档完成、禁用跨过 due 后不触发及重新启用不补跑均通过。独立 WebSocket 生命周期回归覆盖缺 project 的 live／cold stored Agent、归档与实际删除，并保留原 directory 投影语义。

真实 Web renderer 已通过客户端信任授权、侧栏与命令中心导航、双主机聚合及筛选，以及新建／编辑／删除确认、暂停／恢复、立即运行与运行记录。固定间隔 `1000001` ms 在名称编辑后重新打开仍保持精确值；实际选择模型、模式和 thinking，并将任务改为 `15 9 * * 1-5`／`Asia/Tokyo` 与新建工作树，保留最大次数、到期与完成后归档。local 与 worktree 两次实际执行均成功，运行记录保留各自 Agent／工作区与输出 `timeline test`；执行使用确定性测试 provider。既有心跳在目标归档后显示已完成，编辑最大次数不重新激活；禁用第一主机后其所选侧栏入口消失，第二主机仍能通过插件命令独立管理任务，重新启用恢复聚合、旧任务与暂停状态。

实际模型菜单暴露的冻结 React element Proxy 错误已按数据／句柄边界修复，SDK 回归与真实服务端插件执行回归通过。计划任务的这些结果仅覆盖隔离 daemon／worker 与 Web renderer，尚未进行打包 Native 或跨平台专项验收。
