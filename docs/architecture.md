# Visualization Web Architecture

## 产品边界

项目面向 OpenJiuwen 的代码理解、运行调试与变更影响分析。一个工作台组合三种相互关联的数据平面，并由一个控制平面决定当前装配：

- Definition：从仓库、配置和注册表得到的定义图。
- Runtime：确定性回放或真实 Agent/Workflow 运行事件。
- Change：本地 Git、commit 和 GitHub PR 的变更与影响关系。
- Modules：插件启停、依赖状态与 capability 可见性。

浏览器只负责交互与渲染。读取本地仓库、运行 Python、执行 Git 或调用模型的能力必须进入独立本地服务，不允许 React 组件直接访问凭据或执行目标仓代码。Repository API 始终只读且不 import 目标仓；真实 Agent Core 只通过显式启动的固定子进程 bridge 运行。

## 依赖方向

```text
App / components
      ↓
features ─────→ shared
      ↓
workbench → domain projection
      ↓             ↓
plugins ────────→ kernel contracts
      ↑
fixtures / future adapters
```

规则：

1. `kernel/contracts/` 保存可序列化、无 React 依赖的稳定协议。
2. `kernel/plugin-registry.ts` 只负责插件解析、依赖、归属和跨贡献校验。
3. `plugins/<id>/` 拥有自己的定义图、适配器或轨迹贡献，不导入其他插件内部文件。
4. `workbench/` 选择插件集合；页面不得自行拼接插件数据。
5. `domain/trace/projection.ts` 将通用图投影成现有 ReactFlow View Model，ReactFlow 坐标不进入通用节点顶层。
6. `features/<name>/` 拥有该能力的模型、组件、测试和公开入口；跨功能只从公开入口导入。
7. `data/scenarios/` 一个轨迹一个文件；禁止重新创建巨型场景总文件。
8. `components/` 负责页面编排和第三方库适配，不保存新的领域规则。

## Graph Kernel V1

`GraphNodeRecord` 与 `GraphEdgeRecord` 是所有数据源的共同协议。节点至少声明：

- 全局稳定 `id`、`kind`、`owner`。
- `plane` 与 `level`，用于宏观/微观渐进展开。
- 用户可读的 `label` 与 `summary`。
- 可审计 `evidence`，包含来源、置信度和可选源码引用。
- 可选 `attributes`，只保存 JSON 可序列化的领域数据。
- 可选命名 `views`，保存某一投影视图的 renderer 与首选布局。

通用图是语义权威，ReactFlow 节点只是当前 UI 的投影结果。未来同一节点可以同时投影到主链路、调用树、Context 时间轴和 PR 影响图。

当前 fixture 使用短 ID 以兼容既有回放。仓库扫描器接入后，定义节点采用以下稳定来源键：

```text
repository@revision:path:symbol
```

运行节点使用 `trace_id + span_id`，并通过 SourceReference 指向定义节点；PR 节点使用 base/head revision 与 diff hunk 证据。

## 插件合同

每个插件提供 manifest 和纯 `contribute()`：

- `id`、版本、Plugin API 版本。
- 默认启用状态、稳定 group 与依赖插件。
- 能力列表，例如 `graph.definition.agent-core`、`trace.replay`。
- 可选图节点、边和轨迹场景。

注册器按依赖拓扑顺序解析插件。关闭一个插件时，依赖它的插件进入 `blocked`，不会留下悬空边或半可用场景。注册器拒绝重复 ID、缺失依赖、依赖环、悬空边和无效轨迹引用。

`features/plugin-control/` 保存最小浏览器覆盖项，并在每次变化后重新调用同一个注册器生成 Workbench snapshot。`requestedEnabled` 表示用户意图，`state` 表示解析后的实际状态；被依赖阻塞的模块不会丢失开启意图。页面导航、Runtime source、图投影和录制入口只读取当前 snapshot。完整合同见 [`plugin-control-v1.md`](plugin-control-v1.md)。

当前默认模块：

