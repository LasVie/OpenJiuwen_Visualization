# Real Subagent Executor V1

更新日期：2026-08-19

## 目标与定位

Real Subagent Executor V1 在已有 `swarm.subagent` 观察合同和独立 Subagent 画布之上，运行一条真实且有界的 Agent Core 委派链：

```text
Parent DeepAgent
  → SubagentRail 注册 task_tool
  → TaskTool.invoke
  → DeepAgent.create_subagent
  → Child DeepAgent（独立 session / Context / workspace 子目录）
  → child result 返回 task_tool
  → Parent DeepAgent 综合最终结果
```

它不是 JiuwenSwarm Agent Team，也不是 SwarmFlow。V1 只验证前台单 child 的真实创建、运行、隔离、回传与可视化，不把“未来可扩展”误写成当前能力。

## 固定执行 Profile

| 维度 | V1 固定值 |
|---|---|
| Runtime ID | `agent-core-task-tool-subagent` |
| 上游入口 | `openjiuwen.harness.tools.subagent.task_tool.TaskTool.invoke` |
| Dispatcher | `task-tool` |
| Run mode | `foreground` |
| Child type | `analysis_subagent` |
| 最大深度 | 1 |
| 最大 child 数 | 1 |
| Session policy | `ephemeral` |
| Workspace isolation | `subdirectory` |
| Context ownership | `per-agent` |
| Provider | OpenRouter |
| 同时运行 | 最多 1 个 Subagent bridge |
| SwarmFlow | `false` |

父 Agent 的最终模型可见工具只有 `task_tool`。child 的最终模型可见工具只有只读 `inspect_delegated_task`；它只返回字符、行、词、短哈希与 URL/code-fence 标记，不访问文件、Shell、Git、网络、MCP、Skill 或其他 Agent。

## 双重 Tool 边界

Agent Core 的 `SubagentRail` 负责真实注册 `task_tool`，但 V1 不只依赖注册配置：

1. `SubagentBoundaryRail` 使用极低优先级 `-1_000_000`，在所有框架 Rail 完成 schema 贡献后最后运行；
2. `before_model_call` 按父/子角色过滤最终 Tool schema；
3. `before_tool_call` 再次核对实际工具名，未命中固定 allowlist 时设置 `_skip_tool` 并返回拒绝 ToolMessage；
4. `ability.register` 只记录真实模型调用最终可见的 schema，不从 prompt 或配置推断；
5. 浏览器不能提交 Tool、child type、深度、workspace、解释器、源码根或命令。

父子都关闭通用 Agent、异步 Subagent、嵌套 Subagent、系统操作、并行 Tool call 与多模态图片读取。安全 Rail 保持开启，child 工作目录由 `DeepAgent.create_subagent` 放入父 workspace 的子目录。

## 服务 API

### `GET /api/v1/subagents`

返回无凭据运行时描述、固定 profile、模型白名单、限制与诊断。`?refresh=1` 强制重新执行 import probe。

### `POST /api/v1/subagents/invocations`

请求头：

```text
X-Trace-Token: <ephemeral trace write token>
Content-Type: application/json
```

请求体只接受：

```json
{
  "traceId": "tr_...",
  "modelId": "openrouter/free",
  "input": "需要委派的完整任务",
  "systemPrompt": "可选的父 Agent 补充约束",
  "maxOutputTokens": 512
}
```

Trace 必须属于 `jiuwenswarm`，因为 `swarm.subagent`、父子 subject 层级和多 owner Context 使用 Swarm Runtime 的严格校验。响应只返回 invocation、父 session、固定 child type 与 child subject ID；不会返回 key、源码路径、workspace 或命令。

### `POST /api/v1/subagents/invocations/{id}/cancel`

使用同一 Trace authority 终止固定 bridge 进程，从而同时停止父 DeepAgent 和前台 child。已接收的事件保留；若 child 已开始但尚未结束，adapter 会补一个身份不变的取消终态，再关闭父主体和 Trace。

## 事件与画布映射

