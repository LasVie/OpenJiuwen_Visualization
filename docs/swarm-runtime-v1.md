# Swarm Runtime V1

Swarm Runtime V1 是 `jiuwenswarm` 与 Visualization Web 之间的归一化事件边界。协议与通用 ingestion 层本身不 import 或执行 `jiuwenswarm`，也不主动调用 Agent、工具或模型；任何生产者都可以把已观测事件写入 loopback 内存服务，浏览器再按严格顺序投影层级、关系、状态和独立 Context。

可选执行器位于协议层之外，并把真实框架证据归一化回同一协议：`openjiuwen.jiuwenswarm-executor` 运行固定双成员 Agent Team，它明确不是 SwarmFlow；`openjiuwen.swarmflow-executor` 则通过 Agent Core `run_swarmflow` 运行固定两阶段 Workflow。两者身份、入口和运行限制彼此独立，完整边界见 [`jiuwenswarm-execution-v1.md`](jiuwenswarm-execution-v1.md) 与 [`swarmflow-execution-v1.md`](swarmflow-execution-v1.md)。

## 真实观测边界

协议来自对 `jiuwenswarm` 的只读检视：

- `agents/harness/team/handlers/team_monitor_handler.py` 把 SDK MonitorEvent 归一化为 member、task 与 message 事件；
- `agents/harness/team/handlers/workflow_monitor_handler.py` 消费 WorkflowProgress，并由 `workflow_state.py` 聚合 workflow、phase、agent 与 human 状态；
- `agents/swarm/context.py` 明确区分 per-team、per-session 与 per-member 构造上下文；
- `agents/harness/agent_observability.py` 是 Subagent 观测接入点，Subagent session 本身与父 Agent 隔离。

WorkflowProgress 当前的 `WorkflowAgentActivity.tool_call/tool_result` 是保留字段，上游尚未发出结构化数据。因此页面不会从 log、prompt、outcome 或文本关键字推断 Tool 节点。若未来上游增加结构化 tool event，可直接追加事件种类，不需要破坏现有主体层级。

## 主体层级

每个非终止 Swarm 事件必须携带 `subject`：

```json
{
  "id": "subagent:explore",
  "kind": "subagent",
  "label": "Explore Agent",
  "parentId": "member:worker",
  "role": "explorer",
  "contextOwnerId": "ctx:explore"
}
```

支持的 kind：

| kind | 用途 | 常见 parent |
|---|---|---|
| `team` | 团队运行根 | — |
| `workflow` | SwarmFlow run | team |
| `phase` | author/child phase | workflow |
| `member` | leader、teammate 或外部成员 | team |
| `agent` | Workflow 内 Agent node | phase |
| `human` | Workflow 内 Human node | phase |
| `task` | 团队任务 | team/member |
| `subagent` | DeepAgent 创建的独立 Subagent | member/agent/subagent |

`parentId` 只表示结构归属。成员通信使用 `payload.fromSubjectId/toSubjectId` 生成 message edge；任务分配使用 `payload.assigneeId` 生成 assignment edge，不应为了画边而修改父子关系。

## 事件种类

Swarm 专用事件：

- `swarm.team`
- `swarm.member`
- `swarm.task`
- `swarm.message`
- `swarm.workflow`
- `swarm.phase`
- `swarm.agent`
- `swarm.human`
- `swarm.subagent`

`jiuwenswarm` Trace 也允许 Core Runtime 事件。生产者可以把成员或 Subagent 内部的 `agent.invoke`、`model.call`、`tool.call`、`rail.*`、`context.*`、`ability.register` 绑定到同一个 subject。Swarm 主画布仍只显示主体层级；点击结构化 Subagent 节点会进入独立执行画布，展示显式上报的内部活动，不伪造未观测节点。

`swarm.subagent` 必须额外携带结构化 `subagent` 证据。完整字段、稳定性约束和独立执行画布见 [`subagent-runtime-v1.md`](subagent-runtime-v1.md)。

