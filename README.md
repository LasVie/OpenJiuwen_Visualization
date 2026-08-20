# OpenJiuwen Trace Visualization

面向 `agent-core` 与 `jiuwenswarm` 的代码定义、运行链路、Git 变更与辅助开发工作台。当前版本支持确定性演示、Agent Core/Swarm 实时 Trace、真实独立 DeepAgent、真实双成员 JiuwenSwarm Agent Team、真实两阶段 SwarmFlow、真实前台单层 Subagent + OpenRouter 执行、Model Provider 录制回放、本机 SQLite 运行归档与跨运行对比、工作树/commit range/GitHub PR 的节点影响图，以及 Runtime / Definition / Change 当前焦点进入同一只读 Development 证据链。

已交付能力、阶段记录和后续路线见 [`docs/project-roadmap.md`](docs/project-roadmap.md)。

## 本地运行

```powershell
npm install
npm run dev
```

完整校验：

```powershell
npm run check
```

## 绑定本地仓库

本地仓读取通过独立的只读服务完成。启动时必须明确给出允许访问的目录；Repository API 不导入或执行目标仓代码。真实 Agent Core、JiuwenSwarm Agent Team、SwarmFlow 与 Subagent 执行位于显式、可选且彼此独立的隔离子进程边界：

```powershell
python -B services/local-server/scripts/run_server.py `
  --allow-root "C:\Users\soong\Documents\OpenJiuwen_Visualization"
```

服务默认在首个允许根目录的 `.openjiuwen-visualization/runtime-archive.sqlite3` 中增量保存完整 Runtime 原文，并使用 WAL、30 天保留期和 2 GiB 逻辑上限。Development 分析另存到同目录的 `development-sessions.sqlite3`，Local Plugin Host 再用 `plugin-host.sqlite3` 保存生命周期、授权与无原文审计。可用 `--archive-*`、`--development-session-*` 与 `--plugin-host-path` 覆盖；数据库路径必须仍在允许根目录内。

四个真实执行器（独立 DeepAgent、Agent Team、SwarmFlow、Subagent）都使用独立固定 bridge；浏览器不能提交 Python 入口、工作流源码或工具配置。只读扫描烟测：

```powershell
python -B services/local-server/scripts/scan_repository.py `
  --allow-root "C:\Users\soong\Documents\OpenJiuwen_Visualization" `
  --path "C:\Users\soong\Documents\OpenJiuwen_Visualization\agent-core" `
  --summary
```

服务默认地址为 `http://127.0.0.1:8765`。进入页面顶部“定义图”后，可直接选择允许根目录下发现的 `agent-core` 或 `jiuwenswarm`，也可输入白名单范围内的仓库/子目录绝对路径。生成后的定义图支持：

- repository → package → module → class/function 的分层浏览与面包屑回退；
- Agent、Rail、Tool、Context、Workflow、Model、Team 语义分类；
- 全局符号/源码路径搜索、类型过滤和大层级分页；
- `contains`、`imports`、`inherits` 关系与源码行证据；
- class method 独立定义节点，以及 Runtime path + symbol + revision 的精确或显式降级定位；
- 节点详情、拖拽、实时防重叠、磁性调节、缩放和缩略图。
- 在 Definition、Change 与 Tool 详情中按需打开统一源码证据窗口，查看聚焦行、当前工作树状态、revision 对齐和内容哈希。
- 从任意 Definition 或 Change 影响节点进入独立关系画布，按 `contains / imports / inherits`、上下游方向逐节点展开；每次扩展都有明确上限和未显示计数。

页面每次只投影当前焦点和有限数量的子节点，不会把完整仓库的数千节点同时交给 ReactFlow。

重复生成相同 Definition 时，本地服务会先校验有界 Python 输入清单，再复用进程内 LRU 快照。缓存不会落盘，源码/选项/HEAD 或工作树内容变化会导致 miss；超过清单验证上限则明确显示 bypass。完整合同见 [`docs/repository-scan-cache-v1.md`](docs/repository-scan-cache-v1.md)。

### Registered Tools Catalog

