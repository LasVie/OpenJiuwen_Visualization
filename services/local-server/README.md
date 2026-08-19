# Local Repository Service

该服务为 Visualization Web 提供本地仓库的只读边界、临时 Runtime Trace、可选 OpenRouter provider-only adapter，以及显式启动的 Agent Core / JiuwenSwarm 隔离执行器。主服务只使用 Python 标准库；Repository API 不导入目标仓模块、不执行仓库脚本，也不提供 Git 或文件写接口。两个真实执行器仅通过各自固定 bridge 与单独 Python 环境运行，OpenRouter 仅在用户显式启动且服务端已配置密钥时访问外网。

## 启动

从仓库根目录运行：

```powershell
python -B services/local-server/scripts/run_server.py `
  --allow-root "C:\path\to\workspace" `
  --allow-origin "http://127.0.0.1:4173"
```

默认只监听 `127.0.0.1:8765`。`--allow-root` 可重复；所有扫描路径及 Git 根都必须位于其中。非 loopback host 会被拒绝。

## API V1

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | 返回 API 版本与 `read-only` 模式 |
| `GET` | `/api/v1/repositories` | 返回允许根目录及根目录/一级子目录中发现的 Git 仓库 |
| `POST` | `/api/v1/repositories/scan` | 解析一个允许范围内的 Git 仓库或子目录 |
| `POST` | `/api/v1/repositories/source` | 按源码引用读取当前工作树的有界行范围 |
| `POST` | `/api/v1/repositories/tools` | 只读索引 Tool 声明与静态注册路径 |
| `POST` | `/api/v1/repositories/changes` | 只读比较工作树或本地 commit refs |
| `POST` | `/api/v1/repositories/github/pull-request` | 只读获取 GitHub PR 元数据与 changed files |
| `POST` | `/api/v1/traces` | 创建内存 Trace 会话 |
| `POST` | `/api/v1/traces/{id}/events` | 使用会话令牌追加归一化事件 |
| `GET` | `/api/v1/traces/{id}` | 读取增量事件快照 |
| `GET` | `/api/v1/traces/{id}/stream` | 通过 SSE 读取增量事件 |
| `GET` | `/api/v1/model-providers/openrouter` | 读取无凭据的 Provider 状态与模型白名单 |
| `POST` | `/api/v1/model-providers/openrouter/invocations` | 用 Trace authority 启动服务端流式调用 |
| `POST` | `/api/v1/model-providers/openrouter/invocations/{id}/cancel` | 请求取消并关闭上游流 |
| `GET` | `/api/v1/agent-core` | 探测 DeepAgent bridge、依赖、OpenRouter 与固定工具状态 |
| `POST` | `/api/v1/agent-core/invocations` | 用 Trace authority 启动隔离的真实 DeepAgent |
| `POST` | `/api/v1/agent-core/invocations/{id}/cancel` | 终止 bridge 进程并关闭 Trace |
| `GET` | `/api/v1/jiuwenswarm` | 探测固定 Agent Team bridge、双仓依赖、OpenRouter 与角色工具策略 |
| `POST` | `/api/v1/jiuwenswarm/invocations` | 用 Trace authority 启动隔离的真实两成员 Agent Team |
| `POST` | `/api/v1/jiuwenswarm/invocations/{id}/cancel` | 终止 Team bridge 并关闭 Swarm Trace |

扫描请求：

```json
{
  "path": "C:\\path\\to\\agent-core",
  "options": {
    "includeTests": false,
    "includeFunctions": false,
    "maxFiles": 5000,
    "maxEdges": 20000
  }
}
```

响应包含 repository identity、Graph Kernel V1 snapshot、扫描统计和非致命 warnings。节点 ID 组合 Git revision、仓库相对路径与符号限定名；工作树存在修改时，evidence 会明确标记其超出引用 revision。`statistics.cache.status` 区分 `hit / miss / bypass`：命中前仍会校验有界源码清单，缓存只保存在当前服务进程内。

Tool 目录请求：

```json
{
  "path": "C:\\path\\to\\agent-core",
  "options": {
    "includeTests": false,
    "maxFiles": 5000,
    "maxFileBytes": 1000000,
    "maxTools": 5000,
    "maxRegistrationSites": 10000
  }
}
```

响应区分 Tool 声明、静态注册点和 `exact / inferred / dynamic` 置信度，不将静态路径表述为运行时已注册。运行确认来自 Trace 中独立的 `ability.register` 事件。

## 安全约束