| Plugin | Responsibility |
|---|---|
| `openjiuwen.agent-core` | DeepAgent、ReAct、Context、Model、Tool、Rail |
| `openjiuwen.jiuwenswarm` | Swarm 请求/响应定义与 Team/Workflow/Subagent Runtime |
| `openjiuwen.model-provider` | Provider 流、用量、取消与确定性录制回放 |
| `openjiuwen.openrouter-provider` | 服务端 OpenRouter 调用、模型白名单、流式 Trace 与取消 |
| `openjiuwen.agent-core-executor` | 隔离执行真实 DeepAgent/ReAct，并将 Rail、Context、Tool 与 OpenRouter 事件写入 Trace |
| `openjiuwen.git-change` | 工作树、commit refs 与节点级影响映射 |
| `openjiuwen.github-pull-request` | GitHub PR 只读文件变更、远端 head 对齐与节点影响映射 |
| `openjiuwen.tool-catalog` | Tool 声明、静态注册路径与 `ability.register` 运行确认 |
| `openjiuwen.integration` | Core 与 Swarm 的跨仓因果边 |
| `openjiuwen.deterministic-replay` | 无网络依赖的可重复轨迹 |
| `openjiuwen.local-repository` | 只读本地仓服务、静态定义图、有界源码证据与 Git Change 客户端，默认开启 |

`openjiuwen.agent-core` 和 `openjiuwen.jiuwenswarm` 分别注册 `openjiuwen.agent-core.runtime`、`openjiuwen.jiuwenswarm.runtime` 数据源。Runtime source 只贡献协议能力和 transport 元数据；通用网络连接、状态合并与 SSE 生命周期由 `features/runtime-trace/` 管理，Core/Swarm feature 各自完成领域投影。`openjiuwen.agent-core-executor` 只增加显式执行入口，依赖 Core 和 OpenRouter 两个模块；组件不会读取 Python 对象或原始日志格式。

后续插件必须优先复用现有 capability；只有出现新的数据或交互边界时才扩充协议。

## Trace 来源语义

当前 Trace 投影只支持两个运行时 owner：

- `agent-core`：Agent、ReAct、Context、Model、Tool、Rail 和 Hook 执行。
- `jiuwenswarm`：Channel/Server 请求边界、会话宿主、Swarm 装配、调度和响应出口。

颜色只是辅助线索；所有节点还必须显示文字 Badge，避免仅靠颜色表达来源。Git、模型 Provider 和其他 owner 可以先存在于通用图中，只有相应 View 支持后才投影到主链路。

## Rail 审查合同

新增 Rail 时必须在 `features/rail-review/model.ts` 注册：

- `targetLabel`：用户可读的审查对象。
- `targetPath`：对应运行时载荷字段。
- `examines`：Rail 为什么读取这些内容。
- `aliases`：可匹配的实际 Hook/Rail 名称。
- `checks`：按执行顺序排列的检查项。

紧凑审查面板使用 `READ → CHECKS → EMIT`；独立决策画布展开为 `READ → DISPATCH → CHECK × 3 → APPLY → EMIT`。`buildRailReviewFrames` 负责把同一 Rail 在整条轨迹中的每次 Hook 调用转换成可切换帧，实际 Trace 接入后只替换 snapshot/frame 数据，不改画布结构。

## 画布布局合同

主链路和 Rail 决策画布共用 `features/trace-graph/` 的磁吸算法。磁吸可在画布内关闭，并通过强度值同时调整避让间隔和释放时的网格粒度。拖拽期间保持当前卡片跟随指针，让同一父画布中的相邻卡片按实测尺寸实时、连续让位；释放时再落到最近的合法网格位置。DeepAgent 内部节点也参与避让，但主链和工具分支各自受父容器语义边界约束，不能被推离所属层级。Rail 决策画布在进入、切换调用帧以及节点首次完成测量后自动 `fitView`。

## 新增确定性场景

1. 在 `data/scenarios/` 创建独立文件，并使用 `data/fixtures/builders.ts`。
2. 从 `openjiuwen.deterministic-replay` 插件贡献场景，不在索引文件放大段 fixture。
3. 所有 `activeNodeIds`、`activeEdgeIds` 必须存在于默认插件解析后的图中。
4. 每条 Context 消息必须同时保留完整 `raw`；需要人工摘要时提供 `preview`。
5. 运行 `npm run check`，确保引用、Token 预算和 ID 唯一性通过。

## 基础适配交付顺序

