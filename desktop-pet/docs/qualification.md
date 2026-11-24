# Desktop pet qualification

These are plugin-specific acceptance requirements and historical qualification records migrated from the host plugin-system design and packaging guides. Recorded runs belong to their named artifacts; they are not new verification of the currently installed plugin or runtime.

## Runtime support boundary

The native host's overlay implementation requires `BrowserWindow.setIgnoreMouseEvents`, including transparent-pixel passthrough and drag interaction. Its [current implementation](https://github.com/iris-cat-dev/omp/blob/main/packages/desktop/src/plugins/native-overlay.ts) calls this API; plugin reload cannot add a missing runtime API.

An earlier macOS packaging note reported that this API was missing and that activity publication was verified with the default hidden pet only; that result did not establish full overlay compatibility. The note did not identify the affected runtime version. Later historical native records below include successful real-input overlay qualification and a mini-electron 0.1.38 artifact. Keep these distinct: the earlier failure is not a blanket current macOS support claim, and the later runs do not qualify an arbitrary new artifact.

## Required regression coverage

- Preserve startup-ready behavior and no startup flash, default and old settings, real transparent-pixel input passthrough, the 4 px drag threshold, nonactivating focus, and all three sizes. Cover DPI, main-window zoom, multiple monitors, and negative coordinates.
- Navigate to the real highest-priority task with precise host and conversation identity; preserve multi-host activity freshness. Main conversations remain independent tasks, and subagents never become pet tasks. Closing a publisher must not discard another connected window's known pending work.
- Validate PNG, manifest, atlas geometry, and strict resource limits, including 20 MiB and 4096 × 4096. Preserve the five required animation states, compatibility with old packages without bubbles, and complete bubbles for new image-based authoring. Resources do not execute code; import never replaces, auto-selects, or enables a pet.
- Independent local authoring must not change ordinary conversation model/default-setting boundaries. The old shell/helper/installation entry paths must not depend on global Node or Python. Converter exit must not stop the real daemon. New helpers run the plugin-owned installer rather than restoring the removed `--desktop-pet-install` command.
- Remote connections, project switching, and phone pairing must not transmit pet resources, paths, selections, or playback authorization. Remote bundles still require local trust. Reject calls with the wrong frame, epoch, activation, or installation.
- Qualify actual macOS, Windows, and Linux packaged runtimes and record supported behavior. Known mini-electron input-passthrough/media failures stay version-specific failures until verified; changed filenames, guessed versions, or mock bridges do not establish a fix.

Plugin consumer regressions live beside the implementation: [service](../src/service.test.ts), [client](../src/client.test.tsx), [activity](../src/activity.test.ts), [geometry](../src/geometry.test.ts), [HTML](../src/html.test.ts), [library](../src/library.test.ts), [manifest](../src/manifest.test.ts), [images](../src/images.test.ts), [creation](../src/creation.test.ts), [installer](../src/install-pet.test.ts), [bubbles](../src/bubble.test.ts), and [work chatter](../src/work-chatter.test.ts). Generic native-overlay authorization/lifecycle regressions remain in the [host native-overlay tests](https://github.com/iris-cat-dev/omp/blob/main/packages/desktop/src/plugins/native-overlay.test.ts). Automated consumer checks do not replace actual native input, model-authoring, or multi-display acceptance.

## 历史原生输入与任务导航证据

以下保留原始验收记录中的数值、产物与暂停边界；不计作当前候选的重跑结果。

宠物空 bootstrap frame 不再抢占正式文档的绑定；主屏 zoom 1／1.5 的 30 项真实输入通过，覆盖 3 px 不拖、4／5 px 拖动与持久化、释放不 pat／open、opaque 命中、透明穿透和不抢焦点。zoom 1.5 的三尺寸 × 0／1／12 气泡九组 bounds／scale 与截图均通过。

此前已验收分发产物的 `native-qualified-production-43My0r` 完整通过真实任务导航与关闭验收：两个实际 daemon／SDK 会话先确认无模型 command 注册，再生成真实待办；NSEvent 点击打开最高优先任务的精确主机／workspace／完整会话。已读后该主机 revision 从 seq 8 到 9，待办从两项降为一项；关闭发布窗口后再次点击仍打开另一主机的剩余任务。正式 App 的 `production-agent-navigation.png` 和宠物的 `production-two-task-pet.png` 已逐张检视；主窗实际 visible／key、scale 2、2400 × 1600。

此前 `native-qualified-production-xta1dd` 已真实复现 Overlay `closed` 回调访问失效 `webContents.id` 的退出失败。按既有主窗模式在创建期缓存 ID，并新增关闭后文档与旧 action 撤销回归；`native-overlay.test.ts` 九项测试、主进程构建及最新 Native 关闭均通过。owned windows 归零、光标／原应用恢复请求成功，两套私有 daemon 均由同 profile CLI 正常停止。

## 历史资源安装与 NodeMode 证据

原记录的证据根目录为 `/tmp/omp-unified-plugin-smoke-2s3uFs`。此前完成 Native 验收的分发产物为 `package-output-qualified/mac-arm64/OMP Desktop.app`，使用 mini-electron 0.1.38 与当前源码 SDK 18.14.0 desktop/core；未签名、公证或发布。checkout 外消费者已验证独立 helper 工作区和资源安装闭包；共享 compiler／worker、QQ 与 SDK 闭包的其他证据仍归属宿主和对应插件。严格禁全局 Node／Python 的 NodeMode 消费者通过 29 项资源／CLI 边界检查。

未修改生产 main 入口、无 `--app` 的真实 GUI 在 `native-qualified-production-cJPeQD` 通过：packaged renderer／preload bridge、私有 daemon 启动及实际 generated shell → bundled NodeMode helper → Desktop CLI → Native 图片转换均可用。转换前后 daemon PID／serverId／完整设置相同，退出后 owned windows 为零，私有 daemon 由同 profile CLI 正常停止。外层 `sandbox-exec` 禁解释器策略下，生产 renderer sandbox 初始化返回 EPERM；完整 Native 转换的严格策略验收仍受该环境限制，未禁用 renderer sandbox 绕过。

上述 shell → Desktop CLI 是此前分发产物的历史路径。当前插件的新工作区 helper 直接运行 `dist/cjs/install-pet.js`；不得把旧验收记录理解为恢复 Desktop 宠物安装命令。

## 历史暂停范围

完整系统验收仍未完成，专项验收条件全部保留。用户选择继续暂停模型创作、Windows／Linux 和真实负坐标外接屏验收；Native 当前仅枚举主屏。严格外层解释器策略的完整 Native 转换另有上述 EPERM 环境阻塞。与壁纸有关的人工文件对话框／选图暂停范围见 [Wallpaper qualification](../../wallpaper/docs/qualification.md)。
