# Project Status and Roadmap

更新日期：2026-08-20

## 产品方向

OpenJiuwen Trace Visualization 的目标不是单纯“把流程画出来”，而是把代码定义、真实运行证据和 Git 变更放进同一套可展开语义图，逐步形成面向理解、调试和开发的工作台。

长期能力按六个平面组织：

- Definition：仓库、符号、Tool、Rail、Hook、Agent、Workflow 与配置定义；
- Runtime：Agent、Agent Team、SwarmFlow、Subagent、Model、Tool、Context 和决策过程；
- Archive：本机历史 Session、原文受控查看、导出、删除和跨运行对比；
- Change：工作树、commit range、GitHub PR 与受影响节点；
- Development：基于 Definition/Runtime/Change 证据的诊断、影响、修改与测试建议；
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
| 只读辅助开发 V1 | 已完成 | 开发意图 → 源码证据 → 诊断/影响 → 修改/测试建议 → 不可应用补丁结构草案，零模型与零仓库写入 |
| Development 跨平面入口 V1 | 已完成 | Runtime/Definition/Change 焦点自动进入同一开发证据链，保留 source/revision 与最小结构化运行/变更证据 |
| Development 分析 Session V1 | 已完成 | 独立 SQLite/WAL、自动保存、元数据列表、显式恢复/导出、完整删除、30 天 / 2 GiB 与 schema migration |
| Development OpenRouter 只读增强 V1 | 已完成 | 逐次源码选择、完整外发 JSON/SHA-256、单次确认、独立 Runtime Trace 与紫色模型建议分支 |
| Controlled Development Execution V1 | 已完成 | 临时 index 校验、独立审批画布、隔离 worktree/branch、测试白名单、本地 commit、审计与回滚 |
| 网页代码连接与 Swarm Core 依赖检查 | 已完成 | Agent Core/JiuwenSwarm 本地或公开 GitHub 绑定、Swarm Config 解析、声明 ref 与锁定 Core revision 证据 |
| 受管环境 Desired State | 已完成 | `core-env` / `swarm-core-env` 独立规格、Python/lock/source 指纹、阻塞与 drift 状态 |
| 受管环境 Reconciliation | 已完成 | 网页一键 uv/CPython 3.11 构建、frozen sync、依赖与双 bridge probe、原子切换、失败保留与两代清理 |

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
- Tool Registry 以稳定 identity 对齐代码发现、Host 目录读取授权、本次 Runtime 的 `ability.register` 与配对后的 `tool.call`，并提供独立深入画布和运行步骤往返。
- 顶部“开发辅助”可选择 Core、Swarm 或 Visualization 仓库，把开发意图投影为九步只读证据链；
- 源码候选优先覆盖不同的显式标识符目标，输出 exact/strong/inferred 置信度和扫描 warning；
- 源码、影响、修改、测试与补丁草案均可成为可点击节点，单阶段聚焦展开并自动 fit；
- 修改建议携带目标、风险和 guardrail，测试建议覆盖聚焦/合同/回归层，补丁明确为不可应用的结构草案；
- 证据节点复用统一 Source Viewer 和 Definition 定位；确定性基础 source 始终 `modelAccess=false`、`repositoryWrite=false`。
- Runtime、Definition、Change inspector 均可进入 Development；入口自动选择对应授权仓库并立即扫描；
- source identity 匹配目标固定为首条证据，revision mismatch、dirty、unverified、ambiguous 与 unmatched 都保持显式状态；
- 跨平面合同只传递事件指标、Runtime 聚合或 Change comparison/hunk/impact，不复制 Context、Tool 或模型原文。
- 成功分析自动保存为独立本机 Session；列表不读取原始意图，恢复/导出才读取完整九步结果；
- Session 管理展示仓库/revision/dirty snapshot 和各层计数，支持恢复、完整 JSON 导出及带二次确认的删除；
- Development Session 独立使用 SQLite/WAL 与 schema migration，默认保留 30 天、逻辑上限 2 GiB，不与 Runtime Archive 或 Plugin Host 数据混表。
- OpenRouter 增强默认不选择源码，每次调用必须重新选择 1–3 个 evidence，并在发送前查看完整 JSON、destination、字符数和 SHA-256；
- 外发只含开发意图、最小结构化 Runtime/Definition/Change 摘要和所选源码；完整 Context、Tool、Rail/Hook、既有模型原文与 Session payload 被排除；
- 实际调用从同一个 preview 对象生成参数，确认后进入独立 Runtime Trace；模型流、usage、结构化建议与原文形成紫色旁支，不能覆盖确定性节点；
- Provider 关闭、撤权或未配置时只禁用可选增强，确定性 Development 与 Session 继续可用。
- 受控执行 Host 插件默认关闭；服务端已支持把用户审查后的 unified diff 只读校验为 exact preview，并将 apply/test/commit/rollback 拆成四次摘要绑定确认；
- 补丁只允许最多 12 个普通文本新增/修改路径，源 checkout 必须 clean 且 revision 未变化；工作仅发生在工具命名的隔离 worktree/branch，commit 不会 push；
- 测试命令不能由浏览器提供，只能从服务端固定 profile 选择；执行状态、完整 diff、测试输出与本机审计使用独立 SQLite/WAL。

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
- “连接”页面可绑定 Agent Core/JiuwenSwarm 本地或公开 GitHub 来源；JiuwenSwarm 卡片会解析 Swarm Config 与 `uv.lock`，显示它实际依赖的 Core ref/revision；
- `core-env` 与 `swarm-core-env` 分别服务 Core/Subagent 和 Swarm/SwarmFlow，显示 desired/active 指纹与 drift，支持网页端创建、重验和修复；
- 环境只在本机受管目录执行固定 uv argv；CPython 3.11、frozen lock、`uv pip check` 和两个 consumer probe 全部通过后才原子切换，失败不覆盖 active，并只保留两代。

