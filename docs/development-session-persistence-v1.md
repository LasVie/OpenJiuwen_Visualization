# Development Analysis Session Persistence V1

## 目标与边界

Development 分析完成后自动形成一个可恢复的本机 Session，使用户能够离开页面、重启前端或稍后回到同一份开发证据链。V1 持久化的是只读分析结果，不是可继续执行的 Agent 会话，也不获得目标仓库、Shell、Git、网络或模型权限。

稳定边界：

```text
storage              = sqlite / wal / local-only
analysis engine      = deterministic-static
repositoryWrite      = false
full analysis read   = restore-or-export
retention            = 30 days
logical size limit   = 2 GiB
```

数据库默认位于首个 `--allow-root` 内的 `.openjiuwen-visualization/development-sessions.sqlite3`。该目录不属于 Git 内容；自定义路径仍必须位于允许根目录内。

## 模块划分

- `services/local-server/.../development_sessions.py`：SQLite/WAL、schema migration、payload 验证、保留、导出和删除；
- `adapters/development-session/`：loopback URL 约束、版本化响应校验和显式完整读取；
- `features/development-assistant/session.ts`：前端序列化与恢复时的只读投影合同校验；
- `features/development-assistant/use-development-sessions.ts`：自动保存、列表刷新、恢复、导出和删除状态；
- `DevelopmentSessionPanel.tsx`：本机 Session 管理界面；
- `DevelopmentAssistantWorkspace.tsx`：只编排分析结果与 Session feature，不直接拼接存储 URL。

Session 使用独立数据库，不与 Runtime Trace 原文档案或 Plugin Host 状态表耦合。以后增加模型增强字段时应通过显式 schema migration 和版本化 payload 合同演进，不在现有 JSON 中静默改变语义。

## 保存合同

每次成功生成九步 Development projection 后，前端自动提交当前完整分析。服务端不信任浏览器声明，并再次验证：

- repository path 必须仍在启动时授权的 allow-root 内；
- `readOnly=true` 且 `repositoryWrite=false`；
- 阶段必须严格按九步只读序列排列；
- evidence / impact / change / test / patch 数量不超过前端投影上限；
- source 使用仓库相对路径，拒绝绝对路径和 `..` 穿越；
- patch 必须保持 `applicable=false`、`basis=structural-outline` 和不可应用标记；
- payload 只含有限 JSON 类型，深度、项目数、单字段和总字节数均有上限。

数据库保存原始开发意图、repository snapshot、结构化证据、建议、测试层和补丁结构草案。列表只返回本机元数据、意图字符数、计数与内容哈希，不返回原始意图或完整分析。用户点击“恢复”或“导出”才读取完整 payload。

## API V1

| Method | Path | 语义 |
|---|---|---|
| `GET` | `/api/v1/development/sessions` | 分页读取 Session 元数据与存储状态，不含完整分析 |
| `POST` | `/api/v1/development/sessions` | 保存一份已验证的只读分析 |
| `GET` | `/api/v1/development/sessions/{id}` | 用户显式恢复完整分析 |
| `GET` | `/api/v1/development/sessions/{id}/export` | 用户显式导出含完整分析的 JSON |
| `DELETE` | `/api/v1/development/sessions/{id}` | 删除索引与完整分析 |

API 不提供更新 repository、运行测试、应用 patch、执行命令、创建分支或 commit 的路由。

## 保留、删除与导出

- 默认保留 30 天，按 `updated_at` 清理过期 Session；
- 完整分析逻辑总量默认限制为 2 GiB，超限时先删除最旧 Session；
- 删除启用 SQLite `secure_delete`，随后执行 WAL checkpoint；
- 页面删除必须先显示明确二次确认，说明原始意图、结构化结果和索引会一起删除；
- 导出文件包含完整本机分析，文件名为 `{sessionId}-development-session.json`；
- 数据库、完整分析和导出内容不会自动进入 Git、应用日志或远程服务。

## 页面语义

左侧“分析 Sessions”入口始终显示连接状态和本机记录数量。当前分析工具栏区分“正在保存 / 本机已保存 / 未保存”；存储失败不丢弃画布上的分析，也不会伪装成已保存。

Session 抽屉显示 SQLite/WAL、记录数、逻辑字节、保留期、仓库/revision/dirty snapshot 和五类结果计数。恢复会重新载入原始开发意图与整条 projection，并把步骤复位到第 1 步；它不会重新扫描或把历史证据提升为当前 revision 的事实。用户随后再次点击生成时，才基于当前工作树形成一个新 Session。

## 验证与限制

自动化覆盖 WAL/schema 重开、列表不泄露原始意图、显式恢复/导出、删除、allow-root、只读/patch/path 拒绝、adapter 版本校验和前端 projection round-trip。真实浏览器覆盖自动保存、管理抽屉、恢复、删除确认、1280×720、1024×768 和 console。

V1 明确不支持：

- Session 重命名、搜索、标签和两次 Development 分析对比；
- 把历史 Session 恢复成可执行任务；
- 自动重新核验历史 source 与当前工作树差异；
- 模型增强结果的持久化；该字段需在后续阶段定义独立合同；
- 任何目标仓库写入或测试/Git 执行。
