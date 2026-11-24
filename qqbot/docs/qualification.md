# QQ migration and qualification

These integration constraints, acceptance requirements, and historical records belong to the QQ plugin. Named artifacts retain their original qualification and failure boundaries; this documentation migration did not rerun them.

## Integration and migration

### QQ 连接

`qqbot` 负责一个 daemon 级网关、QQ connector／绑定状态、账号／身份访问、peer 队列、QQ 事件格式化／媒体投递，以及持久的 peer 到 Desktop agent 映射。客户端入口提供完整配置／绑定页、设置页操作按钮和插件面板。可选 OMP hooks／工具提供 QQ prompt 上下文与文件投递，复用已有网关，不再创建连接。

复用当前 QQ SDK 和协议模块。用 Desktop 公开服务 bridge 与 OMP 原生工具／hooks 替换 DSH `ctx.agents`、`session/event`、system-prompt sections、审批／问答、模型发现及 Cordis 持久化。为需要的控制补齐受支持客户端 API，不长期依赖 `internal/*`。

通过 Desktop 管理器创建／恢复 agent，确保会话可见、可恢复。保留私聊／群聊隔离、@ 门控、按发送者校验命令权限、有界同 peer 处理、C2C 流式、群聊分块、被动回复限额、附件路径约束、问答／审批关联及已配置外部回合投递。“快照 + 订阅”观察 Desktop 续聊和原生服务回合，不只观察 QQ 客户端发起的回合。

同 peer 队列在匹配回合完成或失败后立即释放。timeline 序号只在同一 `epoch` 内可比较；agent idle 卸载／恢复或历史重建后，路由重置序号与文本／工具修订缓存。已提交 QQ 输入按 `clientMessageId` 认领，即使新序号低于旧水位，也不能作为历史重放跳过。静态回复投递失败保留原始错误并使该输入失败，不阻塞下一条群消息。`lastDeliveredSequence` 是已处理 timeline 水位，不是腾讯投递确认；发送失败不会删除 Desktop 已生成的回复，也不自动重试。

保留 `/preset` 作为 QQ 插件命令，使用 `qqbot` 管理的具名、经 schema 校验的 agent 配置模板。模板包含受支持的 Desktop agent 创建设置与 QQ prompt／skill／tool 选择，切换只作用于下一次 `/new` 或 reset，不重建运行中对话。它不是权限模式别名。只有 DSH preset 设置和 Cordis 服务挂载已有等价原生实现时才导入，无法映射的服务需明确报告，不能静默丢弃。

secret 和绑定轮询留在 daemon。缺少凭据是非阻塞等待状态。插件页面保留真实的绑定、刷新、手动替换／解绑、三类访问名单、配对／撤销／导出、access-revision 冲突处理。QQ 文本不能通过转发未知斜杠命令调用任意宿主插件管理操作。

账号入口为 Settings → Plugins → 对应 daemon 的 QQ 连接 → 权限授权 → 配置。“重启 QQ 连接”等应用级操作直接显示在所选安装实例的设置页，不在侧栏增加拼图菜单。运行侧栏和设置页操作要求“允许主机插件运行”与 QQ 单项开关同时开启；未绑定账号显示等待原因，仍可进入“QQ 连接”绑定页。暂停全局执行保留单项启用选择与账号配置，撤销运行型入口。

peer 映射以 Bot AppID、scope、peer OpenID 为键，指向真实 host／workspace／agent ID。不能把 DSH session 标识复用为 OMP 标识，也不能把 DSH 事件日志当作原生 OMP 历史。导入账号／偏好时保留旧 DSH 数据；转换历史对话需要独立校验过的 importer。

禁用撤销网关路由、socket／计时器／订阅和旧按钮权限，不删除 Desktop agent、不自动批准／拒绝待处理原生请求、不停止无关对话。原生问题继续通过宿主正常 UI 可见。重新启用按持久映射和当前请求身份连接，旧卡片不能批准新激活实例的请求。

## Data migration

| 原数据 | 目标及保留状态 | 提交／继续条件 |
| --- | --- | --- |
| DSH QQ 凭据／访问／偏好               | 主机作用域 `qqbot` 设置／secret／身份数据和新的 Desktop agent 映射                       | 仅在显式选择来源后导入，保留旧数据；校验 access revision、不暴露 AppSecret、不重新解释 DSH 事件日志 |

## Required acceptance

| 范围 | 必须覆盖的场景与结果 |
| --- | --- |
| QQ               | 扫码／刷新／手动绑定／更换／解绑，私聊／群／命令访问、配对／撤销／导出／冲突；peer agent 在 Desktop 可见；@ 门控、stop／new／compact／model、下一次 new／reset 生效的具名 preset；有界队列／超时、C2C 流／群分块／回复限额、图片／视频／文件／视觉路径和当前授权文件目标 |
| QQ 交互／投递    | 分组 ask 的 ID／顺序／多选／自定义答案，审批 nonce／点击者授权／取消／过期卡片；Desktop 续聊、配置的服务／外部回合投递；禁用不删除 agent 或自动解决原生权限；重启用不重复连接或重复过期输出                                                                              |

