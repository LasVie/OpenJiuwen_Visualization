# Visualization Web Architecture

## 目标

项目会同时承载 Core 链路、Swarm 链路、真实 Trace 适配、更多 Context 视图和大量 Rail。代码按“稳定领域合同 + 独立功能 + 可替换数据源”组织，避免把业务数据、ReactFlow 布局和面板 UI 继续堆入单一文件。

## 依赖方向

```text
App / components
      ↓
features ─────→ shared
      ↓            ↓
domain ───────→ types
      ↑
data fixtures / future trace adapters
```

规则：

1. `types/` 只保存跨模块稳定合同，不依赖 React。
2. `domain/` 保存运行时来源、图定义等稳定知识，不依赖页面组件。
3. `features/<name>/` 同时拥有该能力的模型、组件、测试和公开 `index.ts`；跨功能只从公开入口导入。
4. `data/scenarios/` 一个轨迹一个文件；禁止重新创建巨型场景总文件。
5. `components/` 负责页面编排和第三方库适配，不保存新的领域规则。
6. `shared/` 只放无业务状态的复用组件；带 Rail、Context、Swarm 语义的内容必须留在对应 feature/domain。

## Trace 来源语义

每个 Stage/Rail 必须声明 `owner`：

- `agent-core`：Agent、ReAct、Context、Model、Tool、Rail 和 Hook 执行。
- `jiuwenswarm`：Channel/Server 请求边界、会话宿主、Swarm 装配、调度和响应出口。

颜色只是辅助线索；所有节点还必须显示文字 Badge，避免仅靠颜色表达来源。

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
2. 在 `data/scenarios.ts` 注册场景，不在索引文件放大段 fixture。
3. 所有 `activeNodeIds`、`activeEdgeIds` 必须存在于 `domain/trace/graph.ts`。
4. 每条 Context 消息必须同时保留完整 `raw`；需要人工摘要时提供 `preview`。
5. 运行 `npm run check`，确保引用、Token 预算和 ID 唯一性通过。

## 未来真实 Trace 接入

推荐新增 `adapters/core-trace/` 与 `adapters/swarm-trace/`，分别把上游事件映射到当前 `TraceScenario`/`TraceStep` 合同。不要让 Web 组件直接读取 Python 日志结构。真实 tokenizer 的 token ID/offset 也应在 adapter 层归一化，再交给 Context feature 展示。