以下顺序已经形成可组合的 V1 基线，后续能力继续沿同一依赖方向扩展：

1. Local Repository 插件：静态 AST 索引、源码证据、增量 revision 缓存。
2. Core Runtime 插件：Span、Rail Hook、ContextDelta、Ability 注册事件。
3. Swarm Runtime 插件：Team/WorkflowProgress、并行 Agent、Subagent 调用树与 Context owner 隔离。
4. Model Provider 插件：流式模型调用、预算、取消和确定性录制回放。
5. Git/GitHub 插件：工作树、commit、PR base/head 与节点级影响映射。

所有上游格式必须在 adapter 层归一化；Web 组件不得直接读取 Python 日志、Git 输出或 Provider 响应结构。

## Local Repository V1

`services/local-server/` 是浏览器与本地文件系统之间的安全边界。服务启动时显式接收允许根目录，只绑定 loopback，并提供版本化 JSON API。首版扫描器执行以下只读流程：

1. 规范化请求目录，确认请求目录及其 Git 根均位于允许范围。
2. 通过无 shell 的 Git 参数调用读取 root、HEAD、branch 与 working-tree 状态。
3. 遍历限制范围内的 Python 文件，跳过测试目录、缓存、构建目录、symlink 和 junction。
4. 使用 `ast.parse` 提取 package、module、class 和可选 top-level function。
5. 将命名、基类、装饰器和方法签名归一化为 JSON attributes。
6. 生成 `contains`、可解析的本地 `imports` 与无歧义 `inherits` 边。

OpenJiuwen 的 Agent、Rail、Tool、Context、Workflow、Model 与 Team 目前通过名称和基类信号分类，并保留 `static/exact` 源码证据。动态注册和运行时装饰结果不会被静态扫描伪装为确定事实；后续由 Runtime 插件用 `runtime-confirmed` 证据覆盖或补充。

### Definition Workbench 投影

页面不会把仓库完整图直接渲染为一个 ReactFlow 实例。`features/repository-browser/model.ts` 先建立父子、入边和出边索引，再以当前焦点节点生成最多 16 个成员的可见子图：

- 有子节点时显示焦点与直接子节点；叶节点显示一跳非 `contains` 关系。
- 面包屑沿 `parentId` 回溯，搜索则在完整图上按 label、kind、source path、symbol 与 summary 排序。
- 类型过滤和分页只改变视图投影，不修改 Graph Kernel snapshot。
- Definition 画布复用 Trace 画布的磁吸与实时避碰算法，但位置仍是临时 View State，不写回语义图。

这样单仓数千节点仍可渐进浏览，也为未来把 Runtime span、Tool registry 与 Git change 叠加到同一稳定节点保留了空间。

### Definition Scan Cache

`repository.scan.cache.memory` 在服务进程内保存最多 8 个 Definition snapshot，默认 TTL 为 300 秒，并同时执行单条 24 MB、总计 96 MB 的序列化快照预算。缓存键包含规范 repository root、scan scope 与完整 `ScanOptions`；每次命中前都重新构造 Python 输入清单，并把路径、大小、时间戳和文件内容纳入 SHA-256 指纹，因此 HEAD、工作树内容、扫描范围或选项变化都会产生 miss。

指纹最多读取 128 MB；超过上限或读取期间发生文件竞态时返回 `bypass` 并正常执行 AST scan。新 scan 完成后还会复验输入指纹，避免把解析期间发生变化的工作树写入缓存。缓存响应是深拷贝，只存在于内存，不保存 Source Viewer 文本、Trace、凭据或 GitHub 响应。完整合同见 [`repository-scan-cache-v1.md`](repository-scan-cache-v1.md)。

### Source Evidence Viewer

`repository.source.read` 把 Definition、Change 与 Tool 的源码引用接到同一个按需读取边界。浏览器只能提交已选 repository path、repository-relative source path 和有界行范围；服务再次校验 scan scope、链接/junction、文件类型、大小、编码和行号，再返回当前工作树的行号文本与 SHA-256。

`features/source-viewer/` 拥有请求生命周期、modal、焦点、聚焦行和 revision/dirty warning，各业务 Inspector 只传 repository identity 与已有 source reference，不重复实现文件读取。历史 blob、编辑和 IDE 跳转不是该 capability 的隐式扩展。完整合同见 [`source-evidence-v1.md`](source-evidence-v1.md)。

