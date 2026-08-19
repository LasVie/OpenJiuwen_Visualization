# Runtime ↔ Definition ↔ Change Convergence V1

本阶段把 Runtime 事件、Repository Definition 节点和 Git Change 影响图连接为同一条只读证据链。它解决的是“这一步实际运行了什么源码、该定义在本次运行中出现了几次、当前变更是否命中了它”，不会根据显示名称猜测，也不会为了展示而制造变更节点。

## 稳定 Source Identity

跨平面关联使用 `src/kernel/source-identity.ts` 的版本化身份规则：

```text
repository + normalized path + exact symbol [+ revision]
```

- repository 必须与 catalog 中的稳定 id、name 或 owner 精确对应；
- path 统一使用 `/`、去除空段与 `.`，不做 basename 猜测；
- symbol 去除首尾空白后必须完全一致；
- revision 转为小写，只用于校验同一源码版本，不能用显示名称替代；
- Runtime 的 `traceId + sequence` 仍是步骤顺序权威，source identity 只负责跨平面定位。

匹配状态必须在 UI 中显式展示：

| Status | Meaning |
|---|---|
| `exact` | repository、path、symbol 与 revision 均一致 |
| `revision-unverified` | 唯一位置一致，但 Runtime 或 Definition 缺少 revision |
| `revision-mismatch` | 唯一位置一致，但 revision 不同 |
| `worktree-dirty` | 位置与 revision 可对齐，但当前工作树包含未提交内容 |
| `ambiguous` | 同一结构化位置命中多个候选，拒绝自动选择 |
| `unmatched` | 没有结构化候选，拒绝名称猜测 |

`revision-unverified`、`revision-mismatch` 和 `worktree-dirty` 可以建立明确降级的导航，但绝不能显示为 exact；`ambiguous` 与 `unmatched` 不会自动选中 Definition。

## Runtime → Definition

Core 与 Swarm Runtime inspector 会在当前事件存在 `definition` 时显示“定位源码定义”。入口受 `graph.cross-plane.source.v1` capability 控制。

导航过程：

1. 保存来源、Trace、sequence、subject 和结构化 source reference；
2. 选择 catalog 中精确对应的仓库；
3. 用 `includeFunctions: true` 执行只读 AST 索引；
4. 按 path + symbol 定位节点，并展示上述匹配状态；
5. Definition inspector 聚合当前 Trace 中同一 source identity 的 span 数、事件数、Token、最后状态和最近步骤；
6. 点击任一最近步骤返回原 Runtime source 与精确 sequence。

Python 扫描器在启用函数索引时会把 class method 建成独立 Definition node，symbol 使用 `QualifiedClass.method`。因此 `TaskTool.invoke`、Rail callback 等运行证据可以落到方法而不是只停在父 class。

## Revision 生产者证据

四个真实执行器在主服务创建 bridge 请求前，通过参数数组运行有界、只读的：

```text
git -C <validated repository> rev-parse --verify HEAD
```

主服务校验 40–64 位十六进制输出，并把 server-owned `sourceRevisions` 映射传给固定 bridge。bridge 只会为已知 repository 的事件 definition 附加 revision；探测失败时省略 revision，由前端显示 `revision-unverified`，不会伪造值。确定性录制可以故意缺少 revision，用于验证降级路径。

## Definition Runtime 聚合

`features/source-convergence/` 是跨平面纯模型边界。Definition inspector 当前展示：

- 去重后的调用 span 数与事件数；
- Model usage 或 Context token delta 的合计 Token；
- 最后事件的 phase/status 与 sequence；
- 最近运行事件，以及返回该精确步骤的入口；
- 进入 Change 平面的结构化 source 导航。

聚合只读取当前内存 Trace，不落盘，也不把一次历史运行混入另一条 Trace。

## Definition → Change

从 Definition 进入 Change 时，页面保留结构化 source target 和 Runtime evidence。Change 平面随后：

- 精确选择对应本地仓库并默认分析工作树；
- 将已有 `direct / container / dependent / file` 影响与 `runtimeObserved` 证据正交叠加；
- 在文件、节点和 inspector 中显示实际经过的 span、事件、Token 与最近步骤；
- 支持从 Runtime 证据返回原步骤，或回到 Definition 精确节点；
- 当目标源码不在当前 diff 中时显示明确空结果，不创建推断影响节点。

`runtimeObserved` 是观察维度，不会覆盖节点原有的 change impact kind。对 compare 或 GitHub PR，仍沿用各自的 exact/inferred revision 规则。

## 模块与安全边界

- 独立 `openjiuwen.source-convergence` 插件依赖 Local Repository 并提供 `graph.cross-plane.source.v1`；关闭或阻塞后，跨平面入口一起收敛，Core-only 与 Swarm-only Runtime 均可单独使用。
- Repository、Git 和 Source API 仍然只读；导航不会 fetch、checkout、merge、编辑、生成 patch 或提交。
- 浏览器不能提交 revision 映射；真实执行器的 revision 由本地服务从已验证仓库路径生成。
- 工作树为 dirty、revision 缺失或不一致时必须显式降级。
- 当前覆盖是 Trace 观察证据，不是测试覆盖率，也不表示代码路径中的每一行都执行过。

## 验证范围

- source identity 规范化、精确/降级/歧义/未匹配和 Runtime 聚合单元测试；
- Change runtime overlay 及原影响类型保持测试；
- method Definition 扫描与 revision helper 服务测试；
- 四个真实 bridge 的无网络框架自检；
- 真实浏览器往返：Subagent `tool.call` → `TaskTool.invoke` → 第 3 步；
- 干净工作树降级：显示目标不在当前变更范围，且不制造影响节点。

## 明确限制

- Runtime 与聚合证据仍是内存态，刷新或服务过期后不可恢复；
- 尚无跨运行比较、运行标签检索、持久化保留或协作权限；
- Python AST 方法索引不解析运行期 monkey patch、动态 import、反射或生成代码；
- 当前 revision 只表示执行器启动前观测到的 repository HEAD，不证明 dirty 工作树内容与该 commit 相同；
- PR 覆盖只在已有 Runtime source identity 与 Change source 能安全对齐时展示，不会远程执行 PR 代码。