## 当前明确限制

- 实时 Trace/SSE 仍是有界内存态，服务重启后不会恢复为可继续执行的 live session；历史证据由本机归档读取；
- JiuwenSwarm V1 是固定双成员 Agent Team，不是 SwarmFlow，一次最多一个执行；
- Subagent V1 固定为单层、单 child、前台执行，不支持并行、后台 spawn、sticky resume 或嵌套 child；
- SwarmFlow V1 固定为两个串行 Phase、每阶段一个临时 Worker，无并行、HITL、任意脚本/配置上传或工具执行；
- WorkflowProgress 尚无可靠的结构化 tool activity，页面不会从文本猜 Tool 调用；
- 执行器不开放任意 Shell、Git 写入、文件写入、MCP、Skill 或浏览器自定义工具；
- GitHub PR 当前用于只读理解，不会自动 fetch、checkout、修改或提交代码；
- Development V1 只分析当前有界 Python 静态图；一阶关系不是完整 blast radius，跨平面运行/变更证据只用于锁定入口与解释边界；
- 基础 Development 分析不运行目标仓测试，也不产生可应用 patch 或仓库写入；分析 Session 暂不支持重命名、搜索、标签或两次建议对比；
- 默认关闭的受控执行已经提供浏览器审批 UI，但入口只接受用户已经审查的 unified diff，且不支持 dirty checkout、任意命令、push 或远程 PR 写入；
- Development 模型输入/输出由 Runtime Archive 持有，尚未与 Development Session 建立持久关联；恢复 Session 不会自动恢复或重放模型分支；
- 归档对比 V1 尚不做语义文本 diff、逐 token Context diff、Rail 检查项逐字段 diff 或历史 Session 续跑；
- Host V1 不提供页面安装/卸载/升级、第三方签名链、动态插件代码执行、进程沙箱或崩溃监督；内置 integrity 只是本地发布摘要；
- OpenRouter 已支持 Windows Credential Manager 的网页录入与环境变量回退；其他操作系统的通用 vault、私有 GitHub 凭据和组织级 secret policy 尚未实现；
- 受管环境已经能在网页构建与验证，但四个 Runtime Executor 尚未切换为读取 active manifest，Trace 也尚未记录 env fingerprint；当前执行器仍以各自 Python 配置为运行 authority；
- 首次下载 Python/依赖要求主机系统时间正确且 TLS 可验证；不会为了绕过证书错误自动启用 insecure host；
- Tool Registry 已统一代码发现、Host 目录读取授权、Runtime 注册与调用证据；逐 Tool 执行授权和写 Tool 仍未开放；
- 还没有协作权限或远端部署控制面。

## 已完成：Tool Registry 运行证据收敛 V1

