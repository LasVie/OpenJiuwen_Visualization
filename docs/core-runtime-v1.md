# Core Runtime V1

Core Runtime V1 是 `agent-core` 与 Visualization Web 之间的归一化事件边界。外部生产者可以主动写入；可选的 Agent Core Executor 也能在固定隔离进程中执行真实 DeepAgent 并写入同一协议。Runtime 页面只读取实时 Trace，不 import Python 或接触凭据；历史读取由独立 Archive capability 负责。

## 真实观测边界

当前协议依据 `agent-core` 的以下稳定接口设计：

- `DeepAgent.invoke` 的 `before_invoke / after_invoke` 生命周期；
- `ReActAgent` 的 user message、task iteration、ReAct iteration；
- `_railed_model_call` 的 `before_model_call / after_model_call / on_model_exception`；
- AbilityManager 工具执行的 `before_tool_call / after_tool_call / on_tool_exception`；
- `ModelContext.add_messages()` 和最终 `ContextWindow.get_messages()`；
- Ability 注册表的注册结果。

`rail.chain` 只证明一次 callback 链发生，不能证明链内每个 Rail 读取了什么、改了什么。只有显式 instrumentation Rail 或 Rail 包装器提供 `hook.exact=true` 时，页面才把 `rail.hook` 展示为单个 Rail 的精确决策证据。

## 会话流程

1. 浏览器或集成程序创建临时 Trace。
2. 服务返回高熵 Trace ID 和该会话专用的 `writeToken`。
3. 生产者批量 POST 归一化事件；服务分配严格递增的 `sequence`。
4. 页面通过 SSE 获取增量事件，并按 `sequence` 幂等合并。
5. 生产者发送 `trace.status/end` 或 `trace.status/error` 后，会话关闭并拒绝继续写入。

所有 Trace 的实时 authority、SSE 状态与可继续写入能力只存在于服务进程内存，默认两小时无活动后过期；服务重启后不会恢复为 live Trace。已校验事件会同步写入本机 SQLite 历史归档，见 [`runtime-archive-and-compare-v1.md`](runtime-archive-and-compare-v1.md)。

### 创建 Trace

```http
POST /api/v1/traces
Content-Type: application/json

{
  "owner": "agent-core",
  "label": "local DeepAgent run",
  "maxTokens": 8192
}
```

响应中的 `writeToken` 只用于对应 Trace 的事件入口：

```http
POST /api/v1/traces/{traceId}/events
Content-Type: application/json
X-Trace-Token: {writeToken}

{
  "events": [
    {
      "eventId": "invoke:1:start",
      "kind": "agent.invoke",
      "phase": "start",
      "timestampMs": 0,
      "spanId": "invoke:1",
      "title": "DeepAgent invoke"
    }
  ]
}
```

同一个 `eventId` 重试写入会被幂等忽略，包括终止事件在响应丢失后的重试。单次请求最多 250 个事件和 2 MiB，单个会话默认最多 10,000 个事件或 32 MiB，全部 Trace 合计最多 128 MiB。关闭的旧会话会优先被回收；终止事件必须是批次中最后一个新事件。

### Context 原文

`context` 增量携带完整消息。消息分段视图默认在浏览器端脱敏和精简；用户展开后看到 `raw`，连续原文视图始终展示完整内容。

```json
{
  "eventId": "context:1",
  "kind": "context.delta",
  "phase": "instant",
  "timestampMs": 12,
  "spanId": "invoke:1",
  "token": { "used": 356, "delta": 322, "budget": 8192 },
  "context": {
    "operation": "append",
    "messages": [
      {
        "id": "message:user:1",
        "role": "user",
        "label": "User message",
        "raw": "完整、未截断的消息内容",
        "preview": "可选的脱敏摘要",
        "tokens": 34,
        "source": "on_user_message"
      }
    ]
  }
}
```

`replace` 可以通过 `removeMessageIds` 精确标记被压缩的消息；若未提供 IDs，则替换当前所有仍可见消息。页面会保留消息的加入和移除步骤，因此上一步/下一步能够重建当时的 ContextWindow。

### 精确 Rail 决策

```json
{
  "eventId": "rail:context:1:end",
  "kind": "rail.hook",
  "phase": "end",
  "timestampMs": 18,
  "durationMs": 1.7,
  "spanId": "model:1",
  "hook": {
    "rail": "ContextAssembleRail",
    "railNodeId": "rail-context",
    "callback": "before_model_call",
    "priority": 85,
    "namespace": "inner",
    "durationMs": 1.7,
    "mutationDiff": "+ runtime_hint (8 tokens)",
    "controlSignal": "continue",
    "exact": true,
    "examines": ["ModelCallInputs.messages", "ModelCallInputs.tools"]
  }
}
```

`mutationDiff` 和 `controlSignal` 必须来自探针实际观测，不能由页面推断。敏感载荷应放在 Context message 的 `raw` 中，避免复制到摘要、日志或事件标题。

### 受管环境证据

四个内置 Executor 会在 bridge 输出任何事件前写入一条服务端拥有的 `trace.status/instant`。其 `environment` 对象包含固定的 env/consumer 映射、完整 fingerprint、Python/uv、项目 revision/dirty、Swarm Core dependency identity 和 `validation=passed`。Core/Subagent 必须对应 `core-env + agent-core` project slot且不得声明独立 Core dependency；JiuwenSwarm/SwarmFlow 必须对应 `swarm-core-env + jiuwenswarm` slot并声明已解析的 Core dependency。

该字段不接受路径、命令、环境变量或安装输出。外部 producer 可以按同一协议提交结构化环境证据，但服务会执行相同的封闭字段和 ownership 校验；只有内置 Executor 的事件能证明本次运行确实使用 Companion active manifest。完整执行绑定规则见 [`managed-environments-v1.md`](managed-environments-v1.md)。

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/traces` | 创建实时 Trace、归档 Session 并返回写入令牌 |
| `POST` | `/api/v1/traces/{id}/events` | 批量追加事件，需要 `X-Trace-Token` |
| `GET` | `/api/v1/traces/{id}?after=N` | 获取 N 之后的快照 |
| `GET` | `/api/v1/traces/{id}/stream?after=N` | SSE 增量流；支持 `Last-Event-ID` 重连 |

服务仍只允许 loopback host。Repository API 保持严格只读；Trace endpoint 不提供目标文件、Git、命令执行或凭据持久化能力，只更新实时内存并写入服务拥有的 SQLite 归档。Provider-only 调用见 [`openrouter-provider-v1.md`](openrouter-provider-v1.md)；真实 DeepAgent/ReAct 执行使用另一个固定 bridge 路由，见 [`agent-core-execution-v1.md`](agent-core-execution-v1.md)。