“定义图 → Tool 注册表”会只读识别 `@tool`、Tool 子类、顶层 `ToolCard` 与 Ability/Resource 注册调用，并把同一 Tool 收敛成“代码发现 → Host 目录读取授权 → Runtime 注册 → 实际调用”四层证据。独立画布保留静态注册路径和未发生阶段的空缺节点；点击节点可查看稳定 identity、owner/context owner、参数/结果、耗时、错误、源码和原运行步骤。参数/结果默认脱敏，只有显式展开才显示本机原文；同名但跨仓库、跨 revision 或缺 identity 的事件不会自动合并。

完整扫描合同、API、证据等级和限制见 [`docs/tool-catalog-v1.md`](docs/tool-catalog-v1.md)。

源码窗口的路径边界、行范围和工作树语义见 [`docs/source-evidence-v1.md`](docs/source-evidence-v1.md)。

关系画布的分层展开、方向语义和容量边界见 [`docs/relation-explorer-v1.md`](docs/relation-explorer-v1.md)。

### 只读开发辅助

顶部“开发辅助”把一段开发意图投影成九步证据链：开发意图、仓库范围、源码证据、诊断、影响范围、修改建议、测试建议、补丁结构草案和只读边界。基础分析器只读取允许根目录内当前 revision 的 Definition snapshot，不执行目标仓代码、不调用模型，也不请求仓库写权限；OpenRouter 是不覆盖基础证据的独立可选分支。

- Core 与 Swarm 使用独立的仓库身份和色彩语义；
- 显式类、函数、Rail、Tool、Workflow 等目标优先覆盖，泛化词不会挤掉主要证据；
- 每个可展开阶段进入聚焦画布，支持拖拽、缩放、fit、MiniMap、实时防重叠与可调磁吸；
- 证据节点可打开统一只读源码窗口或定位 Definition；
- Runtime 源码事件、Definition 节点和 Change 影响节点都可直接进入 Development，自动选择对应仓库并生成分析，无需重新输入目标；
- 跨平面入口保留 repository/path/symbol/revision，并分别携带事件指标、Definition Runtime 聚合或 Change comparison/hunk/impact；匹配节点固定为首条证据，revision/dirty/歧义/缺失继续显式降级；
- 导航合同不复制 Context、Tool 参数/结果、模型流式正文或 Runtime observations，只传递分析所需的结构化身份与指标；
- 建议保留来源、置信度、风险和测试层次；无法证明的关系继续标记为推断；
- 补丁只输出不可应用的结构草案，不伪装成可执行 diff，也不会修改绑定仓库。
- 每次成功分析自动保存为本机 SQLite/WAL Session；列表只读元数据，点击恢复或导出才读取原始意图与完整结果；
- Session 管理支持恢复、完整 JSON 导出和带二次确认的删除，默认保留 30 天、逻辑上限 2 GiB。
- OpenRouter 增强默认不选择源码；每次调用都要选择 1–3 个有界证据、生成并检查完整外发 JSON，再单次确认；
- 外发只包含开发意图、结构化 Runtime/Change 摘要和所选源码，不包含完整 Context、Tool、Rail/Hook 或既有模型原文；
- 模型流、usage 和终态进入独立 Runtime Trace，画布以紫色建议分支展示，不能覆盖确定性节点或写入仓库。

完整分析合同见 [`docs/development-assistant-v1.md`](docs/development-assistant-v1.md)，本机持久化、迁移和删除边界见 [`docs/development-session-persistence-v1.md`](docs/development-session-persistence-v1.md)，逐次外发预览和模型分支合同见 [`docs/development-openrouter-enhancement-v1.md`](docs/development-openrouter-enhancement-v1.md)。

## Core Runtime

运行链路的数据源可以在“演示 / Core Trace / Swarm Trace”之间切换。Core Trace 创建一个本机实时会话，通过 SSE 接收归一化的 Agent、ReAct、Rail、Context、Model、Tool 和 Ability 事件，并同步增量归档；既可由外部 producer 写入，也可从“Agent Core”面板显式启动真实独立 DeepAgent。

页面把事件顺序直接映射到已有的上一步/下一步、节点高亮、Rail 决策画布和 ContextWindow。停留在最新步骤时自动跟随新事件；回退查看历史后保持当前位置。Context 的分段模式默认脱敏，展开显示原文，连续原文始终保留完整消息。

