# Read-only Development Assistant V1

## 目标与边界

Development Assistant V1 把“我想理解或调整什么”变成一条可复核的开发证据链，帮助定位代码、评估关系影响、规划修改和测试。确定性基础链不是代码生成器或自治开发代理：它不调用模型、不运行目标仓命令、不修改文件、不创建分支，也不生成可应用 patch。OpenRouter 后续作为独立、逐次确认的可选建议分支接入，不改变下述基础 source contract。

稳定 source contract：

```text
engine            = deterministic-static
readOnly          = true
repositoryWrite   = false
modelAccess       = false
```

对应插件为 `openjiuwen.development-assistant`，依赖 `openjiuwen.local-repository` 与 `openjiuwen.source-convergence`，贡献：

- `development.analysis.readonly.v1`；
- `graph.development.evidence.v1`；
- `development.patch-outline.preview.v1`；
- `development.session.local.v1`；
- `development.enhancement.openrouter.preview.v1`。

## 输入与证据获取

用户选择允许根目录中的 Git 仓库并输入开发意图。前端通过已有 `LocalRepositoryClient.scan()` 请求当前工作树的有界 Python AST Definition snapshot，包含 repository identity、HEAD revision、branch、dirty 状态、节点、关系、source reference、统计和 warning。服务仍执行 allow-root、路径与链接边界校验，不 import 或运行目标仓代码。

意图分析提取 ASCII/CamelCase/snake_case 标识符和有意义的中文短语。候选证据按以下顺序收敛：

1. 为不同的显式主要目标各保留最强直接定义，避免 `agent`、`api` 等泛词占满结果；
2. 优先 label/symbol 的 exact、prefix 和 contains 命中；
3. 使用 source path、节点 kind、summary 与语义类型分数补齐；
4. 相同直接命中下优先生产定义，不让测试辅助类压过实现边界；
5. 没有稳定命中时只回退到核心可扩展定义，并把置信度保持为 `inferred`。

V1 最多展示 5 个 source evidence 和 10 个一阶 relation impact。扫描达到文件/边上限、源文件无法解析或影响被截断时，页面显示明确 warning。

## 跨平面结构化入口

Development 也可从当前 Runtime 步骤、Definition 节点或 Change 影响节点进入。入口不会复制其他页面的组件状态，而是统一生成带递增页面内 ID 的 `DevelopmentNavigationRequest`：

| 来源 | 保留证据 | 明确不携带 |
|---|---|---|
| Runtime | source identity、trace ID、sequence、event kind、phase、subject identity、Token 指标 | Context 消息、Tool 参数/结果、model delta/response、event details/payload |
| Definition | source identity、node ID/label/kind、聚合 span/event/token、最近 sequence/status | 完整 observation/event 列表与 Runtime 原文 |
| Change | source identity、comparison mode/base/head、file status、impact kind/confidence/reason、hunk indexes、可选 Runtime 聚合 | patch 正文、远端响应、Runtime 原文 |

工作区按 source repository 在已授权目录中自动选择仓库，使用当前 snapshot 重新核验路径、symbol 与 revision，然后自动执行同一确定性分析：

- `exact`：目标固定为第一条 source evidence，保留 exact；
- `worktree-dirty / revision-unverified`：目标仍固定，但只保留 strong；
- `revision-mismatch`：只按结构位置展示为 inferred，不把历史源码当成当前精确事实；
- `ambiguous / unmatched`：保留状态、原因和 warning，不自动选择或制造节点。

入口生成的开发意图仍可编辑；重新分析时沿用同一结构化入口。用户手动切换仓库后退出该入口语境，回到普通意图分析。

## 九步分析链

| 序号 | 阶段 | 输出 |
|---:|---|---|
| 1 | 开发意图 | 原始有界问题陈述 |
| 2 | 仓库范围 | repository、branch、revision、dirty 状态 |
| 3 | 源码证据 | source path、symbol、kind、匹配词和置信度 |
| 4 | 诊断 | 可复核定义与 exact 命中汇总 |
| 5 | 影响范围 | `contains / imports / inherits / uses` 等一阶上下游关系 |
| 6 | 修改建议 | 目标定义、改动边界、风险与 guardrail |
| 7 | 测试建议 | 聚焦、合同和仓库回归层次 |
| 8 | 补丁草案 | 不可应用的结构化修改轮廓 |
| 9 | 只读边界 | `repositoryWrite=false`、`modelAccess=false` |

Change suggestion 最多基于前三个证据目标生成。风险由目标 kind 与一阶影响数量确定，不声称是完整调用图。测试建议优先关联现有测试节点，再补充合同与全量回归建议；V1 只建议命令和断言，不执行目标仓测试。

Patch outline 必须以 `READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH` 开头。它只列出已有 source path/symbol、建议、验证与边界，不包含模型补写代码，不符合可应用 unified diff 语义。

## 页面交互