### Node Relation Explorer

`graph.definition.relation-explorer.v1` 在 Graph Kernel snapshot 之上提供共享的逐层关系投影。Definition Inspector 与 Change 影响节点只传稳定 node id、repository identity 和同一份 Definition index；`features/relation-explorer/` 负责方向/关系筛选、展开集合、有界投影、自动布局、磁吸避碰和节点级源码证据。

关系画布不会复制或改写规范图，也不会在浏览器重新分析源码。起点始终先展示一跳关系，只有显式展开可见节点才读取 snapshot 中的下一层；每节点最多 18 条关系、全图最多 64 个节点，达到边界必须显示未投影计数。完整合同见 [`relation-explorer-v1.md`](relation-explorer-v1.md)。

## Registered Tools Catalog V1

Tool Catalog 是 Definition 平面的独立插件和子工作台。`services/local-server/` 通过 AST 识别 `@tool`、Tool 子类、顶层 `ToolCard` 以及 Ability/Resource 注册调用；前端 `features/tool-catalog/` 再把结果与当前 Trace 的 `ability.register` 事件投影到同一条证据链。

目录严格区分 declaration、static registration 与 runtime observation。注册点只有在参数或唯一名称能关联声明时才连到 Tool；无法静态求值的工厂、循环与反射路径保留为 `dynamic`，不能借助命名猜成运行事实。静态 linked 状态也不能替代 Runtime 事件。

`openjiuwen.tool-catalog` 依赖 `openjiuwen.local-repository`，贡献只读、`python-ast`、不导入目标代码的 source contract。Definition 顶层编排只负责在代码定义与 Tool 注册表之间切换，Tool 搜索、过滤、画布和 inspector 均封装在 feature 内。完整合同见 [`tool-catalog-v1.md`](tool-catalog-v1.md)。

## Core Runtime V1

Core Runtime 使用 `traceId + sequence` 作为运行时顺序权威，并用 `spanId / parentSpanId` 保留后续调用树扩展能力。事件种类覆盖 Agent invoke、用户消息、task/ReAct iteration、model/tool call、Rail callback、Context snapshot/delta、Ability 注册和 Trace 状态。

本地服务为每次运行创建有界、自动过期的内存会话：写入需要独立 token，读取依赖高熵 Trace ID，SSE 使用 `Last-Event-ID` 恢复。浏览器先按 sequence 幂等合并，再由 `features/core-runtime/model.ts` 投影为现有 `TraceScenario`；因此确定性 fixture 与真实 Runtime 共用画布、时间轴、Context 和 Rail 详情组件。

框架 callback 只能生成 `rail.chain` 证据。`rail.hook` 的 mutation、control signal 和 examines 只有显式探针提供且标记 `exact=true` 时才作为单 Rail 决策展示，防止把链级耗时误标成某个 Rail 的内部过程。完整协议见 [`core-runtime-v1.md`](core-runtime-v1.md)。

## Swarm Runtime V1

Swarm Runtime 与 Core Runtime 共用 `traceId + sequence` 顺序和 loopback 内存服务，但增加稳定主体引用：

```text
subject.id + subject.kind + subject.parentId
```

`subject` 形成 Team → Workflow/Member → Phase/Task → Agent/Human/Subagent 的可渐进层级；消息和任务分配是跨主体关系，不改变结构父子关系。Swarm-owned Trace 的所有非 `trace.status` 事件必须带 `subject`，Context 事件还必须带 `context.ownerId`。这样一个任务可以结构上属于 Team，却明确读取某个 Member 的 Context；Subagent 也能拥有与父 Agent 完全不同的窗口。

`features/swarm-runtime/model.ts` 只从显式 subject、payload relation 和 Context owner 投影，不从标签猜层级。静态源码路径仅标记为 `inferred`；生产者提供 `definition` 时才标记 `exact`。宏观视图只展示骨架、用户展开分支与当前活跃祖先链，微观视图展示当前步骤前已出现的全部主体。

