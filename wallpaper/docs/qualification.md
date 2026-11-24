# Wallpaper qualification

These are plugin-specific acceptance requirements and historical qualification records migrated from the host plugin-system design and appearance guides. They are not new verification of the currently installed plugin or native runtime.

## Required regression coverage

- Preserve file/URL/off/none/null behavior and transparency values 0/0.85/1. Adding candidates must neither apply nor copy media; removing candidates must not delete source files. Re-adding the same path must not revive an old candidate or selection. Preserve candidate IDs/order and missing/undecodable records.
- Only the current media's real image/video readiness may make its window transparent. Preserve A→B→A switches, retries, late-callback rejection, document leases, Range behavior, and preview limits. A release or failure in one window must not affect another window's already accepted media reads.
- Menus, dialogs, and model controls must remain opaque. Theme/background/transparency changes preserve the actual input DOM identity, focus, selection, drafts, and scroll position; conversations must not remount.
- Preserve revisioned field patches, window-local previews, broadcast commits, and local main-process/profile authority. Durable authorized resource references may persist; temporary playback URLs and handles may not.
- Remote connections, project switching, and phone pairing must not transmit local wallpaper resources, paths, selections, or playback authorization. Remote bundles still require local trust. Reject calls with the wrong frame, epoch, activation, or installation.
- Qualify actual macOS, Windows, and Linux packaged runtimes and record supported behavior. Known mini-electron input/media limits remain version-specific failures until verified; changed filenames, guessed versions, or mock bridges do not establish a fix.

Plugin consumer regressions: [controller](../src/controller.test.ts) and [URL source parsing](../src/source.test.ts). Generic media routing, authorization, and native-dialog contracts remain in the [host plugin design](https://github.com/iris-cat-dev/omp/blob/main/docs/desktop-plugin-system-design.md) and [native runtime contracts](https://github.com/iris-cat-dev/omp/blob/main/docs/packaging.md#native-runtime-contracts).

## Version-specific Windows limitation

The last verified Windows mini-electron 0.1.28 package lacked the media-player factory. Valid MP4 and WebM files failed with “error creating media player” even over HTTP; a filename or codec change cannot implement the missing player. Images remained usable. The same runtime's protocol adapter buffered each response before delivery, so it did not provide end-to-end media streaming. Newer Windows runtime/video support requires actual Windows artifact verification; the historical macOS records below do not qualify it.

## 历史 GUI 与 Native 验收证据

以下保留原始验收事实与暂停边界；不计作当前候选的重跑结果。

原生 owning frame／navigation identity、严格 Range 和跨窗口媒体 lease 隔离已由 mini-electron 真实 GUI 验证。这是历史真实运行证据；共享媒体 ID 是 bearer capability，不是插件隔离能力，新公开租约的安装实例／文档／用途授权边界仍按宿主合同验收。

壁纸真实 file／URL decode、透明度 0／0.85／1、off／none／null、加载前 opaque、A→B→A 迟到回调与输入保持已有 GUI 证据。双窗／关闭隔离、项目切换、本机归属、预览 48／49 上限及竞争／释放通过。最新 Native 验证通过真实附件菜单实体 opaque、同媒体 lease 解码，以及实际 Cmd+Alt+T → 生产 theme.cycle → light／dark／auto；同 composer DOM、焦点、3190 字草稿、选区和滚动保持。Native async file dialog 已通过实际 panel 可见后的 Node ticks、owner／queued close／destroy／shutdown 和 exact-once 清理；程序调用 cancel 不记作真实 Escape，人工接受／取消和候选添加／删除／同路径重加仍暂停。

这里的预览 48／49 是预览租约上限验收，不是候选库大小上限；候选网格不分页，也不限制为 48 项。

## 历史产物归属与暂停范围

相关历史证据根目录为 `/tmp/omp-unified-plugin-smoke-2s3uFs`。此前完成 Native 验收的分发产物为 `package-output-qualified/mac-arm64/OMP Desktop.app`，使用 mini-electron 0.1.38 与源码 SDK 18.14.0 desktop/core；未签名、公证或发布。不同历史 GUI 记录保留各自产物归属，不计作新候选的重跑结果，也不推断这些记录中的每项壁纸观察均来自同一个具名产物。

完整系统验收仍未完成，专项验收条件全部保留。用户选择继续暂停人工文件对话框／壁纸选图、Windows／Linux 和真实负坐标外接屏验收；Native 当前仅枚举主屏。模型创作和严格外层解释器策略 Native 转换的暂停／EPERM 阻塞归属 [Desktop pet qualification](../../desktop-pet/docs/qualification.md)。