事件 phase 为 `start | end | error | instant`。`payload.status` 可保留上游的 `pending`、`in_progress`、`waiting_for_human`、`in_review`、`completed` 等状态；页面只做有限的显示归一化，原始值仍留在 Inspector。

## Context 所有权

Swarm Context 事件必须提供 `context.ownerId`：

```json
{
  "eventId": "explore:context:1",
  "kind": "context.snapshot",
  "phase": "instant",
  "timestampMs": 1011,
  "spanId": "explore-context",
  "subject": {
    "id": "subagent:explore",
    "kind": "subagent",
    "label": "Explore Agent",
    "parentId": "member:worker",
    "contextOwnerId": "ctx:explore"
  },
  "context": {
    "operation": "replace",
    "ownerId": "ctx:explore",
    "messages": [
      {
        "id": "explore-system",
        "role": "system",
        "label": "Subagent contract",
        "raw": "完整、未截断的 Subagent system prompt",
        "preview": "脱敏后的 Subagent 摘要",
        "tokens": 13,
        "source": "subagent.session"
      }
    ]
  },
  "token": { "used": 13, "delta": 13, "budget": 2048 }
}
```

页面按 owner 分别维护消息生命周期和 Token 轨迹。切换 owner 后，上一步/下一步仍在同一全局事件序列移动，但 Context Window 只重建所选 owner 当时的窗口。消息分段默认显示 `preview` 或浏览器脱敏结果，展开显示 `raw`；连续原文只显示当前 owner 的完整消息并自动跟随到底部。

## 创建和投递

先在页面选择 Swarm Trace 并创建会话，或直接调用：

```http
POST /api/v1/traces
Content-Type: application/json

{
  "owner": "jiuwenswarm",
  "label": "local team run",
  "maxTokens": 32768
}
```

响应返回该 Trace 专用的 `writeToken`。仓内示例可直接投递：

```powershell
$payload = Get-Content -LiteralPath "examples\swarm-runtime-v1.events.json" -Raw
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8765/api/v1/traces/{traceId}/events" `
  -Headers @{ "X-Trace-Token" = "{writeToken}" } `
  -ContentType "application/json" `
  -Body $payload
```

示例只投递确定性事件，不执行任何 Agent 或模型。最后一个唯一事件是 `trace.status/end`；会话关闭后只接受同一 eventId 的幂等重试。

## 画布行为

- 宏观：根节点和直接子节点常显；点击容器逐层展开；当前活跃主体及其祖先路径自动可见。
- 微观：显示当前步骤之前已出现的所有主体。
- 点击有 `contextOwnerId` 的节点会选择对应 Context；也可使用独立 owner 下拉框切换。
- 点击 Subagent 卡片会进入独立执行画布，按当前全局 sequence 展示派发、隔离 session、内部 Core 活动和结果回传；回退时间轴不会泄露未来事件。
- 主体卡按 Team、Workflow/Phase、Member/Agent、Task、Subagent 采用不同视觉语义，同时都保留 JiuwenSwarm 来源 Badge。
- 拖拽期间复用共享实时防重叠算法；磁吸可关闭并调整强度；画布支持缩放、平移、fitView 和 MiniMap。
- Inspector 显示当前事件、主体父子、Context owner、最近活动以及 exact/inferred 源码证据。

## 精确性与安全约束

- 服务端拒绝缺少 subject 的非终止 Swarm 事件。
- 服务端拒绝缺少 `context.ownerId` 的 Swarm Context。
- 服务端拒绝缺少结构化 `subagent` 证据、subject/context owner 不一致或同一 invocation 改变 session/隔离身份的 `swarm.subagent` 事件。
- `agent-core` 会话拒绝 `swarm.*` 事件，防止数据源混淆。
- 静态事件到源码路径的内置映射标记为 `inferred`；只有事件提供 `definition` 才标记 `exact`。
- Trace 只在服务内存中保存，受请求、事件数、单会话字节数、总字节数和 TTL 限制。
- `raw` 可能含敏感信息；不要复制到 title、summary、日志或 payload。写入令牌默认只在折叠的“接入信息”中展示。