事件合同、接入请求和 Rail 精确证据规则见 [`docs/core-runtime-v1.md`](docs/core-runtime-v1.md)。

### Agent Core 真实执行

Core Trace 的“Agent Core”入口会先探测独立 Python 环境，然后在固定子进程中导入 `create_deep_agent`。内部运行真实 ReAct loop，模型使用 Agent Core 自带的 OpenRouter client；V1 只注册一个只读 `inspect_input` 工具。输入审查、最终 ContextWindow、模型流、Tool allowlist、工具结果、每轮 ReAct、usage、完成或取消都会进入同一时间轴和 Rail 深入画布。运行环境配置、API、安全边界和事件映射见 [`docs/agent-core-execution-v1.md`](docs/agent-core-execution-v1.md)。

## Swarm Runtime

Swarm Trace 复用同一个实时采集与本机归档服务，但要求每个非终止事件声明稳定 `subject`。画布按真实层级区分 Team、Workflow、Phase、Member、Agent、Human、Task 与 Subagent；成员消息和任务分配显示为不同关系边。宏观模式保留团队骨架并允许逐层点开，运行到深层主体时自动显露当前路径；微观模式一次展开所有已出现主体。

Context 事件必须携带 `context.ownerId`。Team/Member/Agent/Subagent 可以拥有彼此独立的窗口，点击有 Context 的节点或使用 owner 选择器即可切换，消息和 Token 不会跨主体混合。`jiuwenswarm` 现有 WorkflowProgress 尚未提供结构化 tool-call activity，页面不会把日志或 outcome 猜成工具调用。

### JiuwenSwarm Agent Team 真实执行

Swarm Trace 的“Agent Team”入口会在固定 bridge 中运行真实两成员团队：JiuwenSwarm 完成 provider assembly，Agent Core Team Runner、TeamMonitor 和成员 DeepAgent 执行生命周期。Leader 与 Analyst 拥有独立 Context，任务、消息、Rail、Model 与允许的团队工具按主体进入同一可回放时间轴。V1 明确是 `scheduled + inprocess` Agent Team，`enable_swarmflow=false`，不会把它标成 SwarmFlow；浏览器也不能改变 roster、工具、源码路径或运行命令。完整配置、安全边界和事件映射见 [`docs/jiuwenswarm-execution-v1.md`](docs/jiuwenswarm-execution-v1.md)。

### Agent Core SwarmFlow 真实执行

Swarm Trace 的“SwarmFlow”入口运行仓内固定的两阶段脚本：`Understand Input / Analysis Worker → Synthesize Response / Response Worker`。每个 `agent()` 都由真实 `TeamWorkerBackend` 创建一次性 `TeamHarness` 并进入 DeepAgent/ReAct；JiuwenSwarm `WorkflowMonitorHandler` 聚合结构化进度，页面不从日志猜阶段状态。Workflow、Phase、Worker、Rail、Model 与两个独立 Context owner 直接进入现有层级画布和时间轴。V1 串行、无 HITL、无任意脚本上传，最终 Rail 清空模型可见工具 schema 并拒绝全部工具执行。完整边界见 [`docs/swarmflow-execution-v1.md`](docs/swarmflow-execution-v1.md)。

结构化 Subagent 卡片可以进入独立执行画布，按同一时间轴查看 `dispatcher → child session → Context / Agent / Rail / Model / Tool → result`。派发器、前后台模式、父/子 session、workspace 隔离与 Tool 策略都来自显式事件；父 Context 与 child Context 不会合并。页面既保留不执行 Agent/模型的确定性录制，也提供“Subagent”入口运行真实 `Parent DeepAgent → task_tool → analysis_subagent`：父侧只看见 `task_tool`，child 只看见只读 `inspect_delegated_task`，固定单层、单 child、前台执行。观察合同见 [`docs/subagent-runtime-v1.md`](docs/subagent-runtime-v1.md)，真实执行 profile、API 和自检见 [`docs/subagent-execution-v1.md`](docs/subagent-execution-v1.md)。

### Model Provider 录制

