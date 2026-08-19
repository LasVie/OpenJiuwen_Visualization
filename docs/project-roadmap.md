# Project Status and Roadmap

更新日期：2026-08-19

## 产品方向

OpenJiuwen Trace Visualization 的目标不是单纯“把流程画出来”，而是把代码定义、真实运行证据和 Git 变更放进同一套可展开语义图，逐步形成面向理解、调试和开发的工作台。

长期能力按四个平面组织：

- Definition：仓库、符号、Tool、Rail、Hook、Agent、Workflow 与配置定义；
- Runtime：Agent、Agent Team、未来的 SwarmFlow/Subagent、Model、Tool、Context 和决策过程；
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
- Subagent 已有结构化协议和确定性录制，但尚未接入真实 child execution；
- WorkflowProgress 尚无可靠的结构化 tool activity，页面不会从文本猜 Tool 调用；
- 执行器不开放任意 Shell、Git 写入、文件写入、MCP、Skill 或浏览器自定义工具；
- GitHub PR 当前用于只读理解，不会自动 fetch、checkout、修改或提交代码；
- 还没有持久化运行归档、跨运行比较、协作权限或远端部署控制面。

## 下一阶段：真实 Subagent Executor V1

下一阶段在现有 `swarm.subagent` 合同之上接入一个真实、固定且有界的 child execution，不先扩展到 SwarmFlow。这样可以优先验证用户最关心的父/子 Context 分离、派发过程和子链路逐层展开，同时复用已经稳定的 Core 事件、Rail 深入画布与 OpenRouter 边界。

计划交付：

1. 检视 Agent Core/JiuwenSwarm 的真实 Subagent 创建、session、workspace 和 callback 入口；
2. 定义固定只读 Subagent profile、父子 authority、并发/深度/取消预算；
3. 在隔离 bridge 中执行真实 dispatcher → child session，并归一化现有 `swarm.subagent` 与 Core events；
4. 为父 Context、child Context、Tool allowlist、后台/前台状态和 result merge 增加精确证据；
5. 接入现有 Subagent 深入画布，不在 `App.tsx` 复制投影规则；
6. 增加无网络框架自检、服务测试、前端测试和真实浏览器验收。

默认边界是单层、单 child、前台执行、固定只读工具、OpenRouter 首个 Provider；只有上游真实 API 证明需要变化时才进入方案决策。

## 后续路线

| 优先级 | 阶段 | 核心结果 | 进入前的决策点 |
|---:|---|---|---|
| P1 | 真实 Subagent Executor | 父子 session/Context/Tool/结果的真实链路 | 上游可用执行入口与最小安全 profile |
| P2 | SwarmFlow Executor | Workflow/Phase/Agent/Human 的真实流程运行和控制 | 先选择一个可重复的最小 workflow；不能复用 Agent Team 标签 |
| P3 | Runtime ↔ Definition ↔ Change 收敛 | 运行节点跳转源码，PR 标出受影响且实际运行的链路 | 稳定 source identity 与 revision 对齐策略 |
| P4 | 运行归档与对比 | 可选持久化、跨运行 diff、Token/费用/决策比较 | 本地数据库、脱敏和保留周期 |
| P5 | Provider 与插件 Host | 更多模型 Provider、注册工具插件、权限声明 | 插件签名、密钥隔离和 capability 审批 |
| P6 | 辅助开发闭环 | 从受影响节点生成测试/修改建议并回写受控分支 | 任何写操作都需要独立权限和可审计审批 |

## 阶段管理规则

- 每个阶段保持独立模块、文档、测试和可回滚提交；
- 完成后运行 `npm run check`，可见 UI 变化必须做真实浏览器验收；
- 每个阶段使用描述性 commit message 并推送当前分支；
- 文档同时更新“已支持功能、明确限制、下一阶段”，不把计划功能写成已完成；
- 只有涉及产品语义、安全权限或不可逆数据模型选择时才暂停请求决策。
