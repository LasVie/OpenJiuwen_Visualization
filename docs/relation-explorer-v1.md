# Node Relation Explorer V1

Node Relation Explorer V1 把 Definition Graph 中已经存在的关系变成可逐层深入的独立画布。它用于回答“这个节点由谁包含、依赖谁、被谁继承或引用”，同时避免把完整仓库一次性渲染成不可读的大图。

## 入口与能力

`openjiuwen.local-repository` 暴露 `graph.definition.relation-explorer.v1`。当前入口位于：

- Definition 节点详情；
- Change Plane 中已经映射到 Definition 的影响节点。

Tool 注册路径仍使用自己的 Tool Catalog 图；Runtime、Rail 和 Subagent 也保留各自的时序/决策画布。后续如需合并，只能通过稳定 node id 与显式 evidence 连接，不能按相似名称拼接。

## 展开模型

画布由一个稳定起点和用户显式展开的节点集合决定：

1. 起点始终展开一跳；
2. 点击节点卡片的“展开”或双击节点，才显示该节点的下一跳；
3. “展开可见节点一层”只扩展当前可见且有关系的节点；
4. “收起到起点”移除所有分支展开状态；
5. 任意可见节点可以设为新的探索起点。

投影是纯 View State，不修改 Graph Kernel snapshot，也不写回本地仓。

## 方向与关系类型

方向以当前被展开节点为参照：

| 模式 | 规则 |
| --- | --- |
| 双向 | 接受 source 或 target 命中当前节点的边 |
| 仅上游 | 只接受 `edge.target === currentNode` |
| 仅下游 | 只接受 `edge.source === currentNode` |

V1 直接使用规范边的 `kind`，当前静态扫描器主要提供：

- `contains`：package/module/class 等层级包含；
- `imports`：可静态解析的本地导入；
- `inherits`：无歧义的本地继承。

筛选不会改变规范边，也不会把未解析动态关系伪装成静态事实。

## 容量和完整性

默认边界：

- 单个展开节点最多选择 18 条关系；
- 单张关系画布最多 64 个节点；
- 内部硬上限为 80 个节点。

关系按 `contains → inherits → imports → 其他 kind` 和对端节点名称稳定排序。若边界导致关系未显示，投影返回 `truncated: true` 与 `hiddenRelations`，页面必须显式展示，不得把局部图称为完整依赖图。

## 交互与证据

- 新的展开集合使用确定性分层布局并自动 fit；
- 拖拽期间复用共享实时避碰，结束时应用当前磁性强度；
- 卡片同时使用 Core/Swarm 色彩与文字 owner 标签；
- 右侧详情读取原节点的 summary、owner、path、symbol 和行号；
- 源码按钮复用 Source Evidence Viewer，因此仍受允许根、相对路径、文件大小和行数边界约束；
- Esc 关闭顶层关系画布；若源码窗口处于前景，Esc 只关闭源码窗口。

## 非目标

V1 不执行以下操作：

- 重新扫描、导入或执行目标代码；
- 通过名称猜测动态调用关系；
- 把 Git 影响置信度提升为运行事实；
- 修改源文件、Git 状态或远端仓库；
- 在浏览器持久化仓库路径或源码内容。
