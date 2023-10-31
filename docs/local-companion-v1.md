# Local Companion 与连接设置 V1

## 目标

Local Companion 把 Visualization Web、仓库访问边界、运行归档、Provider 凭据和固定 Runtime bridge 收敛到一个 loopback 进程。Windows 用户双击 `OpenJiuwen Visualization.pyw` 后即可进入网页，不需要分别在 Terminal 中启动 Vite 与 Python 服务。

## 启动模型

1. 启动器定位当前 `visualization-web` 与其父工作区。
2. `dist/index.html` 缺失或早于前端源码时，在隐藏窗口中按 lockfile 安装依赖并执行生产构建。
3. Companion 只绑定 `127.0.0.1:8765`，以同一 origin 托管静态网页、JSON API 与 SSE。
4. 默认允许根是 `visualization-web` 的父工作区，运行数据库和托管 GitHub checkout 位于该根的 `.openjiuwen-visualization/`。
5. 系统浏览器自动打开；重复启动会识别已有 Companion 并只打开新标签页。

源码启动器要求 Python 3.11+ 和 Node.js。后续可在不改变网页/API 合同的前提下封装为自包含 Windows 可执行文件。

## 网页连接设置

### OpenRouter

- Key 通过 write-only API 写入 Windows Credential Manager 的 `openrouter.default` 句柄。
- 保存完成后的浏览器状态、API 快照、SQLite、审计和日志只看到是否已解析、来源与时间等元数据，不返回 key。
- 新 key 立即热更新 Provider 与四类 Runtime；存在活动调用时拒绝替换或删除。
- 环境变量仍作为未配置系统凭据时的只读回退。

### Agent Core 与 JiuwenSwarm

每个框架拥有独立 slot，并支持：

- `local`：工作区允许根内的已有 Git 目录；
- `github`：匿名 HTTPS 公开 GitHub 仓库与可选 branch/tag/ref；
- `sync`：显式拉取目标 ref，并拒绝覆盖存在本地修改的托管 checkout；
- `reset`：恢复工作区默认路径，不删除 Session 或另一 slot。

绑定前会同时校验 Git identity 和框架标记文件。成功后，Definition、Change、Development、Agent Core、JiuwenSwarm、SwarmFlow 与 Subagent 的路径在当前进程中同步更新；活动模型或 Agent 运行期间拒绝换源。

GitHub V1 不支持私有仓库，不接受嵌入凭据、query token、任意 Git 参数或自定义 remote。克隆和同步使用固定 argv、禁用交互式凭据提示，并把 checkout 限制在 Companion 管理目录内。

### Core 与 Swarm 运行环境

- Agent Core 与 Subagent 共享独立的 `core-env`；它只跟随 Agent Core slot。
- JiuwenSwarm 与 SwarmFlow 共享独立的 `swarm-core-env`；它跟随 JiuwenSwarm slot 及其 `pyproject.toml` / `uv.lock` 声明的 Core，不被 standalone Core slot 覆盖。
- 页面显示 desired/active 指纹、Python/uv 版本、consumer 和 drift 状态，并提供逐环境“检查并修复”。
- Companion 只写 `.openjiuwen-visualization/environments`，使用 uv-managed CPython 3.11、frozen lock、依赖检查、固定 bridge probe 和原子 generation 切换；源码 checkout 始终只读。
- 失败或取消的 staging 不会替换旧 active；每个环境只保留 active 与一个上一代。Python/依赖下载必须通过正常 TLS 校验，不提供不安全下载开关。

详细合同见 [`managed-environments-v1.md`](managed-environments-v1.md)。

## 静态托管安全边界

- 非 API 请求只能解析到受信任的 `dist`；拒绝路径穿越、反斜杠、symlink 与超大文件。
- extensionless 路由回退到 SPA `index.html`；缺失的带扩展名资产返回 404。
- HTML 默认不缓存，哈希化 `assets/` 使用 immutable cache。
- 页面响应设置 CSP、`frame-ancestors 'none'`、`nosniff`、no-referrer 和受限 Permissions Policy。
- API 继续执行 Origin 白名单、JSON content type、请求大小、路径允许根和各能力自身的授权校验。

## 当前边界与后续封装

V1 优先解决当前源码工作区的无 Terminal 启动和网页配置。自包含 `.exe`、系统托盘生命周期、私有 GitHub OAuth/PAT 连接以及多工作区配置文件属于后续可插拔模块，不改变已持久化的连接 slot 合同。