- 使用规范化绝对路径与允许根目录校验，跳过 symlink/junction 和越界解析结果。
- Git 只通过参数数组执行只读命令，禁用 shell。
- Python 仅经 `ast.parse` 分析；不 import、eval、exec 或运行目标仓入口。
- Source API 只接受仓库相对路径，拒绝路径穿越、symlink/junction、目录、二进制和越界文件；默认最多读取 2 MB / 240 行，并始终标注当前工作树与 revision 对齐状态。
- 浏览器 Origin 必须在启动白名单中；响应禁止缓存并设置 `nosniff`。
- 请求体有大小上限，文件、文件数量和边数量均有扫描上限。
- Definition cache 最多保存 8 个深拷贝快照、默认 300 秒过期，并限制单条 24 MB、总计 96 MB；源码指纹最多读取 128 MB，任一上限超出都会绕过缓存而不是返回未经验证的旧图。
- Repository API 没有任何写、命令执行或凭据接口；Provider 与 Agent 执行位于独立显式路由，不扩大 Repository 权限。
- Agent Core endpoint 只运行仓库自带的固定 bridge，浏览器不能提交解释器、源码路径、命令或工具。bridge stdout 只接收固定前缀的有界 JSON event；其他运行日志被丢弃。
- V1 Agent Core 只注册只读 `inspect_input` 工具，不开放文件、shell、Git、MCP、Subagent 或写操作。DeepAgent workspace 与日志限制在 `.agent-core-runtime/`。
- JiuwenSwarm endpoint 只运行固定的两成员 `scheduled + inprocess` Agent Team，明确关闭 SwarmFlow、动态组队、外部 CLI、MCP、Skill 与 Subagent。浏览器不能覆盖 roster、team identity、workspace、工具、源码路径或命令。
- Team harness 内部资源在最后一个 `before_model_call` Rail 被按角色收敛：Leader 只看到 `create_task / view_task / send_message`，Analyst 只看到 `view_task / send_message / member_complete_task`；`before_tool_call` 再执行一次 deny 检查。一次最多运行一个 Team bridge。
- JiuwenSwarm 的 Team、Member、Task、Message、Rail、Model、Tool 与 Context 事件都进入同一 Trace；每个成员使用独立 Context owner，不把完整原文复制到日志或错误元数据。
- Runtime Trace 使用高熵会话 ID 和独立写入令牌；数据有数量、请求体和过期限制，只保存在内存。
- `agent-core` 会话只接受 Core 事件；`jiuwenswarm` 会话的非终止事件必须声明 `subject`，Context 还必须声明 `context.ownerId`，避免跨主体混合或无层级事件进入 UI。
- `swarm.subagent` 必须声明结构化派发与隔离证据；服务会校验 subject/context owner 一致性，并阻止同一 invocation 中途改变 session、dispatcher 或隔离策略。完整原文仍只能进入所属 Context message。
- Model Provider 事件会校验 invocation 身份、录制帧单调性、Token/费用预算和取消原因；完整输出不写日志或磁盘。
- OpenRouter key 只从 `OPENJIUWEN_OPENROUTER_API_KEY` 或 `OPENROUTER_API_KEY` 读取，永不返回浏览器。模型由 `OPENJIUWEN_OPENROUTER_MODELS` 白名单约束（缺省仅 `openrouter/free`），目标固定为 `https://openrouter.ai/api/v1/chat/completions` 并拒绝重定向；输入、输出、并发、SSE 帧和内存均有上限。
- Git Change API 只读取 porcelain status、merge-base、name-status、numstat 与零上下文 patch；不会 fetch、checkout、merge 或写 refs，返回始终声明 `writeOperations: false`。
- GitHub PR API 只接受结构化 owner/repository/PR 编号，固定访问 `api.github.com` 且拒绝重定向；浏览器不接触凭据，本地 Git 与远端 PR 都不会被修改。公共仓默认无需 token；可选的 `OPENJIUWEN_GITHUB_TOKEN` 只从服务端进程环境读取。
- Tool Catalog 仅解析候选文件 AST，不 import、执行或实例化 Tool；注册数据流无法静态解析时保留为 `dynamic`，返回始终声明 `writeOperations: false`。

Trace、Provider、Agent 执行、源码、缓存、变更与 Tool 目录协议见 [`docs/core-runtime-v1.md`](../../docs/core-runtime-v1.md)、[`docs/agent-core-execution-v1.md`](../../docs/agent-core-execution-v1.md)、[`docs/swarm-runtime-v1.md`](../../docs/swarm-runtime-v1.md)、[`docs/jiuwenswarm-execution-v1.md`](../../docs/jiuwenswarm-execution-v1.md)、[`docs/subagent-runtime-v1.md`](../../docs/subagent-runtime-v1.md)、[`docs/model-provider-v1.md`](../../docs/model-provider-v1.md)、[`docs/openrouter-provider-v1.md`](../../docs/openrouter-provider-v1.md)、[`docs/source-evidence-v1.md`](../../docs/source-evidence-v1.md)、[`docs/repository-scan-cache-v1.md`](../../docs/repository-scan-cache-v1.md)、[`docs/git-change-plane-v1.md`](../../docs/git-change-plane-v1.md)、[`docs/github-pull-request-v1.md`](../../docs/github-pull-request-v1.md) 与 [`docs/tool-catalog-v1.md`](../../docs/tool-catalog-v1.md)。

仓库发现只检查允许根目录本身和最多 200 个一级子目录，不做无界递归搜索；更深层仓库仍可由页面手动输入绝对路径并经过相同白名单校验。

## 验证

```powershell
python -B services/local-server/scripts/run_tests.py
```

不访问 OpenRouter 的 JiuwenSwarm 框架自检见 [`docs/jiuwenswarm-execution-v1.md`](../../docs/jiuwenswarm-execution-v1.md#环境配置)。