Tool 已从“静态目录 + 零散 Runtime 事件”收敛为稳定证据对象。同一个 Tool node 可以核验定义、Host 目录读取授权、当前运行注册和实际调用；静态推断、Host scope 与运行事实保持独立。

已交付：

1. 定义稳定 Tool identity，把 Definition 声明、Host plugin/capability、Runtime `ability.register` 与 `tool.call` 对齐；
2. 统一展示“已发现 / 已授权 / 本次运行已注册 / 已调用”四层证据，并明确 exact、inferred、unobserved；
3. Tool node 可进入独立画布，查看注册者、所属 Agent/Member/Subagent、参数/结果、耗时、错误与源码往返；
4. 参数和结果沿用默认脱敏、显式原文读取及 owner/session 隔离规则，不复制敏感原文到 Host 审计；
5. 为未来写 Tool 预留逐次审批事件与本机审计合同，但 V1 继续只接入只读工具；
6. 为 Subagent 独立 Tool registry/context 和后续 Provider adapter 扩展准备版本化 contribution 合同。

V1 继续只读，不把 Host 目录读取授权表述成执行权限；真正引入写 Tool 前仍需确定逐次审批、超时和撤销语义。

## 已完成：只读辅助开发 V1

本阶段选择了只读边界，先让开发建议可追溯、可展开、可复核，不把生成内容直接写回绑定仓库。

已交付：

1. 独立 Development source contract、插件 contribution、依赖阻塞和顶层工作台入口；
2. 基于当前 revision Definition snapshot 的确定性目标检索与来源置信度；
3. 开发意图、范围、证据、诊断、影响、修改、测试、草案、边界九步时间轴；
4. 宏观 3×3 主链、单阶段聚焦画布、全分支展开、磁吸/避碰/缩放/MiniMap；
5. Source Viewer 与 Definition 往返，以及 Core/Swarm 明确身份区分；
6. 不可应用 patch 标记和 `repositoryWrite=false / modelAccess=false` 产品边界。

## 已完成：Development 跨平面入口 V1

Runtime、Definition 与 Change 当前焦点现在都能生成最小化结构化入口。Development 会自动选择 source 对应的授权仓库、扫描当前 revision、固定可核验目标并展示入口状态；历史 revision、脏工作树、歧义与缺失不会静默提升为精确证据。导航不会复制 Context、Tool 或模型原文，也没有新增写权限。

## 已完成：Development 分析 Session V1

Development 的确定性九步 projection 现在会自动保存为独立本机 Session。默认列表只返回仓库、revision、dirty、结构计数、时间和字节等 metadata；点击恢复或导出才读取原始开发意图和完整分析。服务端再次验证 allow-root、九步顺序、相对 source path、数量/字节上限、`repositoryWrite=false` 和不可应用 patch，不能借持久化入口修改目标仓。

## 已完成：OpenRouter 可选只读增强 V1

本阶段保留确定性证据链为事实底座，并增加每次显式开启的 OpenRouter 只读增强：

1. 调用前展示精确外发预览，由用户针对本次调用确认；
2. 只发送开发意图、用户选定的有界源码片段，以及结构化 Runtime/Change 摘要；
3. 不发送完整 Context、Tool 参数/结果、Rail/Hook 原文或既有模型流式输出；
4. Provider 返回只能成为带来源与不确定性标记的增强节点，不能覆盖确定性证据；
5. 继续保持 `repositoryWrite=false`，不应用 patch、不运行测试、不创建 Git 变更。

实现还包括每个源码最多 64 行 / 8,000 字符、总源码最多 24,000 字符、旧预览随选择/model/预算变化失效、JSON schema 验证以及不合格响应只保留原文。OpenRouter 数据进入现有 Runtime Archive，不复制进 Development Session。

## 已完成：Controlled Development Execution V1

受控执行保持为默认关闭且独立于确定性分析和 OpenRouter 的模块。已交付：

