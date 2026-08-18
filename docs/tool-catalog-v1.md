# Registered Tools Catalog V1

## 目标与事实边界

Tool Catalog 将一个仓库里的 Tool 信息拆成三层证据，避免把静态代码形态误报为实际运行结果：

1. **声明（Declaration）**：AST 中存在 `@tool`、Tool 子类或顶层 `ToolCard`。
2. **静态注册路径（Static registration path）**：代码中存在可识别的 Ability/Resource 注册调用，并能精确或推断关联到声明。
3. **运行确认（Runtime confirmation）**：当前 Trace 收到了显式 `ability.register` 事件。

“静态已关联”只表示源码中存在注册路径，不表示该 Tool 已在当前进程中完成注册。只有第三层可以显示为本次运行已观察。

## 声明识别

V1 只读解析 Python AST，支持：

- `@tool` 装饰的顶层函数；
- 继承 `Tool` 或以 `Tool` 为语义基类的类；
- 模块顶层赋值的 `ToolCard(...)`；
- ToolCard 中可静态求值的名称、描述、暴露方式、无状态/并行安全/幂等标记和参数名。

无法静态求值的字段保留为未知或使用符号名，不导入模块补全信息。

## 注册路径识别

V1 将下列调用归一化为注册节点：

| Mechanism | 典型入口 | 含义 |
|---|---|---|
| `ability-card` | `AbilityManager.add(...)` 一类 card 注册 | 通过 Ability card 装配 Tool |
| `ability-resource` | AbilityManager 的 resource 注册入口 | 通过资源对象装配 Tool |
| `resource-manager` | `resource_mgr.add_tool(...)` | 加入 Tool resource manager |
| `ownership-helper` | `register_tool(...)` | 通过所属对象或辅助函数注册 |

每个注册点保存 callee、所在容器、目标表达式、候选名称、已解析 Tool ID 和源码行。置信度含义：

- `exact`：调用参数能唯一指向 Tool 声明；
- `inferred`：通过唯一名称、别名或局部符号建立关联；
- `dynamic`：发现了注册行为，但数据流在运行期决定，静态扫描不强行连线。

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

## Runtime 关联

运行态只消费显式 `ability.register`：

```json
{
  "schemaVersion": "1.0.0",
  "sequence": 18,
  "timestampMs": 1730000000180,
  "kind": "ability.register",
  "spanId": "agent-run",
  "payload": {
    "toolName": "browser_batch_interact",
    "abilityType": "tool",
    "ownerId": "deep-agent",
    "source": "AbilityManager"
  }
}
```

页面按 `toolName` 与静态目录关联，并保留 sequence、owner、source 和时间戳。没有匹配到静态声明的运行事件仍可由 Runtime 链路展示，但不会伪造源码定义。

## 页面投影

定义工作台中的“Tool 注册表”使用独立画布：

```text
Repository → Tool declaration → Registration site → Runtime observation
```

- Core 使用浅青蓝 Tool 卡片，Swarm 使用浅紫 Tool 卡片；状态同时有文字标签，不能只依赖颜色。
- 搜索和状态过滤作用于完整目录；画布只投影当前 Tool 及其关联证据。
- 点击 Tool、注册点或运行观察均可在右侧查看 card metadata、源码位置、目标表达式和事件证据。
- 画布支持拖拽、实时避碰、可调磁吸、缩放、fit 和缩略图。

Tool Catalog 由 `openjiuwen.tool-catalog` 插件贡献。关闭其依赖 `openjiuwen.local-repository` 时，该插件进入 blocked，不留下半可用入口。

## 安全与限制

- 扫描器不 import、eval、exec 或运行目标仓入口，只读取受白名单约束的 Python 文件并调用 `ast.parse`。
- 跳过 symlink、junction、缓存、构建目录和超大文件；文件、Tool 与注册点均有硬上限。
- 不执行 Tool，不连接 MCP server，不读取模型或工具凭据，不写仓库。
- V1 不进行跨文件通用数据流求值。工厂、循环、配置驱动和运行时反射注册会保留为 `dynamic`。
- MCP/远程 Tool 的真实枚举、参数 schema 和健康状态属于后续独立 adapter，不应由静态扫描猜测。
