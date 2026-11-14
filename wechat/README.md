# 微信连接

Windows x64 上的 OMP Desktop 微信连接插件，包含只读消息接收、文本和图片发送所需的桥接程序与 DLL。当前已通过隔离数据的构建和协议验证；安装版宿主与真实微信的端到端连接尚未验证。

## 准备

需要 OMP Desktop 0.7.0 插件宿主、支持 `node:sqlite` 的 Node、Python 3.12 x64 和已登录的 Windows 微信。仅支持 `native/engine/profiles.json` 中列出的微信程序文件指纹；版本号相同但文件不匹配时也会拒绝连接。

在本目录构建插件并准备 Python 环境：

```powershell
npm install --legacy-peer-deps
npm run build
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r bridge\requirements.txt
```

在 OMP Desktop 中选择此目录安装插件，并将上面虚拟环境的 `python.exe` 绝对路径填入插件设置。该插件不在 Desktop 现有的五个内置插件工作区中，需单独构建。

## 连接账号

在 OMP Desktop 的「微信连接」设置页填写微信账号 ID、Python 可执行文件绝对路径、当前微信进程 PID 和该账号的 `db_storage/contact/contact.db` 绝对路径，主动点击「核验并生成绑定」。请确认所选数据库确实属于该账号；核验会检查所选进程的账号身份及数据库能否用该进程中的密钥认证。成功后绑定路径回填到草稿；再填写明确允许的私聊或群会话 ID，选择宿主模型并保存。绑定资料保存在插件私有目录，不包含数据库密钥；不会覆盖旧绑定。取消或关闭页面不会回填结果。核验需要授权读取选定进程与联系人数据库，不会启动收发。只有主动点击启动且宿主处于启用模式时才会尝试连接；停止或停用会撤销后续发送。

插件使用单独的本地 SQLite 日志记录接收和发送状态。接收批次持久化后才确认游标；群聊只响应明确 @ 机器人账号的消息，单独 @所有人不会触发；私聊仅处理允许的会话。相同会话按序处理，其他会话可并行。保存配置时，移除会话的排队消息立即封存；即使保存失败也不会恢复这些消息。模型回复使用无工具的单次请求；长回复按 Unicode 字符安全分段，每段独立记录提交结果，未知结果不会自动重发后续分段。

连接运行时，可选择已授权会话并填写本机图片绝对路径，确认后交由原生宿主校验并提交。发送结果未知时不会自动重发，连接也不会自动恢复。先在微信核对记录，再在「待核对的发送」中确认封口；封口不会发送消息。核对时会查看同一账号的原生发送状态，如果存在未知记录则一并请求原生宿主封口。

模型或连接中断后，同一会话会等待人工处理；其他会话可继续。先在微信核对已有回复，停止连接后在「中断的消息」中关闭记录，未提交的分段不会重发。存在尚未核对的发送时，必须先处理「待核对的发送」。

本地日志包含消息和回复内容，应留在本机，勿提交到仓库。不要删除或重建日志来绕过核对。

## 本地开发

测试需要可解析的 OMP Desktop 0.7.0 插件 SDK。准备好 SDK 和 Python 依赖后运行：

```powershell
$env:WECHAT_TEST_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
npm test
.\.venv\Scripts\python.exe -B -m unittest discover -s tests/native -p "test_*.py"
```

测试使用隔离数据，不连接真实微信。修改原生桥后，可用 `.\native\engine\build.ps1 -OutDir native\runtime` 在安装 Visual Studio x64 C++ 构建工具的 Windows 上重新构建；构建会更新该目录的指纹记录。