1. 完整 unified diff 输入与临时 Git index 只读预览，精确绑定 clean HEAD、文件 allowlist 和 SHA-256；
2. 独立 ReactFlow 状态画布，区分 Diff 审查、隔离 Apply、固定 Test、本地 Commit、受保护 source checkout 与 rollback 分支；
3. 每个写类动作均展示完整参数或摘要，并要求不复用的单次勾选确认；
4. 测试只能选择服务端识别的固定 profile，展示 command/workdir/timeout、stdout/stderr、退出状态和 tracked side effects；
5. Commit 先生成 message + branch + staged diff + `push=false` 的独立审批预览，服务不提供 push；
6. 本机执行历史默认只列元数据，点击才读取完整 diff、测试结果与事件；
7. rollback 只删除未被外部推进的工具所有 branch/worktree，source checkout 始终不变；
8. 浏览器插件与 Host 插件状态映射，依赖、最终授权、SQLite/WAL 和无业务原文 Host 审计均有自动测试。

OpenRouter 仍保持只读，不自动生成或应用 patch；V1 也不支持 dirty checkout、任意 Shell、删除/重命名/二进制 patch、push 或远程 PR 写入。

## 后续路线

| 优先级 | 阶段 | 核心结果 | 进入前的决策点 |
|---:|---|---|---|
| 已完成 | 真实 Subagent Executor | 父子 session/Context/Tool/结果的真实链路 | 固定单 child profile 已落地 |
| 已完成 | SwarmFlow Executor | Workflow/Phase/Agent 的真实流程运行和控制 | 固定两阶段 profile 已落地，身份独立于 Agent Team/Subagent |
| 已完成 | Runtime ↔ Definition ↔ Change 收敛 | 运行节点跳转源码，Change 标出受影响且实际运行的链路 | 结构化 identity 与显式 revision 降级已落地 |
| 已完成 | 运行归档与对比 | SQLite/WAL 持久化、Session 管理、原文受控读取、跨运行结构化 diff | SQLite、默认完整本机原文、30 天 / 2 GiB 已落地 |
| 已完成 | Provider 与插件 Host V1 | OpenRouter/Tool 生命周期、权限、opaque secret handle、最终 gate 与审计 | bundled trust、path-scoped dev、Host-owned secret、风险分级授权已落地 |
| 已完成 | Tool Registry 运行证据收敛 | Tool 四层证据、节点深入画布、Definition/Host/Runtime 往返 | V1 只读；写 Tool 仍不开放 |
| 已完成 | 只读辅助开发 V1 | 源码证据、诊断、影响、修改/测试建议与不可应用补丁结构草案 | 选择零模型、零仓库写入边界 |
| 已完成 | Development 跨平面入口 V1 | Runtime/Definition/Change 焦点进入同一开发证据链 | 结构化最小入口与显式 revision 降级已落地 |
| 已完成 | Development 分析 Session | 本机自动保存、恢复、删除和完整导出开发证据链 | 独立 SQLite/WAL、完整本机 payload、30 天 / 2 GiB 与 schema migration 已落地 |
| 已完成 | 可选 OpenRouter 辅助分析 | 在确定性证据上增强诊断与方案 | 逐次开启、完整外发预览、最小数据范围、独立 Trace 与零仓库写入已落地 |
| 已完成 | 受控开发执行 | 完整 Diff、逐次审批、隔离 apply、固定测试、本地 commit、history 与 rollback 画布 | 安全基线已批准；V1 不 push、不创建远端 PR |
| 已完成 | 网页代码连接与依赖解析 | 本地/公开 GitHub slot、Swarm Core 声明与锁定 revision | 两套环境身份保持独立 |
| 已完成 | 受管环境构建与激活 | uv-managed Python 3.11、frozen sync、验证、原子 generation 与网页控制 | 不允许 insecure TLS；失败保留旧 active |
| 进行中 | Executor 环境收敛 | 四个固定 bridge 使用 active manifest，Trace 记录环境 fingerprint | 保持每类执行器独立身份与现有取消/权限边界 |

下一阶段先完成已经确定的 Executor 环境收敛：调用前自动刷新 desired state、只接受验证通过且匹配指纹的 active generation，把 Python/root/lock/env identity 固定写入 Runtime descriptor 与 Trace。完成后再回到 Development 的 patch candidate、异步测试或 Session/执行记录关联等产品决策。

## 阶段管理规则

- 每个阶段保持独立模块、文档、测试和可回滚提交；
- 完成后运行 `npm run check`，可见 UI 变化必须做真实浏览器验收；
- 每个阶段使用描述性 commit message 并推送当前分支；
- 文档同时更新“已支持功能、明确限制、下一阶段”，不把计划功能写成已完成；
- 只有涉及产品语义、安全权限或不可逆数据模型选择时才暂停请求决策。