- Core、Swarm 与当前 Visualization 仓库显示独立 owner badge；Core 使用青色、Swarm 使用紫色，同时保留文字身份；
- 宏观画布用 3×3 snake layout 显示九步主链；
- 点击可展开阶段或时间轴步骤后进入单阶段聚焦画布，主节点与子节点分层展示并自动 fit；
- “展开全部”显式进入全分支视图，不与逐步回放的聚焦语义混合；
- 画布支持拖拽、缩放、平移、fit、MiniMap、实时防重叠，以及可开关/调节强度的磁吸；
- 九步时间轴始终显示完整阶段，可点击跳转，并支持上一步/下一步与非输入状态下的左右方向键；
- 证据、影响、建议、测试和草案节点都有 inspector；存在 source reference 时可打开统一只读源码窗口，证据节点也可定位 Definition。
- 入口来源在左侧显示为 `FROM RUNTIME / DEFINITION / CHANGE`，inspector 同时展示核验状态与最小结构化指标。
- 成功分析自动形成一个本机 SQLite/WAL Session；工具栏显示保存状态，左侧入口打开独立管理抽屉；
- Session 列表不读取原始意图或完整结果；恢复会显式读取完整分析并回到第 1 步，导出与删除也是独立用户动作。
- OpenRouter 入口只在已有 projection 上出现；模型结果以紫色虚线旁支连接“诊断”，不进入九步时间轴、不覆盖基础节点；
- 每次模型调用默认不选择源码，必须选择 1–3 个 evidence、查看完整 JSON 与 SHA-256，再勾选本次确认；改变选择、model 或输出预算会使旧预览失效；
- 模型流和 usage 进入独立 Runtime Trace，点击旁支节点可查看 Provider/model/Trace/payload hash、结构化建议和模型原文。

## 模块化与安全

`kernel/contracts/development.ts` 保存无 React 的 source contract；`plugins/development-assistant/` 只声明 manifest 和 contribution；`features/development-assistant/` 拥有纯投影模型、画布、时间轴、inspector 和工作区；`App` 只依据 Workbench availability 暴露入口。

基础 Development 不映射 Local Plugin Host 的 repository write/network/secret 权限。新增的 Session endpoint 只能写独立本机分析数据库，保存前再次验证 allow-root、九步只读合同、source path 与不可应用 patch；它不能修改绑定仓库。普通源码查看只在用户点击已有 source evidence 后通过统一有界 Source Viewer 读取，不复制到日志、Git 或远程服务。

可选 OpenRouter 分支复用 Provider 已有的 Host lifecycle/network/secret gate，但它仍不请求 repository write。预览只组合开发意图、结构化 Runtime/Definition/Change 元数据及本次显式选择的有界源码；完整 Context、Tool、Rail/Hook、既有模型原文和 Session payload 都被排除。实际调用只从已经显示的 preview 对象生成，并写入独立 Runtime Trace。Provider 关闭、阻止或未配置时，此入口不可发送，确定性分析与 Session 不受影响。

完整 Session payload、SQLite migration、保留、导出和删除合同见 [`development-session-persistence-v1.md`](development-session-persistence-v1.md)；OpenRouter 数据最小化、精确预览、Runtime Trace 与模型分支合同见 [`development-openrouter-enhancement-v1.md`](development-openrouter-enhancement-v1.md)。

## 验证与明确限制

当前自动验证覆盖标识符提取、显式目标多样性、证据/影响/测试投影、fallback 置信度、不可应用 patch 标记、跨平面最小化导航合同、入口证据固定、revision mismatch 降级、unmatched 不造节点、插件依赖与 Workbench 可用性；OpenRouter 覆盖源码数量/行数、精确 body、SHA-256、最小结构化摘要、同一 preview 调用参数、输出 schema 与模型分支节点/边。可见行为另用真实浏览器验证跨平面按钮、自动仓库选择、入口卡片、九步时间轴、聚焦 fit、节点详情、源码窗口，以及 Provider 未配置/就绪、源码逐项选择、完整外发预览、确认前发送禁用和响应式抽屉。

V1 仍有以下限制：

- 只分析当前有界 Python Definition snapshot，不读取其他语言语义或完整动态调用图；
- 关系影响是一阶静态证据，不等于完整 blast radius 或运行覆盖率；
- 诊断和建议为确定性模板，不理解任意自然语言深层语义；
- 跨平面入口只带结构化身份、指标和影响判断，不把完整 Runtime/Context/Tool/模型原文交给 Development；
- 本机保存开发分析 Session，但暂不支持重命名、搜索、标签或两次建议对比；
- OpenRouter 输入/输出保存在 Runtime Archive，不复制进 Development Session；恢复 Session 不会自动恢复、重放或关联旧模型分支；
- 仓库修改、测试执行与本地 branch/commit 由默认关闭的 Controlled Development Executor 作为独立授权与审计边界提供；它只接收用户已审查的完整 unified diff，不会把本页结构草案或 OpenRouter 建议自动提升为 patch。远程 push/PR 写入仍不支持，完整合同见 [`development-controlled-execution-v1.md`](development-controlled-execution-v1.md)。
