# Project Status and Roadmap

更新日期：2026-08-19

## 产品方向

OpenJiuwen Trace Visualization 的目标不是单纯“把流程画出来”，而是把代码定义、真实运行证据和 Git 变更放进同一套可展开语义图，逐步形成面向理解、调试和开发的工作台。

长期能力按四个平面组织：

- Definition：仓库、符号、Tool、Rail、Hook、Agent、Workflow 与配置定义；
- Runtime：Agent、Agent Team、SwarmFlow、Subagent、Model、Tool、Context 和决策过程；
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

### Git 与模块化

- 工作树和本地 commit range 的节点级影响图；
- 公共或服务端 token 授权的 GitHub PR 只读变更图；
- 插件按 dependency/capability 开关，关闭后相关入口和 contribution 一起收敛；
- Core、Swarm、Provider、Repository、Change、Tool、深入画布与执行器均按 feature/plugin/adapter 分层。

## 当前明确限制

- Runtime Trace 与 Context 默认只在 local service 内存中保存；
- JiuwenSwarm V1 是固定双成员 Agent Team，不是 SwarmFlow，一次最多一个执行；
- Subagent V1 固定为单层、单 child、前台执行，不支持并行、后台 spawn、sticky resume 或嵌套 child；
- SwarmFlow V1 固定为两个串行 Phase、每阶段一个临时 Worker，无并行、HITL、任意脚本/配置上传或工具执行；
- WorkflowProgress 尚无可靠的结构化 tool activity，页面不会从文本猜 Tool 调用；
- 执行器不开放任意 Shell、Git 写入、文件写入、MCP、Skill 或浏览器自定义工具；
- GitHub PR 当前用于只读理解，不会自动 fetch、checkout、修改或提交代码；
- 还没有持久化运行归档、跨运行比较、协作权限或远端部署控制面。

## 下一阶段：Runtime ↔ Definition ↔ Change 收敛 V1

下一阶段把已经稳定的真实 Runtime 证据连接到 Definition 与 Change 平面。目标不是新增第四套节点，而是让一次 Agent/Team/SwarmFlow/Subagent 运行可以跳转到其精确源码定义，并让工作树或 PR 影响图明确标出“被修改且在本次运行中实际经过”的节点。

计划交付：

1. 定义跨平面的稳定 source identity，统一 repository、revision、path、symbol 与 runtime subject/span；
2. 从带 `definition` 的 Runtime event 精确关联 AST Definition node，缺失或 revision 不一致时显式降级而不靠名称猜测；
3. 在 Definition inspector 中显示本次 Trace 的调用次数、最后状态、Token 与可跳转步骤；
4. 在 Change 图叠加实际运行覆盖，区分 direct change、关系影响与 runtime-observed 三种证据；
5. 提供 `运行节点 → 源码定义 → 变更影响 → 原运行步骤` 的往返导航，并保持当前 Trace/revision 上下文；
6. 增加 identity、脏工作树/PR revision 降级、前端投影和真实浏览器验收。

默认只做只读关联，不自动 fetch、checkout、编辑、生成补丁或提交；若同一源码定义在多仓/多 revision 下无法保持唯一 identity，再请求数据模型决策。

## 后续路线

| 优先级 | 阶段 | 核心结果 | 进入前的决策点 |
|---:|---|---|---|
| 已完成 | 真实 Subagent Executor | 父子 session/Context/Tool/结果的真实链路 | 固定单 child profile 已落地 |
| 已完成 | SwarmFlow Executor | Workflow/Phase/Agent 的真实流程运行和控制 | 固定两阶段 profile 已落地，身份独立于 Agent Team/Subagent |
| P1 | Runtime ↔ Definition ↔ Change 收敛 | 运行节点跳转源码，PR 标出受影响且实际运行的链路 | 稳定 source identity 与 revision 对齐策略 |
| P3 | 运行归档与对比 | 可选持久化、跨运行 diff、Token/费用/决策比较 | 本地数据库、脱敏和保留周期 |
| P4 | Provider 与插件 Host | 更多模型 Provider、注册工具插件、权限声明 | 插件签名、密钥隔离和 capability 审批 |
| P5 | 辅助开发闭环 | 从受影响节点生成测试/修改建议并回写受控分支 | 任何写操作都需要独立权限和可审计审批 |

## 阶段管理规则

- 每个阶段保持独立模块、文档、测试和可回滚提交；
- 完成后运行 `npm run check`，可见 UI 变化必须做真实浏览器验收；
- 每个阶段使用描述性 commit message 并推送当前分支；
- 文档同时更新“已支持功能、明确限制、下一阶段”，不把计划功能写成已完成；
- 只有涉及产品语义、安全权限或不可逆数据模型选择时才暂停请求决策。
