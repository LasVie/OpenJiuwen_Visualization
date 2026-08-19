# Project Status and Roadmap

更新日期：2026-08-19

## 产品方向

OpenJiuwen Trace Visualization 的目标不是单纯“把流程画出来”，而是把代码定义、真实运行证据和 Git 变更放进同一套可展开语义图，逐步形成面向理解、调试和开发的工作台。

长期能力按五个平面组织：

- Definition：仓库、符号、Tool、Rail、Hook、Agent、Workflow 与配置定义；
- Runtime：Agent、Agent Team、SwarmFlow、Subagent、Model、Tool、Context 和决策过程；
- Archive：本机历史 Session、原文受控查看、导出、删除和跨运行对比；
- Change：工作树、commit range、GitHub PR 与受影响节点；
- Modules：Provider、执行器、数据源和深入画布的可开关插件。

同一个功能优先使用稳定 node identity、source evidence 和 runtime evidence 逐层展开，而不是为每个页面重新定义一套不可关联的卡片。

## 已完成阶段

| 阶段 | 状态 | 主要结果 |
|---|---|---|
| Graph Kernel 与插件工作台 | 已完成 | 版本化图合同、依赖解析、Core/Swarm 来源语义、确定性场景 |
| 本地仓 Definition 平面 | 已完成 | 只读 AST 索引、分层定义图、源码证据、关系画布、内存扫描缓存 |
| Runtime Trace 基础 | 已完成 | Loopback 内存会话、SSE、步骤回放、ContextWindow、Rail 深入画布 |
| Swarm 主体与 Subagent 协议 | 已完成 | Team/Workflow/Member/Task/Subagent 层级、独立 Context owner、确定性 Subagent 录制 |
| Model Provider | 已完成 | 厂商无关录制合同、OpenRouter provider-only adapter、流式输出/usage/取消 |
| Change 平面 | 已完成 | 工作树/commit range、GitHub PR、符号与关系影响映射 |
| 模块控制中心 | 已完成 | 插件启停、依赖阻塞、能力驱动的入口收敛、浏览器偏好 |
| Agent Core 真实执行 | 已完成 | 固定隔离 bridge、真实 DeepAgent/ReAct/Rail/只读 Tool/OpenRouter、取消与自检 |
| JiuwenSwarm Agent Team 真实执行 | 已完成 | 固定双成员 Team、真实 Team Runner/TeamMonitor、角色 Tool 边界、成员独立 Context |
| Agent Core Subagent 真实执行 | 已完成 | 父 DeepAgent → TaskTool → child DeepAgent、父子 session/Context、双重 Tool 边界、取消与自检 |
| Agent Core SwarmFlow 真实执行 | 已完成 | 固定两阶段 Workflow、真实 TeamWorkerBackend、结构化 WorkflowMonitor、Worker Rail/ReAct 与独立 Context |
| Runtime ↔ Definition ↔ Change 收敛 | 已完成 | 稳定 source identity、方法级定位、revision 降级、Runtime 聚合、Change 运行证据叠加与精确往返 |
| 运行归档与对比 V1 | 已完成 | SQLite/WAL 增量归档、默认完整本机原文、脱敏读取、Session 管理、保留策略与双运行结构化 diff |
| Provider 与 Local Plugin Host V1 | 已完成 | 内置 OpenRouter/Tool Host、信任来源、持久生命周期、风险分级权限、opaque secret handle、最终调用 gate 与本机审计 |

## 当前已支持功能

### 图与交互

- 宏观模式按主链路展示，运行到深层主体时自动显露活跃祖先链；
- 微观模式展开当前步骤前已出现的全部主体；
- 节点点击详情、分支展开、拖拽、缩放、平移、fit view、缩略图；
- 可开关和调节强度的实时磁吸/防重叠，展开后的节点同样参与避碰；
- 放大的步骤进度控制、上一步/下一步、实时事件自动跟随与历史停留。

### ContextWindow

- Team、Member、Agent 和 Subagent 使用独立 owner，不跨主体混合；
- 消息分段模式默认显示脱敏摘要，逐条展开后显示完整原文；
- 连续原文模式按实际追加顺序展示完整内容，并在新内容进入时自动滚动；
- 逐消息 Token、总窗口 Token、Provider usage 与估算来源可区分；
- 右侧面板可向右折叠，不影响画布操作。

### Definition 与开发辅助