## Historical verification

以下保留迁移时已经记录的专项验收事实，不计作本次文档迁移重新执行的结果。

原记录证据根目录为 `/tmp/omp-unified-plugin-smoke-2s3uFs`。此前 Native 验收使用 `package-output-qualified/mac-arm64/OMP Desktop.app`、mini-electron 0.1.38 与源码 SDK 18.14.0 desktop/core；未签名、公证或发布。checkout 外消费者已验证 QQ CJS／MJS 管理与 SILK／MPEG Wasm 闭包；共享 compiler／worker、SDK 与宠物 helper 证据归属宿主及对应插件。

此前有界探测确认 DSH Cordis 入口不能直接作为 OMP 扩展加载；迁移后的 QQ 服务已由真实 compiler／isolated worker 消费。两个客户端和两个 SDK 会话的离线管理、独立安装、禁用／重启用／reload／移除与退出保持 enabled 均通过。生产 QQ SDK 的 owned loopback 验证每安装一个真实 socket，释放互不影响；这不替代 Tencent 登录或投递。

本次 QQ 入口回归先复现真实分发 factory 注册 `qqbot.settings` 时抛出 `Invalid plugin settings id`，以及 enabled／waiting 插件没有 active surface。修正统一贡献 ID 校验与 catalog 的 waiting 语义后，两个相关测试文件共 11 项通过，覆盖真实 QQ factory 的 manage／active 账号控件、非法 ID 边界和 waiting → running 的实例／在途 RPC 保持；应用类型检查与正式 renderer 导出通过。

前次 QQ 入口修复分发产物为同一证据根目录下的 `package-output-qq-fix/mac-arm64/OMP Desktop.app`，复用上述 Native／SDK，仅重建 renderer 与 macOS 分发目录，未替换用户 Desktop。`qq-native-ui-yj95TF` 已实际启动 packaged main、独立 daemon，确认 bundled `qqbot` 精确来源，并通过真实 NSEvent 权限确认、QQ 单项启用／全局暂停、恢复执行后的无凭据 waiting、侧栏打开账号页、AppID 原生输入、拼图菜单显示与收起、再次暂停撤销运行入口但保留单项选择与配置。三张 2400 × 1600 Native 截图 `qq-paused-configuration.png`、`qq-login-surface.png`、`qq-application-menu.png` 已逐张检视。初次锁屏阻塞在用户解锁后解除；验收未绕 owning-window 输入资格或 TCC，外网保持隔离，不计作 Tencent 登录／投递。退出后 owned windows 为零，光标恢复、原应用恢复请求成功，私有 daemon 由同 profile CLI 正常停止。上述历史 GUI 证据保留各自产物归属，不计作新候选的重跑结果。

最新 QQ 搬迁修复产物为 `package-output-qq-relocation-fix/mac-arm64/OMP Desktop.app`，包含重建后的 daemon 与四目标 remote-backend 分发，复用 mini-electron 0.1.38、既有 renderer 和源码 SDK 18.14.0 desktop/core。本地产物已补 ad-hoc 签名并通过 `codesign --verify --deep --strict`，没有公证或发布。此前配置仍指向已删除的桌面 App 时，注册逻辑跳过已有 ID，导致查询 `paseo-plugin.json` 失败；修复后 18 项安装生命周期回归、服务类型检查和构建通过，覆盖搬迁、暂停／配置保留、撤销信任、已移除状态、新版本拒绝隐式授权、用户同 ID 来源隔离与旧 generation 撤销。

`qq-relocation-native-EF2fEM` 已将真实新 App 复制到隔离的 Applications 目录，以不存在的 Desktop 插件路径和全局暂停／QQ 单项启用配置启动实际 packaged GUI。真实 renderer 启动私有 daemon 后，catalog 与持久配置均迁移至新目录，QQ 版本为 1.0.0，无清单错误，暂停和单项选择保留。真实 NSEvent 完成当前来源权限确认并打开 QQ 配置；AppID／AppSecret 控件及扫码／刷新操作可见，无 alert，真实公开客户端 `qqbot.status` RPC 返回无凭据管理状态。`qq-relocated-account.png`（2400 × 1600）已检视，最终 `result.json` 为 PASS；owned windows 归零，光标／原应用恢复请求成功，私有 daemon PID 41749 由同 profile CLI 正常停止。未替换／重启用户 App 或 daemon，未恢复真实腾讯绑定或投递。

安装该修复包后，需在无运行任务时从新 App 重启内置 daemon 才能加载新服务实现；只关闭 App 或点 QQ 的重启／重载按钮不会更新仍在运行的旧 daemon。路径变化后，在插件权限页确认当前客户端来源；不自动搬移旧 source path 的客户端信任。

## Paused qualification

The original qualification record continues to pause real QQ/Tencent binding and delivery, Windows/Linux, and real negative-coordinate external-screen acceptance. Native enumerated only the primary screen. The isolated worker, loopback, and account-page runs above do not replace Tencent login or delivery.