对 `jiuwenswarm` 的只读检视确认了两个真实边界：`TeamMonitorHandler` 输出 member/task/message，`WorkflowMonitorHandler` 聚合 WorkflowProgress 的 workflow/phase/agent/human。上游 `WorkflowAgentActivity` 当前明确保留 tool-call 字段但尚无结构化数据，因此 V1 不从日志、prompt 或 outcome 构造虚假 Tool 节点。完整协议见 [`swarm-runtime-v1.md`](swarm-runtime-v1.md)。

## Subagent Execution Plane V1

Subagent 是 Swarm 主体层级下的独立执行边界，不等同于 Team Member 的 child AgentSession。`swarm.subagent` 必须提供结构化 observation，明确 dispatcher、前后台模式、父/子 session、Context owner、session policy、workspace isolation 与 Tool policy；同一 invocation 的身份字段由服务端保持稳定。

`features/subagent-runtime/` 将父 dispatcher、合成的 session boundary 和绑定同一 subject 的 Core events 投影为独立 ReactFlow。Model frames 按 invocation 聚合，Tool start/end 按 span 聚合，边优先使用 `spanId / parentSpanId`；主时间轴 sequence 是可见性权威，不能展示未来帧。orchestration 节点保持 Swarm 紫色，child Core 活动使用 Core 青色。

确定性录制通过通用 `runtimeRecordings` 插件贡献点进入 workbench，再走真实 loopback Trace API，页面不直接拼装事件。完整协议见 [`subagent-runtime-v1.md`](subagent-runtime-v1.md)。

## Model Provider V1

Model Provider 作为独立插件注册 adapter 与确定性 recording，不把厂商 SDK 或凭据带入 React。Runtime 协议在 `model.call` 基础上增加 `model.stream`、`model.usage` 和 `model.cancel`，并用稳定 `invocationId` 把输出 delta、Token/费用、预算、结束原因和取消原因归并到同一次调用。

`features/model-runtime/` 按当前 Trace sequence 重建调用，因此上一步不会看到未来 delta。输出默认脱敏，完整输出需要显式展开；费用以整数微单位保存，页面不推断价格。默认 recording 通过同一个 loopback 内存 Trace endpoint 加载，验证整条 Provider 观测链但不执行真实模型请求。

`openjiuwen.openrouter-provider` 是首个实时实现。`features/openrouter-runtime/` 只读取无凭据注册表、采集模拟输入并控制调用；本地服务固定 OpenRouter 域名、持有 key、解析 SSE、执行取消，再写回同一 Trace。完整合同见 [`model-provider-v1.md`](model-provider-v1.md) 与 [`openrouter-provider-v1.md`](openrouter-provider-v1.md)。

真实独立 Agent 由 `features/agent-core-execution/` 与可选 subprocess adapter 提供。网页只提交 Trace authority 和有界运行参数；bridge 从指定 source checkout 导入 `create_deep_agent`，让 Agent Core 自身执行 ReAct、Rail、AbilityManager 和 OpenRouter Model Client，再输出规范事件。完整边界见 [`agent-core-execution-v1.md`](agent-core-execution-v1.md)。

## Git Change Plane V1

Git Change 插件把 `working-tree` 与本地 `base/head` 比较归一化为 change set。服务端只通过无 shell 参数调用读取 porcelain status、name-status、numstat、merge-base 和零上下文 patch；ref 先解析为 commit SHA，路径再规范化，所有响应均声明 `writeOperations: false`。

前端并行取得 change set 与当前 Python AST Definition snapshot。hunk 与完整符号范围相交形成 direct impact，祖先形成 container impact，非 contains 关系形成 dependent impact。只有当前检出与比较 head 对齐时行号证据才是 exact；历史 ref、脏检出、删除、重命名和二进制会降级为 inferred。完整协议见 [`git-change-plane-v1.md`](git-change-plane-v1.md)。

`openjiuwen.github-pull-request` 通过独立 adapter 把 GitHub PR metadata 与 files endpoint 归一化到同一个 change set，不让 React 组件理解 GitHub 原始响应。浏览器只提交结构化 PR 引用；loopback 服务固定访问 `api.github.com`，不会接受任意 URL，也不会为了对齐代码自动 fetch。PR head SHA 与当前干净检出一致时才能产生 exact 行号证据。完整协议见 [`github-pull-request-v1.md`](github-pull-request-v1.md)。