- 绑定允许根目录内的本地 Git 仓库，渐进浏览 repository/package/module/class/function；
- 识别 Agent、Rail、Tool、Context、Workflow、Model、Team 等语义节点；
- 统一源码证据窗口、聚焦行、revision/工作树对齐与内容哈希；
- Runtime 事件按 repository/path/exact symbol/revision 定位到方法或类，缺失、脏工作树、冲突与歧义显式降级；
- Definition inspector 展示本次 Trace 的 span、事件、Token、最后状态和可返回的最近步骤；
- 从节点逐层展开 `contains / imports / inherits` 上下游关系；
- Registered Tools Catalog 区分声明、静态注册路径和本次 Runtime 的 `ability.register` 观察。

### Runtime 与真实执行

- 确定性 Core/Swarm 演示轨迹；
- 外部 producer 写入的 Core Trace 与 Swarm Trace；
- 真实独立 Agent Core DeepAgent，包含 ReAct、Rail、Model、Tool、Context 和取消；
- 真实 JiuwenSwarm 两成员 Agent Team，包含 Team/Member/Task/Message、成员 Rail、Model、团队 Tool 和独立 Context；
- 真实 Agent Core 前台单层 Subagent，包含父侧 `task_tool`、child ReAct/Rail/只读 Tool、独立 session/workspace/Context 与结果回传；
- 真实 Agent Core 两阶段 SwarmFlow，包含 Workflow/Phase/临时 Worker、真实 ReAct/Rail/Model、结构化状态聚合与每 Worker 独立 Context；
- Rail 卡片进入独立画布，逐帧查看读取、检查、变更、控制信号与输出证据；
- Provider 录制回放和 OpenRouter 实时流式调用。

### 运行档案与对比

- 每个已校验 Runtime 事件先增量写入本机 SQLite/WAL，再提交实时内存会话；
- 默认保存用户输入、系统提示、Context 增量、Tool 参数/结果、Rail 输入/输出和 Model 流式输出的完整原文；
- Session 列表与事件详情默认只返回脱敏摘要，逐条展开或切换连续原文后才读取完整内容；
- 连续原文按 Context owner 和 sequence 展示，并自动跟随新增内容；
- Session 管理支持搜索、Core/Swarm 筛选、分页、完整 JSON 导出和带确认的级联删除；
- 默认保留 30 天、完整事件逻辑上限 2 GiB，自动清理最旧已关闭 Session，运行中 Session 受保护；
- 可选择两次运行，比较事件、Token、费用、Context 消息数及 source/runtime identity 对齐后的节点增删改；
- `openjiuwen.trace-archive` 是独立、默认启用且可关闭的 workspace 插件。

### Git 与模块化

- 工作树和本地 commit range 的节点级影响图；
- 公共或服务端 token 授权的 GitHub PR 只读变更图；
- Change 节点叠加 `runtimeObserved` 证据，并支持 Runtime → Definition → Change → 原运行步骤往返；
- 插件按 dependency/capability 开关，关闭后相关入口和 contribution 一起收敛；
- “模块”同时展示浏览器 Workbench 与 Local Plugin Host，两者通过稳定映射同步 OpenRouter/Tool 生命周期；
- Host 内置插件自动信任；未签名本地 manifest 仅在显式开发模式和 allow-root 内 path scope 下发现，V1 不执行其代码；
- read 权限安装时固定，network/secret 可撤销，write 强制逐操作审批；新 Provider、Executor、Tool 请求均经过服务端最终 gate；
- OpenRouter key 只通过 `openrouter.default` opaque handle 解析，浏览器、插件快照、Host 数据库和审计均看不到值；
- Host 使用 SQLite/WAL 持久化生命周期和授权，最多保留 5,000 条不含 secret 或业务原文的本机审计；
- Core、Swarm、Provider、Repository、Change、Tool、深入画布与执行器均按 feature/plugin/adapter 分层。

## 当前明确限制

