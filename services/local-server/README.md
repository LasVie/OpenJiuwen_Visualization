# Local Repository Service

该服务为 Visualization Web 提供本地仓库的只读边界和临时 Runtime Trace 采集。它只使用 Python 标准库，不导入目标仓模块，不执行仓库脚本，也不提供 Git 或文件写接口；Trace 事件只写入进程内存。

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
| `POST` | `/api/v1/repositories/tools` | 只读索引 Tool 声明与静态注册路径 |
| `POST` | `/api/v1/repositories/changes` | 只读比较工作树或本地 commit refs |
| `POST` | `/api/v1/traces` | 创建内存 Trace 会话 |
| `POST` | `/api/v1/traces/{id}/events` | 使用会话令牌追加归一化事件 |
| `GET` | `/api/v1/traces/{id}` | 读取增量事件快照 |
| `GET` | `/api/v1/traces/{id}/stream` | 通过 SSE 读取增量事件 |

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

响应包含 repository identity、Graph Kernel V1 snapshot、扫描统计和非致命 warnings。节点 ID 组合 Git revision、仓库相对路径与符号限定名；工作树存在修改时，evidence 会明确标记其超出引用 revision。

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
- 浏览器 Origin 必须在启动白名单中；响应禁止缓存并设置 `nosniff`。
- 请求体有大小上限，文件、文件数量和边数量均有扫描上限。
- Repository API 没有任何写、命令执行、模型调用或凭据接口。
- Runtime Trace 使用高熵会话 ID 和独立写入令牌；数据有数量、请求体和过期限制，只保存在内存。
- `agent-core` 会话只接受 Core 事件；`jiuwenswarm` 会话的非终止事件必须声明 `subject`，Context 还必须声明 `context.ownerId`，避免跨主体混合或无层级事件进入 UI。
- `swarm.subagent` 必须声明结构化派发与隔离证据；服务会校验 subject/context owner 一致性，并阻止同一 invocation 中途改变 session、dispatcher 或隔离策略。完整原文仍只能进入所属 Context message。
- Model Provider 事件会校验 invocation 身份、录制帧单调性、Token/费用预算和取消原因；服务不读取 Provider 凭据，完整输出不写日志或磁盘。
- Git Change API 只读取 porcelain status、merge-base、name-status、numstat 与零上下文 patch；不会 fetch、checkout、merge 或写 refs，返回始终声明 `writeOperations: false`。
- Tool Catalog 仅解析候选文件 AST，不 import、执行或实例化 Tool；注册数据流无法静态解析时保留为 `dynamic`，返回始终声明 `writeOperations: false`。

Trace、变更与 Tool 目录协议见 [`docs/core-runtime-v1.md`](../../docs/core-runtime-v1.md)、[`docs/swarm-runtime-v1.md`](../../docs/swarm-runtime-v1.md)、[`docs/subagent-runtime-v1.md`](../../docs/subagent-runtime-v1.md)、[`docs/model-provider-v1.md`](../../docs/model-provider-v1.md)、[`docs/git-change-plane-v1.md`](../../docs/git-change-plane-v1.md) 与 [`docs/tool-catalog-v1.md`](../../docs/tool-catalog-v1.md)。

仓库发现只检查允许根目录本身和最多 200 个一级子目录，不做无界递归搜索；更深层仓库仍可由页面手动输入绝对路径并经过相同白名单校验。

## 验证

```powershell
python -B services/local-server/scripts/run_tests.py
```
