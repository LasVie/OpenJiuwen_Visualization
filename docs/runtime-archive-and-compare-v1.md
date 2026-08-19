# Runtime Archive and Compare V1

## 目标

Runtime Archive V1 在现有实时 Trace 旁增加一个本机、可恢复的历史平面。实时播放仍由有界内存会话与 SSE 负责；每个已经校验的事件会同时增量写入 SQLite，运行结束后可在“运行档案”中检索、查看、导出、删除并与另一条运行做结构化对比。

归档是独立插件 `openjiuwen.trace-archive`，能力标识为 `trace.archive.local.v1`。它不改变 Core/Swarm 事件协议，也不让历史读取进入实时执行路径。

```text
Producer / Executor
        │ validated event batch
        ▼
  Runtime Trace Store ─────→ SSE / live replay
        │
        └──────────────────→ SQLite archive ─────→ Archive workspace
                                  │                    ├─ redacted session view
                                  │                    ├─ explicit raw reveal
                                  │                    ├─ full JSON export
                                  │                    ├─ run comparison
                                  │                    └─ session deletion
                                  └─ retention / size purge
```

## 存储模型

- 数据库使用 SQLite，启动时强制启用 WAL、foreign keys、`secure_delete` 与版本化 schema migration；当前 schema 版本为 1。
- 默认路径为第一个允许根目录下的 `.openjiuwen-visualization/runtime-archive.sqlite3`。自定义路径也必须位于某个 `--allow-root` 内。
- `archive_sessions` 保存 owner、状态、时间、事件数量、Token、费用、Context 消息数和逻辑原文字节数。
- `archive_events` 按 `(trace_id, sequence)` 保存脱敏预览与完整事件 JSON；外键使用 `ON DELETE CASCADE`。
- 新事件先在一个数据库事务中完成 session/event upsert，再提交到内存 Trace。归档写入失败时本批事件不会只存在于内存，避免实时与历史悄然分叉。
- Trace 创建即建立归档 session；运行中的 session 可以查看但不能删除，防止与仍在写入的 producer 竞争。

实时会话依旧受内存 TTL、事件数量和字节预算约束。SQLite 是历史权威，但不会在服务重启后把已完成事件重新注入实时 SSE 会话。

## 原文与隐私边界

本机数据库默认保存每个已处理事件的完整原文，包括：

- 用户输入与系统提示；
- 每次 Context snapshot/delta 及其 owner；
- Tool 参数、结果和错误字段；
- Rail 输入、检查结果、mutation 与 control signal；
- Model 流式增量、最终输出、usage 和取消信息；
- Team、Workflow、Subagent 与其他归一化 Runtime payload。

展示与存储是两条不同边界：

- Session 列表和详情 API 默认只返回脱敏、压缩后的 `preview_json`，不包含原文字段；
- “消息分段”只在用户点击某个事件的“展开原文”后调用 raw endpoint；收起时原文会从当前 React state 和 DOM 中移除；
- “连续原文”只在用户显式切换后读取该 Session 的完整 Context 帧，并自动跟随新增内容；
- 跨运行比较只读取脱敏详情，不读取完整原文；
- 完整 JSON 导出是明确的用户动作，导出文件包含原文并应按敏感数据管理。

归档子系统只写允许根目录内的本机数据库，不把归档内容写入 Git、应用日志或任何远程服务；数据库目录已加入项目 `.gitignore`。这不改变用户显式启动 OpenRouter 调用时原始请求会发送给所选上游模型的既有边界，详见 [`openrouter-provider-v1.md`](openrouter-provider-v1.md)。

## Session 生命周期

默认策略：

- 保留 30 天；
- 完整事件 JSON 的逻辑上限为 2 GiB；
- 自动清理只删除已完成或失败的 Session，按最旧更新时间优先；
- open Session 不因时间或容量策略被删除；若只有 open Session 导致超限，服务保留运行证据并等待其关闭；
- 删除 Session 会在同一数据库事务中级联删除原文、脱敏摘要、Token/费用指标和全部事件，然后执行 WAL checkpoint；
- UI 提供搜索、Core/Swarm 筛选、分页、删除确认与完整导出。

保留周期与空间阈值可在启动时调整：

```powershell
python -B services/local-server/scripts/run_server.py `
  --allow-root "C:\path\to\workspace" `
  --archive-path "C:\path\to\workspace\.openjiuwen-visualization\runtime-archive.sqlite3" `
  --archive-retention-days 30 `
  --archive-max-bytes 2147483648
```

## HTTP API

全部接口只在 loopback 服务提供，并继承 Origin 白名单、`no-store` 与请求体上限。

| Method | Path | 默认是否包含原文 | Purpose |
|---|---|---:|---|
| `GET` | `/api/v1/archive` | 否 | 读取 SQLite/WAL、schema、容量与保留策略 |
| `GET` | `/api/v1/archive/sessions?limit=&offset=` | 否 | 分页读取 Session 列表和聚合指标 |
| `GET` | `/api/v1/archive/sessions/{id}?after=&limit=` | 否 | 分页读取脱敏事件详情 |
| `POST` | `/api/v1/archive/sessions/{id}/raw` | 是 | `mode=events` 按 sequence 展开，或 `mode=context` 读取连续 Context |
| `GET` | `/api/v1/archive/sessions/{id}/export` | 是 | 导出完整 Session 与全部事件 JSON |
| `DELETE` | `/api/v1/archive/sessions/{id}` | 不适用 | 级联删除已关闭 Session 的所有数据 |

Raw API 不支持隐式全量事件读取：事件模式必须提交 1 到 100 个正整数 sequence。Context 模式只返回带结构化 Context 的帧。

## 跨运行比较

V1 允许从本机 Session 列表选择 A/B 两条运行，在不读取原文的前提下比较：

- 事件数、总 Token、费用与 Context 消息数量；
- 运行状态和 owner；
- 运行节点的 added、removed、changed、unchanged；
- 每个对齐节点的事件数量、最后阶段和 Token 差值。

节点优先使用 `repository + normalized path + exact symbol` 对齐，revision 不参与 identity，因此同一源码位置在不同 commit 间仍可比较；revision 作为变化证据保留。缺少 source identity 时退回 `runtime kind + subject`，不会用卡片标题或页面坐标猜测身份。

V1 尚不做语义文本 diff、完整 Context 逐 token 差异、Rail 检查项逐字段 diff，也不会自动把历史 Session 恢复成可继续执行的 live Trace。这些能力可在不改变归档读取默认脱敏边界的前提下继续叠加。

## 验证要求

- migration、WAL、完整原文落盘、默认脱敏、按需展开、完整导出与级联删除均有服务端测试；
- 保留周期、逻辑容量和 open Session 保护有确定性时钟测试；
- 前端 adapter 对协议、分页、raw 请求与错误响应做严格校验；
- 对比 identity/metric diff 使用纯模型测试；
- 可见 UI 需要用真实 Core/Swarm Session 验证默认无原文、展开/收起、连续原文、比较和删除流程。
