# Tool Registry 四层证据 V1

## 目标与事实边界

Tool Registry 把同一个 Tool 的代码和运行证据收敛成四个可独立核验的阶段：

1. **代码发现（discovered）**：Python AST 中存在 `@tool`、Tool 子类或顶层 `ToolCard`。
2. **目录读取授权（authorized）**：Local Plugin Host 允许 `openjiuwen.host.tool-catalog` 读取静态 Tool Catalog。
3. **运行注册（registered）**：当前 Trace 出现可与 Tool identity 对齐的 `ability.register`。
4. **实际调用（called）**：当前 Trace 出现可与 Tool identity 对齐的 `tool.call` 起止事件。

第二层只授权读取目录，**不代表 Tool 获得执行权限**。源码中的静态注册路径是发现阶段的旁路证据，也不等于运行注册。只有 `ability.register` 和 `tool.call` 能分别证明当前 Trace 的注册和调用事实。

## 稳定 identity 与对齐规则

静态 Tool identity 绑定以下字段：

```text
repository id + revision + source path + symbol + runtime name
```

运行证据按从强到弱的顺序对齐：

- `source-exact`：repository、revision、path、symbol 完整一致；
- `source-unverified`：repository、path、symbol 一致，但运行事件未携带 revision；
- `name-unique`：运行事件已声明同一 repository，且该 repository 当前扫描结果中只有一个同名 Tool；
- `ambiguous`：同一位置或名称对应多个声明，不自动合并；
- `unmatched`：repository、revision 不同，或证据不足以核验 identity。

缺少 repository identity 的同名事件不会跨仓库猜测。未对齐的注册与调用会保留在侧栏的 `UNALIGNED RUNTIME` 区，可查看原事件和返回运行步骤，但不会进入任何 Tool 卡片。

## 声明与静态注册路径

V1 只读解析 Python AST，支持：

- `@tool` 装饰的顶层函数；
- 继承 `Tool` 或以 `Tool` 为语义基类的类；
- 模块顶层赋值的 `ToolCard(...)`；
- ToolCard 中可静态求值的名称、描述、暴露方式、无状态/并行安全/幂等标记和参数名。

无法静态求值的字段保留为未知或使用符号名，不导入模块补全信息。静态注册调用归一化为：

| Mechanism | 典型入口 | 含义 |
|---|---|---|
| `ability-card` | `AbilityManager.add(...)` | 通过 Ability card 装配 Tool |
| `ability-resource` | AbilityManager resource 入口 | 通过资源对象装配 Tool |
| `resource-manager` | `resource_mgr.add_tool(...)` | 加入 Tool resource manager |
| `ownership-helper` | `register_tool(...)` | 通过所属对象或辅助函数注册 |

静态路径保存 callee、所在容器、目标表达式、候选名称、已解析 Tool ID 和源码行。`exact / inferred / dynamic` 只表达静态置信度，画布始终以虚线分支与运行证据区分。

## Host 目录读取授权

前端从 Local Plugin Host 快照读取固定插件 `openjiuwen.host.tool-catalog`，核验：

- 插件状态为 `active`；
- `repository.tools.read` 已授予；
- `repository.tools.read` Host capability 存在。

画布显示 `authorized / blocked / disabled / offline / loading / unavailable`，并在 Inspector 中展示 diagnostic。这个节点的 scope 固定为 `catalog-read-only`，不能用于推导逐 Tool 执行权限。

## Runtime 注册与调用

注册投影兼容以下真实事件形态：

- `payload.tools` 字符串数组；
- `payload.toolName / abilityName / name`；
- `details` 中 label 为 `tool` 的多条记录。

调用投影按 `traceId + spanId + tool name` 配对 `tool.call` 的 `start` 与 `end / error`，保存：

- trace、span、sequence、耗时和状态；
- member / agent / subagent owner 与 context owner；
- 参数、结果或错误；
- definition source 与 identity 对齐等级；
- 原始起止事件，用于返回 Runtime 时间轴。

参数与结果默认显示脱敏摘要。用户点击“展开本次原文”后才在本机界面展示该调用的完整值；切换到另一调用时自动恢复折叠。此功能不会把原文写入 Git 或浏览器日志。

## 本地 API

`POST /api/v1/repositories/tools`

```json
{
  "path": "C:\\path\\to\\agent-core",
  "options": {
    "includeTests": false,
    "maxFiles": 5000,
    "maxFileBytes": 1000000,
    "maxTools": 5000,
    "maxRegistrationSites": 10000
  }
}
```

响应使用 `schemaVersion: "1.0.0"`，包含 repository、tools、registrationSites、statistics、warnings，并始终声明 `writeOperations: false`。达到任一上限时 `statistics.truncated` 为 `true`，调用方必须把结果视为不完整目录。

## 页面投影

定义工作台中的“Tool 注册表”使用独立深入画布：

```text
Repository → Code discovery → Catalog read authorization → Runtime registration → Tool call
                           └─ - - Static registration paths
```

- Core 与 Swarm Tool 卡片继续使用浅青和浅紫区分，证据类型通过颜色、图标、形状和文字共同表达。
- 没有运行事件的阶段保留显式空缺节点，防止把“未发生”误读为“未展示”。
- 搜索和四阶段过滤作用于完整目录；画布只投影当前 Tool 的有界证据。
- 点击 Tool、授权、静态路径、运行注册或调用节点，在右侧查看对应证据。
- 源码证据可打开只读 Source Viewer；运行证据可返回原 Trace 的精确 sequence。
- 画布支持拖拽、实时避碰、可调磁吸、缩放、fit 和缩略图。

Tool Catalog 由 `openjiuwen.tool-catalog` 插件贡献，并保留旧的 `graph.definition.tool-registry.v1` capability 作为兼容别名；新功能声明 `graph.tool-evidence.v1` 与 `runtime.tool.call.observe`。

## 安全与限制

- 扫描器不 import、eval、exec 或运行目标仓入口，只读取受白名单约束的 Python 文件并调用 `ast.parse`。
- 跳过 symlink、junction、缓存、构建目录和超大文件；文件、Tool 与注册点均有硬上限。
- V1 不执行 Tool、不连接 MCP server、不读取模型或工具凭据、不写仓库。
- Host 的目录读取授权不是逐 Tool 执行授权；V1 尚未提供写 Tool 或逐操作审批。
- V1 不进行跨文件通用数据流求值。工厂、循环、配置驱动和运行时反射注册会保留为 `dynamic`。
- MCP/远程 Tool 的真实枚举、参数 schema 和健康状态需要后续独立 adapter，不能由静态扫描猜测。