Core Trace 的“模型录制”会载入一段厂商无关的确定性记录，不访问任何模型 API。`model.stream`、`model.usage` 与 `model.cancel` 会被投影成流式输出、Token/费用预算、完成或取消状态，并与主时间轴同步回放。输出默认脱敏，显式点击后才展示完整原文；录制帧、Provider、模型和 invocation 身份都由服务端校验。完整合同见 [`docs/model-provider-v1.md`](docs/model-provider-v1.md)。

### OpenRouter 实时调用

OpenRouter 仍是首个 Provider，并保留独立的 provider-only loopback adapter。真实 DeepAgent、JiuwenSwarm Agent Team、SwarmFlow Worker 与 TaskTool Subagent 分别通过自己的 Executor 使用框架 OpenRouter client，避免把普通模型调用误画成 Agent、Team、Workflow 或 child。Development 也可在完整外发预览和逐次确认后复用该 Provider 生成独立只读建议分支。API key 仅在本地服务环境变量中，默认模型白名单只有 `openrouter/free`。Provider 配置与底层安全边界见 [`docs/openrouter-provider-v1.md`](docs/openrouter-provider-v1.md)。

### 运行档案与跨运行对比

顶部“运行档案”管理本机 SQLite/WAL 中保存的 Core 与 Swarm Session。列表支持搜索、owner 筛选和分页；详情默认只读取脱敏摘要，只有逐事件点击“展开原文”或切换到“连续原文”时才读取完整内容。连续原文保持消息间隔并自动跟随最新内容。

用户可以删除已结束 Session，原文、摘要、Token、费用与事件会一起级联删除；也可以显式导出包含完整原文的 JSON。对比模式只读取脱敏数据，按源码 identity（缺失时按 runtime kind + subject）对齐两次运行，并展示事件、Token、费用、Context 与节点结构差异。完整存储、隐私、保留和 API 合同见 [`docs/runtime-archive-and-compare-v1.md`](docs/runtime-archive-and-compare-v1.md)。

### Git Change Plane

顶部“变更图”通过本地服务只读比较 `HEAD ↔ 工作树`、`merge-base ↔ head`，或读取公共 GitHub PR，再把文件 hunk 映射到 AST 符号、上层容器和 imports/inherits 等关系节点。PR head 与当前干净检出一致时才使用 exact 行号，否则明确降级为 inferred；工具不会 fetch、checkout 或修改本地/远端状态。完整合同见 [`docs/git-change-plane-v1.md`](docs/git-change-plane-v1.md) 与 [`docs/github-pull-request-v1.md`](docs/github-pull-request-v1.md)。

### Runtime、Definition 与 Change 收敛

带结构化 `definition` 的 Core/Swarm 事件可以从步骤 inspector 定位到精确 AST 方法或类；Definition inspector 汇总本次 Trace 的 span、事件、Token、最后状态与最近步骤，并可返回原运行 sequence。继续进入 Change 平面后，实际经过的源码会作为 `runtimeObserved` 证据叠加在 direct/container/dependent 影响之上；目标不在当前 diff 时只显示明确空结果，不制造节点。匹配严格使用 repository、规范 path、exact symbol 与 revision，缺失、脏工作树或不一致会显式降级。完整合同见 [`docs/runtime-definition-change-convergence-v1.md`](docs/runtime-definition-change-convergence-v1.md)。

### 模块控制中心

顶部“模块”包含“工作台模块”和“Local Plugin Host”两个视图。工作台模块管理浏览器 contribution 与依赖图；Host 管理内置 OpenRouter/Tool Catalog 的来源、生命周期、网络/secret 权限、opaque credential handle 与本机审计。每个模块可独立请求开启或关闭；依赖缺失时保留用户开启意图，恢复后自动重新启用。Runtime 来源、Definition/Change 导航、Tool 注册表、Model 录制、Rail 和 Subagent 深入入口都从当前 Workbench 与 Host 快照推导，不会继续暴露已关闭或被撤权模块的数据贡献。

浏览器偏好只保存在当前浏览器，并可一键恢复 manifest 默认值；Host 状态与授权保存在本机 SQLite/WAL。二者都不保存 Trace 原文或凭据值。状态合同、依赖图和安全边界见 [`docs/plugin-control-v1.md`](docs/plugin-control-v1.md) 与 [`docs/plugin-host-v1.md`](docs/plugin-host-v1.md)。

