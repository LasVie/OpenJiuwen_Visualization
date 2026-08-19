# Local Plugin Host V1

## 目标与边界

Local Plugin Host 把浏览器里的“模块开关”扩展为服务端最终授权边界。浏览器 Workbench 仍负责页面 contribution、依赖关系和入口收敛；本地 Host 负责插件来源、生命周期、权限、凭据引用和审计。两者使用稳定映射同步状态，但不能互相替代：隐藏前端入口不等于撤销服务权限，Host 拒绝后前端也不能绕过它直接启动 Provider、Executor 或 Tool 索引。

V1 注册两个内置插件：

| Host plugin | Browser module | Responsibility |
|---|---|---|
| `openjiuwen.host.openrouter` | `openjiuwen.openrouter-provider` | OpenRouter 注册表、网络调用与凭据句柄 |
| `openjiuwen.host.tool-catalog` | `openjiuwen.tool-catalog` | 允许根目录内的只读 Tool AST 索引 |

Host 状态为 `active / blocked / disabled`。`disabled` 表示用户关闭生命周期；`blocked` 表示用户仍希望启用，但必需权限已撤销或 secret handle 当前无法解析。状态变化会刷新浏览器 Workbench 和四个真实 Executor 的可用性。每个新的调用在进入 Provider、Executor 或 Tool Catalog 前都会再次通过 Host gate；取消既有调用始终保留，避免撤权后无法终止运行。

## 信任与发现

- 内置插件使用 `bundled-trusted`，随当前本地服务发布并自动信任。manifest 的完整性摘要用于稳定识别和变更检查，不代表第三方密码学签名或供应链证明。
- 未签名本地 manifest 默认完全关闭。只有同时提供 `--allow-unsigned-plugins` 和至少一个 `--plugin-dev-root` 才进入开发者模式；每个根目录必须位于 `--allow-root` 内。
- Host 只发现授权开发根目录下的 `*.openjiuwen-plugin.json`，解析后再次校验真实路径。单文件最多 256 KiB，最多发现 100 个 manifest，字段使用关闭式 schema。
- 未签名插件首次启用必须显式确认。V1 只读取声明式 manifest，不加载其 Python/JavaScript，不创建第三方进程，也不执行任意插件代码。
- manifest schema 与 Host API 当前均为 `1.0.0`。来源 identity、版本、capabilities、permissions 和 integrity 会出现在无凭据的 Host 快照中。

## 权限模型

| Permission kind | V1 policy |
|---|---|
| `read` | 安装时固定授权，不能由普通开关撤销；具体读取仍受 repository allow-root 等既有边界约束 |
| `network` | 可撤销；撤销后新 Provider/Executor 调用在服务端最终 gate 失败 |
| `secret` | 可撤销；插件只获得 opaque handle 状态，值只由 Host 在调用时解析 |
| `write` | 必须声明为 `per-operation`；V1 没有通用写执行器，也不提供永久授权开关 |

OpenRouter 使用 `openrouter.default` 句柄。快照只返回 `resolved: true/false` 和 `storage: host-environment`，不会返回环境变量名或值。实际 key 仍只从 `OPENJIUWEN_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` 解析，既不进入浏览器，也不进入 Host 数据库、审计、Trace metadata 或日志。模型输入和输出仍按 Runtime 归档合同保存到本机，并在用户启动调用时发送到 OpenRouter；opaque handle 只隔离凭据，不改变上游数据处理边界。

## 持久化与审计

Host 默认使用首个允许根目录下的 `.openjiuwen-visualization/plugin-host.sqlite3`，启用 SQLite WAL 与 schema migration。生命周期和可撤销授权在服务重启后保留。路径可由 `--plugin-host-path` 覆盖，但必须仍位于允许根目录内。

本机审计最多保留最近 5,000 条事件，只记录：

- 时间、plugin id、action、target；
- `allowed / denied` 等 outcome；
- 稳定、无业务原文的 detail code。

审计不记录 secret、prompt、Context、Tool 参数/结果、Rail 输入/输出或模型文本。Host 数据库位于项目忽略目录，不进入 Git；Runtime 原文仍由独立归档数据库管理。

## Loopback API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/plugin-host` | 返回 Host 策略、开发模式、插件、权限、opaque handles 和审计计数 |
| `GET` | `/api/v1/plugin-host/audit?after=0&limit=100` | 游标读取本机无原文审计 |
| `POST` | `/api/v1/plugin-host/plugins/{id}/state` | 设置 `{ "enabled": boolean }`；未签名插件启用还需 `{ "confirmed": true }` |
| `POST` | `/api/v1/plugin-host/plugins/{id}/permissions/{permissionId}` | 设置可撤销权限的 `{ "granted": boolean }` |

所有接口只在现有 loopback/Origin 白名单边界内提供。Host 还把状态附加到 OpenRouter 和各 Executor registry；前端必须显示具体阻塞原因，而不是把 Host 拒绝误报为依赖未安装。

## 页面与模块收敛

“模块”页面分为两个工作台：

- “工作台模块”管理浏览器 contribution 和依赖图；
- “Local Plugin Host”查看服务端插件、信任来源、生命周期、权限、凭据句柄、capabilities、开发模式与审计。

OpenRouter 与 Tool Catalog 的浏览器模块映射到 Host。任一侧请求关闭都会通过 Host 形成服务端最终状态；重新开启依赖后，下游 Executor 按既有 `requestedEnabled` 语义自动恢复。Host 离线时页面保留工作台模块信息，但不能把它当作服务授权成功。

## V1 非目标

- 不从页面安装、卸载、升级或下载插件；
- 不为第三方插件执行动态代码，也没有进程沙箱、崩溃监督或热升级；
- 不提供通用本机 vault/系统凭据录入 UI；OpenRouter 仍由服务进程环境配置；
- 不实现通用写操作审批 UI；所有未来写动作必须逐次确认并进入独立审计；
- 不声称内置 manifest integrity 等同第三方签名；后续签名链和发布者信任必须另行设计；
- 不把 Tool 静态声明或 `catalog-read-only` 授权自动视为 Runtime 已注册或已调用；Tool Registry 四层证据已分别消费 `ability.register` 与 `tool.call`。
