# Subagent Execution Plane V1

## 目标与边界

Subagent Execution Plane 在 Swarm 主体层级之下提供一层独立执行视图：

```text
Parent Agent/Member
  └─ dispatcher tool
      └─ isolated Subagent session
          ├─ child Context
          ├─ Agent / ReAct
          ├─ Rail / Model / Tool / Ability
          └─ final result → parent Context
```

主 Swarm 画布负责 Team、Workflow、Member、Task 与 Subagent 的结构关系；点击 Subagent 卡片后，独立画布才展示该次 invocation 的内部 Core 活动。两层使用同一个全局 event sequence，上一步不会显示未来活动。

## 真实代码语义

V1 来自对两个目标仓的只读检视：

- `agent-core/openjiuwen/harness/tools/subagent/task_tool.py` 通过 `task_tool` 创建 Subagent，并为默认调用生成独立 sub-session；特定类型可以使用可恢复的 sticky session。
- `agent-core/openjiuwen/harness/tools/subagent/session_tools.py` 提供后台 `sessions_spawn` 及 list/cancel 生命周期。
- `jiuwenswarm/server/runtime/agent_adapter/code_agent_rail.py` 的自定义 `AgentTool` 可以同步或后台运行，建立单独 workspace，并继承经过 allow/deny 过滤的父 ToolCard。
- `jiuwenswarm/agents/harness/agent_observability.py` 在 Subagent 首次运行前附加独立 Agent span；`server/runtime/debug_trace/subagent_capture.py` 可采集 child stream，而不把子 Agent 的 model/tool span 误挂到父 Agent。

Team Member 的 stable child `AgentSession` 是团队宿主生命周期，不等于 Subagent。生产者必须按真实派发行为上报，页面不会根据 session 名称或日志文本猜测。

## 结构化事件

每个 `swarm.subagent` 事件必须同时提供：

- `subject.kind: "subagent"`；
- `subject.contextOwnerId`；
- `subagent` observation，且其 `contextOwnerId` 与 subject 完全一致。

示例：

```json
{
  "eventId": "explore:start",
  "kind": "swarm.subagent",
  "phase": "start",
  "timestampMs": 120,
  "spanId": "span:explore",
  "parentSpanId": "span:task-tool",
  "subject": {
    "id": "subagent:explore:42",
    "kind": "subagent",
    "label": "Explore Agent",
    "parentId": "member:worker",
    "contextOwnerId": "ctx:explore:42"
  },
  "subagent": {
    "invocationId": "invoke:explore:42",
    "subagentType": "explore_agent",
    "dispatcher": "task-tool",
    "runMode": "foreground",
    "parentSessionId": "session:parent",
    "sessionId": "session:parent_sub_explore_agent_a1b2c3d4",
    "contextOwnerId": "ctx:explore:42",
    "sessionPolicy": "ephemeral",
    "workspaceIsolation": "subdirectory",
    "toolPolicy": "configured",
    "toolCallSpanId": "span:task-tool"
  }
}
```

字段枚举：

| Field | Values | 说明 |
|---|---|---|
| `dispatcher` | `task-tool`, `agent-tool`, `session-spawn` | 实际派发入口 |
| `runMode` | `foreground`, `background` | 父调用是否等待完成 |
| `sessionPolicy` | `ephemeral`, `sticky` | 每次新 session 或同类型可恢复 session |
| `workspaceIsolation` | `subdirectory`, `shared`, `unknown` | 文件工作区隔离方式，不传绝对路径 |
| `toolPolicy` | `configured`, `inherited-filtered`, `none`, `unknown` | child Tool surface 的来源 |

`toolCallSpanId` 可把父级 `tool.call` 与 Subagent lifecycle 精确关联。`phase: end` 可以附带短 `resultPreview`，`phase: error` 可以附带短 `error`；两者都不是完整内容的存储位置。

同一 Trace 内相同 `invocationId` 的 subject、类型、dispatcher、模式、父/子 session、Context owner 和隔离策略必须保持不变，服务端会拒绝中途变形。

## 内部活动

Subagent 内部事件继续使用既有 Core kinds，并绑定同一个 Subagent subject：

- `agent.invoke`, `agent.react_iteration`, `agent.task_iteration`；
- `context.snapshot`, `context.delta`；
- `rail.chain`, `rail.hook`；
- `model.call`, `model.stream`, `model.usage`, `model.cancel`；
- `tool.call`, `ability.register`。

执行画布按 `spanId / parentSpanId` 恢复父子关系；Model frames 按 `model.invocationId` 聚合，Tool 的 start/end 按 span 聚合。没有结构化事件时不生成对应卡片。Swarm orchestration 边界使用浅紫，内部 Core 活动使用浅青蓝，并同时显示来源文字 Badge。

## Context 隔离

Subagent Context 事件必须使用 observation 声明的 child `contextOwnerId`。父 Context 使用父 owner；Subagent 完成后，只有明确的最终结果 `context.delta` 可以进入父窗口。

完整 prompt、模型输出和工具结果必须放入所属 Context message 的 `raw`，并提供可选脱敏 `preview`。不得把完整原文复制到 `title`、`summary`、`payload`、`resultPreview`、日志或节点 label。页面的消息分段/连续原文规则与其他 Context owner 相同。

## 确定性录制

`openjiuwen.jiuwenswarm` 插件贡献 `swarm-subagent-delegation-v1` runtime recording。页面“Swarm Trace → Subagent 演示”会创建普通的 loopback 内存 Trace，再把录制事件通过同一写入 API 投递；它不执行 Agent、Tool 或模型，也不读取凭据。

录制用于验证：

1. 父 `task_tool` 派发；
2. Subagent 独立 session/context；
3. child Rail、Model、Tool 与 Context observation；
4. final result 回填父 Context；
5. 主时间轴回退时独立画布同步收缩。

## 可选真实执行器

`openjiuwen.subagent-executor` 在同一观察合同之上增加显式“Subagent”运行入口。它不改变画布或事件投影，而是在固定子进程中执行真实 Agent Core 链路：父 `DeepAgent` 由框架 `SubagentRail` 注册 `task_tool`，`TaskTool.invoke` 创建独立 child session/workspace，child `DeepAgent` 完成自己的 ReAct/Rail/Model/只读 Tool 后把结果返回父 Context。

执行 profile 固定为单层、单 child、前台、ephemeral session；父模型只看见 `task_tool`，child 模型只看见 `inspect_delegated_task`。服务端提供状态、启动和取消 API，浏览器不能覆盖 Tool、child type、深度、源码路径、workspace 或命令。完整 profile、安全边界、API、事件映射和无网络框架自检见 [`subagent-execution-v1.md`](subagent-execution-v1.md)。

## 安全与限制

- 通用 Trace API 只校验和存储归一化 JSON；只有用户显式启用并启动的 Subagent Executor 才会在独立固定 bridge 中创建 child、执行 dispatcher。
- Trace 仍是有界、带 TTL 的 memory-only 数据；write token 只授权当前 Trace。
- V1 展示生产者明确提供的 workspace/tool policy 枚举，不接收 workspace 绝对路径或工具凭据。
- 外部 producer 可用 lifecycle 事件表达后台 Subagent；真实 Executor V1 只支持前台 child，并提供整个父子进程的取消按钮。
- 通用协议允许生产者表达嵌套 Subagent（child `parentId` 指向父 Subagent）；真实 Executor V1 明确关闭嵌套派发。