完整事件矩阵、层级规则和可直接投递的示例见 [`docs/swarm-runtime-v1.md`](docs/swarm-runtime-v1.md) 与 [`examples/swarm-runtime-v1.events.json`](examples/swarm-runtime-v1.events.json)。

## 视觉语义

- 浅青蓝：`agent-core`，负责 Agent 生命周期、ReAct、Context、Model、Tool 和 Rail。
- 浅紫：`jiuwenswarm`，负责请求入口、会话宿主、能力装配和响应出口。
- 暖橙：Rail 当前审查动作、Hook 连接、mutation 或控制信号。

Context 的“消息分段”默认显示脱敏精简摘要，用户可逐条展开完整原文；“连续原文”始终按实际追加顺序展示完整内容，并在新消息进入时自动跟随到底部。

点击任意 Rail 卡片会进入独立决策画布：可逐次切换该 Rail 在整条轨迹里的真实调用帧，并查看 `READ → DISPATCH → CHECK × 3 → APPLY → EMIT` 全过程。

## 代码结构

```text
src/
├─ adapters/                   # 本地服务、GitHub PR 等外部数据源客户端
├─ components/                 # 页面编排与 ReactFlow 适配组件
├─ kernel/                     # 版本化图协议、插件协议与注册器
├─ domain/
│  ├─ runtime/                 # agent-core / jiuwenswarm 来源语义
│  └─ trace/                   # 通用图到当前 Trace UI 的投影
├─ data/
│  ├─ fixtures/                # 确定性数据构造器
│  └─ scenarios/               # 一个文件一个演示轨迹
├─ features/
│  ├─ context-window/          # 脱敏、原文和展示 Token 模型
│  ├─ agent-core-execution/    # DeepAgent 状态探测、运行表单、取消与输入关联
│  ├─ jiuwenswarm-execution/   # Agent Team 状态探测、运行表单、取消与主体关联
│  ├─ swarmflow-execution/      # 固定 Workflow 状态探测、运行表单、取消与 Trace 关联
│  ├─ subagent-execution/      # 真实 TaskTool child 状态探测、启动、取消与 Trace 关联
│  ├─ core-runtime/            # Agent Core 事件投影
│  ├─ definition-plane/        # 静态定义图与 Tool 注册表子工作台
│  ├─ development-assistant/  # 确定性诊断、Session 与逐次确认的 OpenRouter 只读分支
│  ├─ plugin-control/          # 插件依赖、启停、持久化与工作台可用性
│  ├─ plugin-host/             # Host 生命周期、权限、凭据句柄与本机审计界面
│  ├─ openrouter-runtime/      # Provider-only OpenRouter 调用组件（底层模块）
│  ├─ rail-review/             # Rail 调用帧、决策画布和证据面板
│  ├─ relation-explorer/       # Definition/Change 共享节点关系深入画布
│  ├─ runtime-trace/           # 通用内存 Trace/SSE 会话生命周期
│  ├─ trace-archive/           # 本机 Session 管理、按需原文与跨运行对比
│  ├─ source-viewer/           # Definition/Change/Tool 共享只读源码窗口
│  ├─ swarm-runtime/           # Swarm 层级、主体 Context 与动态画布
│  ├─ subagent-runtime/        # Subagent 派发、隔离 session 与内部执行画布
│  ├─ tool-catalog/            # Tool 声明、注册路径与 Runtime 观察画布
│  └─ trace-graph/             # 可调磁吸、实时节点避碰与共享画布控件
├─ plugins/                    # Core、Swarm、归档、集成边与轨迹数据贡献者
├─ shared/ui/                  # 无业务状态的通用 UI
├─ state/                      # 回放状态与纯工具函数
├─ types/                      # 兼容导出；稳定合同由 kernel 管理
└─ workbench/                  # 组合默认插件并生成当前工作台快照
services/
└─ local-server/               # 只读索引、Trace/归档、Plugin Host、Provider 与固定执行 bridge
examples/                       # 可直接投递的归一化事件示例
```

扩展约束、数据流和新增场景步骤见 [`docs/architecture.md`](docs/architecture.md)。
