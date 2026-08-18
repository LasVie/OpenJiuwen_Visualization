# Plugin Control Plane V1

## 目标

Plugin Control Plane 把已注册插件从启动时的隐藏配置提升为可检查、可启停的产品能力。它回答四个问题：

1. 当前安装了哪些模块；
2. 用户希望哪些模块开启；
3. 哪些模块因依赖不可用而被阻塞；
4. 开关变化后，哪些工作台入口和数据贡献仍然有效。

V1 只控制浏览器内的 Workbench 解析，不安装、卸载插件，不启动本地服务，也不修改目标仓库。

## 状态语义

插件状态由 manifest 默认值、浏览器偏好和依赖解析共同决定：

| State | requestedEnabled | Meaning |
|---|---:|---|
| `enabled` | `true` | 用户请求开启，且全部直接和传递依赖均已启用 |
| `disabled` | `false` | 用户明确关闭，插件不贡献任何数据 |
| `blocked` | `true` | 用户仍希望开启，但至少一个依赖未启用 |

依赖被重新启用后，`blocked` 模块自动恢复为 `enabled`。控制中心不会为了满足依赖而静默改写其他模块的用户偏好。

## Manifest 元数据

`VisualizationPluginManifest` 除版本、依赖和 capabilities 外，还声明稳定的 `group`：

- `agent-core`：Core 执行内核、Rail 与 Model 观测；
- `jiuwenswarm`：Swarm 编排、主体层级与 Subagent；
- `integration`：跨仓因果边与确定性回放；
- `workspace`：本地仓、Tool Catalog 与 Git 数据面。

Group 是产品语义，不是任意颜色值。UI 将 Core 映射为青色、Swarm 映射为紫色，并同时显示文字标签，不能只靠颜色区分来源。

`ResolvedPluginStatus` 保留 `description`、`group`、`requestedEnabled`、`defaultEnabled`、`dependencies` 和 `capabilities`，因此 UI 不需要读取具体插件实现。

## 持久化

浏览器只保存与 manifest 默认值不同的覆盖项：

```text
localStorage["openjiuwen.visualization.plugin-states.v1"]
```

读取时只接受当前注册表中已知插件的 boolean 值；未知 ID、非 boolean 值、无效 JSON 都被忽略。浏览器禁止存储时，当前页面会话仍可工作，但不保证刷新后保留设置。“恢复默认”删除全部覆盖项。

插件配置不包含仓库路径、Trace 内容、模型输出、凭据或 write token。

## Workbench 收敛

页面只从当前 `WorkbenchSnapshot` 读取贡献，并按以下规则控制入口：

- Runtime：至少存在一个 fixture、Core Runtime source 或 Swarm Runtime source；
- Definition：存在 `repository.local.read` capability；
- Change：至少存在一个 `changeSource`；
- Tool 注册表：至少存在一个 `toolCatalogSource`；
- Model 录制与面板：存在 Model Provider contribution；
- Subagent 深入画布：存在 `runtime.subagent.execution.v1` capability；
- Rail 深入画布：存在 `graph.rail` capability。

关闭当前 Runtime source 后，页面选择第一个仍可用来源；一个数据平面完全不可用时，其顶层导航进入 disabled 状态。启动时若持久化配置使默认页不可用，页面转到始终可访问的模块控制中心。

Definition/Trace 图使用当前快照重新投影，不继续读取启动时的静态默认图。Fixture store 仍可保留播放状态，但只有 `openjiuwen.deterministic-replay` 实际启用时才暴露演示入口。

## V1 依赖图

```text
openjiuwen.agent-core ──→ openjiuwen.model-provider
          │
          └─────────────→ openjiuwen.integration ←── openjiuwen.jiuwenswarm
                                      │
                                      └──→ openjiuwen.deterministic-replay

openjiuwen.local-repository ──→ openjiuwen.tool-catalog
                 │
                 └────────────→ openjiuwen.git-change
```

控制中心只展示直接依赖和直接下游；传递阻塞由注册器按拓扑顺序计算。

## 扩展边界

- 新插件必须通过 manifest 暴露依赖、group 和 capabilities，不能在 `App.tsx` 内硬编码数据贡献。
- 新顶层平面应从 Workbench contribution 或 capability 推导可用性。
- 真实插件安装、签名、权限审批和服务生命周期不属于 V1；后续应由独立 adapter/host 管理。
- 涉及模型密钥、GitHub token 或文件写入的插件必须在本地服务或受控 host 中实现，不能把凭据写入插件偏好。