- 实时 Trace/SSE 仍是有界内存态，服务重启后不会恢复为可继续执行的 live session；历史证据由本机归档读取；
- JiuwenSwarm V1 是固定双成员 Agent Team，不是 SwarmFlow，一次最多一个执行；
- Subagent V1 固定为单层、单 child、前台执行，不支持并行、后台 spawn、sticky resume 或嵌套 child；
- SwarmFlow V1 固定为两个串行 Phase、每阶段一个临时 Worker，无并行、HITL、任意脚本/配置上传或工具执行；
- WorkflowProgress 尚无可靠的结构化 tool activity，页面不会从文本猜 Tool 调用；
- 执行器不开放任意 Shell、Git 写入、文件写入、MCP、Skill 或浏览器自定义工具；
- GitHub PR 当前用于只读理解，不会自动 fetch、checkout、修改或提交代码；
- 归档对比 V1 尚不做语义文本 diff、逐 token Context diff、Rail 检查项逐字段 diff 或历史 Session 续跑；
- Host V1 不提供页面安装/卸载/升级、第三方签名链、动态插件代码执行、进程沙箱或崩溃监督；内置 integrity 只是本地发布摘要；
- OpenRouter 凭据仍由服务进程环境配置，尚无通用本机 vault/系统凭据录入 UI；
- Tool Catalog 目前区分静态声明/注册路径与 `ability.register` 观察，但尚未统一“已安装 / 已授权 / Runtime 已注册 / 已调用”四态及逐 Tool 权限；
- 还没有协作权限或远端部署控制面。

## 下一阶段：Tool Registry 运行证据收敛 V1

Local Plugin Host 已建立服务端生命周期与权限边界，下一步把 Tool 从“静态目录 + 零散 Runtime 事件”收敛为可用于理解和开发的稳定证据对象。目标不是把静态推断冒充运行事实，而是让同一个 Tool node 清晰显示它在哪定义、由谁托管、当前是否授权、在哪次运行完成注册和调用。

计划交付：

1. 定义稳定 Tool identity，把 Definition 声明、Host plugin/capability、Runtime `ability.register` 与 `tool.call` 对齐；
2. 统一展示“已发现 / 已授权 / 本次运行已注册 / 已调用”四层证据，并明确 exact、inferred、unobserved；
3. Tool node 可进入独立画布，查看注册者、所属 Agent/Member/Subagent、参数/结果、耗时、错误与源码往返；
4. 参数和结果沿用默认脱敏、显式原文读取及 owner/session 隔离规则，不复制敏感原文到 Host 审计；
5. 为未来写 Tool 预留逐次审批事件与本机审计合同，但 V1 继续只接入只读工具；
6. 为 Subagent 独立 Tool registry/context 和后续 Provider adapter 扩展准备版本化 contribution 合同。

这一阶段可直接按现有安全基线开始；只有真正引入写 Tool 时，才需要确定逐次审批的交互、超时和撤销语义。

## 后续路线

| 优先级 | 阶段 | 核心结果 | 进入前的决策点 |
|---:|---|---|---|
| 已完成 | 真实 Subagent Executor | 父子 session/Context/Tool/结果的真实链路 | 固定单 child profile 已落地 |
| 已完成 | SwarmFlow Executor | Workflow/Phase/Agent 的真实流程运行和控制 | 固定两阶段 profile 已落地，身份独立于 Agent Team/Subagent |
| 已完成 | Runtime ↔ Definition ↔ Change 收敛 | 运行节点跳转源码，Change 标出受影响且实际运行的链路 | 结构化 identity 与显式 revision 降级已落地 |
| 已完成 | 运行归档与对比 | SQLite/WAL 持久化、Session 管理、原文受控读取、跨运行结构化 diff | SQLite、默认完整本机原文、30 天 / 2 GiB 已落地 |
| 已完成 | Provider 与插件 Host V1 | OpenRouter/Tool 生命周期、权限、opaque secret handle、最终 gate 与审计 | bundled trust、path-scoped dev、Host-owned secret、风险分级授权已落地 |
| P5 | Tool Registry 运行证据收敛 | Tool 四态证据、节点深入画布、Definition/Host/Runtime 往返 | V1 只读；写 Tool 仍不开放 |
| P6 | 辅助开发闭环 | 从受影响节点生成测试/修改建议并回写受控分支 | 任何写操作都需要独立权限和可审计逐次审批 |

## 阶段管理规则

- 每个阶段保持独立模块、文档、测试和可回滚提交；
- 完成后运行 `npm run check`，可见 UI 变化必须做真实浏览器验收；
- 每个阶段使用描述性 commit message 并推送当前分支；
- 文档同时更新“已支持功能、明确限制、下一阶段”，不把计划功能写成已完成；
- 只有涉及产品语义、安全权限或不可逆数据模型选择时才暂停请求决策。