| 真实边界 | 规范事件 | 关键证据 |
|---|---|---|
| bridge 启动 | `trace.status/start` | 固定 profile 已进入子进程 |
| 父 DeepAgent | `swarm.member` + Core events | 父 session、父 subject、父 Context owner |
| `TaskTool.invoke` 创建 child | `swarm.subagent/start` | dispatcher、runMode、父/子 session、workspace/session/tool policy、tool span |
| 父/子 Rail | `rail.hook` | 审查项、schema 移除、控制信号、精确优先级 |
| 父/子模型 | `model.call/stream/usage` | 独立 invocation、最终窗口、usage |
| 固定工具 | `ability.register` + `tool.call` | 角色、最终可见 schema、执行结果 |
| 父/子 Context | `context.delta/snapshot` | 不同 `context.ownerId`、完整 raw、脱敏 preview、Token |
| child 返回 | `swarm.subagent/end` | 与 start 相同身份、脱敏 result preview |
| 父综合完成 | `swarm.member/end` + `trace.status/end` | 父子链路完整终态 |

主 Swarm 画布在运行到 child 后显示 Subagent 主体；点击 child 卡片进入已有独立画布，按同一 sequence 查看 `dispatcher → child session → Context / Agent / Rail / Model / Tool → result`。右侧 Context owner 选择器在父与 child 窗口之间切换，不合并消息或 Token。

## 原文与诊断边界

- 完整输入、模型窗口与 Tool observation 只写入所属 Context message 的 `raw`；
- 消息分段模式默认使用 `preview`，用户显式展开后才显示 `raw`；
- 连续原文模式继续按既有合同展示完整 owner Context；
- Tool/Rail 的紧凑详情使用有界摘要或字符统计，错误元数据不复制输入、provider body 或日志；
- bridge stdout 只有固定前缀、大小受限的 JSON 记录会被 adapter 接收，其余框架日志忽略；
- Runtime Trace authority 与实时状态只在 local service 内存保存；完整 Context 和归一化事件同步写入本机归档。

## 环境配置

Subagent 与独立 Agent Core 共用网页管理的 `core-env`。用户只需在“连接”中绑定 Agent Core 仓、创建并校验环境、录入 OpenRouter key；无需设置 Python 或 source 环境变量。每次首次调用前会自动对账，只有匹配当前仓库与 lock fingerprint 的 active generation 才能运行。

Subagent bridge 使用 active manifest 的精确 Python 与 Agent Core root，不继承 Companion 的 `PYTHONPATH`。运行面板显示 fingerprint/Python/uv，Trace 首事件记录环境与 Agent Core revision；与 Agent Core 并发时只能复用同一 generation，不能在运行中切换。完整合同见 [`managed-environments-v1.md`](managed-environments-v1.md)。

## 无网络框架自检

开发者自检使用确定性 Model 替身，但真实执行 `create_deep_agent → SubagentRail → task_tool → create_subagent → child DeepAgent`，不会访问 OpenRouter；该命令不是普通配置流程：

```powershell
$env:PYTHONPATH = "C:\path\to\agent-core"
& "C:\path\to\agent-core-python.exe" -B `
  services/local-server/scripts/subagent_bridge.py --self-test
```

自检要求：

- 父最终可见 Tool 集严格等于 `{task_tool}`；
- child 最终可见 Tool 集严格等于 `{inspect_delegated_task}`；
- 观察到真实 child sub-session，且与父 session 分离；
- 观察到 `swarm.subagent` start/end、父子主体和完整 Core 事件；
- 父/子 Context owner 各自包含确定性最终回答；
- Trace 存在终止事件。

## V1 明确不支持

- 多 child、并行委派、后台 session spawn、sticky/resume；
- child 再创建 Subagent；
- 文件、Shell、Git、网络、MCP、Skill、浏览器或用户注册工具；
- Agent Team roster、SwarmFlow Workflow/Phase/Human 控制；
- 跨服务重启续跑、语义级跨运行 diff 或远端执行；完整事件与 Context 仍按 Runtime Archive 合同保存在本机。

这些能力需要新的 profile、权限和事件语义，不能通过放宽 V1 请求字段隐式开启。
