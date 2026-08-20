# Controlled Development Execution V1

## 阶段边界

本协议把 Development 的“建议”与“执行”明确拆开。确定性九步分析和 OpenRouter 只读增强仍然不会写仓库；只有用户把一份完整 unified diff 送入独立受控执行模块，并对后续每个动作逐次确认，服务端才会创建隔离 Git 状态。

服务端与浏览器 V1 均已交付。浏览器只在 Workbench 和 Host 的 Controlled Development Executor 同时开启时显示入口；模块关闭后清除当前完整执行详情，服务端继续作为最终授权边界。

V1 的硬边界：

- 不修改所绑定仓库当前 checkout 的文件；
- 不提供 fetch、pull、merge、rebase、push、force-push 或远端 PR 写入；
- 不接受 Shell 字符串或任意命令；
- 不接受二进制、删除、重命名、复制、mode 或 submodule patch；
- apply、test、commit、rollback 分别消费一次精确摘要绑定的确认；
- 插件关闭时，预览和所有新操作均由 Local Plugin Host 最终阻止。

## 模块与权限

Host 内置插件 `openjiuwen.host.development-executor` 默认关闭。启用后只获得固定的只读预览能力，四项写类权限仍保持 `grantMode=per-operation`，不能被持久授予：

| Permission | 动作 | 摘要绑定 |
|---|---|---|
| `repository.patch.apply` | 创建隔离 worktree/branch 并应用补丁 | execution preview SHA-256 |
| `repository.test.run` | 运行一项 Host 识别的测试 profile | test plan SHA-256 |
| `repository.git.commit` | 在生成分支创建一个本地 commit | message + staged diff + branch SHA-256 |
| `repository.branch.rollback` | 删除未发生外部推进的生成 worktree/branch | 当前 status + branch + commit SHA-256 |

审批与结果进入 Plugin Host 的无业务原文审计。完整 diff、测试输出和执行状态保存在单独的 `development-executions.sqlite3`，不会复制进 Host 审计、Runtime Archive 或 Development Session。

## 生命周期

```text
unified diff
    │ read-only validation against temporary Git index
    ▼
previewed ── approve apply ──> applied
                                 │
                                 ├── approve allowlisted test ──> tested / test_failed
                                 │                                  │
                                 └──────────────────────────────────┘
                                                    approve commit
                                                          │
                                                          ▼
                                                     committed

previewed / applied / tested / committed
    └── approve rollback ──> rolled_back
```

`applying / testing / committing` 是持久中间态，便于服务异常后显示真实状态。服务不会因重启而自动删除分支或 worktree；恢复后的显式 rollback 仍需重新核验摘要和分支 HEAD。

## Preview 合同

`POST /api/v1/development/executions` 接收：

```json
{
  "repositoryPath": "C:\\workspace\\agent-core",
  "baseRevision": "full-local-commit-sha",
  "intent": "reviewed development intent",
  "unifiedDiff": "diff --git ..."
}
```

Preview 只写本工具自己的 SQLite 状态，不创建 branch/worktree。服务端再次解析当前 Git identity，要求 source checkout 干净且 HEAD 与 `baseRevision` 完全一致，然后使用临时 `GIT_INDEX_FILE` 执行 `read-tree + git apply --cached --check`。

限制：

- patch 最多 512 KiB、12 个文件；
- 路径必须是 portable repository-relative path，拒绝 traversal、`.git`、应用状态目录、symlink 和 junction；
- 只支持普通文本新增与修改，新文件固定 mode `100644`；
- 精确文件路径成为本次操作不可扩张的 allowlist；
- preview 返回完整 diff、文件级增删统计、目标 branch、test profiles、政策声明和 SHA-256。

## 隔离应用

Apply 前服务重新核验 source checkout 的 path、HEAD 和 clean 状态。生成分支命名为 `openjiuwen-visualization/<opaque-id>`，worktree 固定放在 allow-root 内的 `.openjiuwen-visualization/development-worktrees/<execution-id>`。

所有 Git 调用使用参数数组且 `shell=False`，关闭 hooks、GPG signing、fsmonitor、system/global attributes 和交互式 credential prompt。创建 worktree 前还会读取 revision 内全部 `.gitattributes` 及 Git common dir 的 `info/attributes`；发现 checkout filter 或 `working-tree-encoding` 时拒绝执行。补丁使用 `git apply --index`，完成后重新比较 staged path 集合和完整 staged diff 摘要。

## 测试白名单

浏览器不能提交命令。服务端只从仓库已知文件生成固定 profile，V1 最多返回四项：

- `python -B services/local-server/scripts/run_tests.py`；
- `python -B -m pytest -q`；
- `npm test`；
- `npm run check`。

实际命令、工作目录、180 秒 timeout 和 plan SHA-256 会在调用前完整展示。测试仅在隔离 worktree 运行，设置 `CI=1`、`NO_COLOR=1` 与 `PYTHONDONTWRITEBYTECODE=1`；stdout/stderr 各最多保留 256 KiB。若测试修改任何 tracked 文件，结果强制失败且 commit 被阻止。

测试本质上会执行目标仓代码，因此它是独立逐次审批，而不是 apply 的隐含副作用。

## Commit 与 rollback

有检测到 test profile 时，至少一项最近测试必须成功才能生成 commit preview。Commit preview 把单行 message、branch、staged diff SHA-256 和 `push=false` 组合成新的 approval SHA-256；确认后只提交已暂存的 reviewed paths，并删除隔离 worktree，保留本地 branch。

Rollback 会先核验生成 branch HEAD 没有被外部推进。核验通过后，只删除该 execution 的精确 worktree 和 branch；source checkout 始终不变。若用户已经在外部推进或检出该 branch，服务拒绝自动删除。

## API

| Method | Path | 作用 |
|---|---|---|
| `GET` | `/api/v1/development/executions` | 读取不含 diff 原文的执行列表 |
| `POST` | `/api/v1/development/executions` | 只读验证并持久化完整 preview |
| `GET` | `/api/v1/development/executions/{id}` | 读取完整本机 diff、结果与审计事件 |
| `POST` | `/api/v1/development/executions/{id}/apply` | 逐次确认后创建隔离分支并应用 |
| `POST` | `/api/v1/development/executions/{id}/tests` | 逐次确认后运行一个固定 profile |
| `POST` | `/api/v1/development/executions/{id}/commit-preview` | 生成 message/diff 绑定的 commit 摘要 |
| `POST` | `/api/v1/development/executions/{id}/commit` | 逐次确认后创建本地 branch commit |
| `POST` | `/api/v1/development/executions/{id}/rollback` | 逐次确认后删除本工具拥有的隔离状态 |

## 浏览器审批画布

`adapters/development-execution/` 只接受 `apiVersion=1.0.0` 且满足安全 policy 的响应；若服务声称可以写 source checkout、执行任意命令或自动 push，客户端会拒绝该响应。`features/development-execution/` 管理本次完整 diff、执行状态、历史索引和四类精确确认，不把这些状态混入只读 Development projection。

入口画布把生命周期投影为六个可点击节点：

- `审查完整 Diff → 隔离应用 → 白名单测试 → 本地分支提交` 是主链；
- `Source checkout` 是受保护的不变量旁支；
- `精确回滚` 是从隔离状态分出的恢复旁支。

画布支持拖拽、平移、缩放、fit、MiniMap，以及与其他画布相同的实时防重叠和可调磁吸。进入或状态变化时自动 fit，但用户仍可独立调整节点位置。

每个动作面板只显示该动作实际消费的字段：Apply 展示完整 diff、文件 allowlist 和 preview SHA；Test 展示固定 command/workdir/timeout 与 plan SHA；Commit 在单行 message 后再次读取 staged diff SHA、branch 和 `push=false`；Rollback 展示当前状态绑定的 rollback SHA。选择其他节点、profile、message 或服务端状态变化都会使已有勾选失效。

执行列表默认只读取仓库、branch、状态、统计、摘要和时间；点击某条记录后才读取该条完整 diff、测试 stdout/stderr 与本机事件。列表不把元数据记录误画成已加载原文。

## 当前限制

- OpenRouter 只读增强仍禁止生成可应用 patch；V1 执行入口接收用户已经审查的 unified diff。
- 不支持 dirty source checkout、历史 revision、删除/重命名、多个 commit 或变基。
- 测试调用当前是同步 HTTP 请求；timeout 会终止直接测试进程，但 V1 尚未提供通用 OS 级进程沙箱。
- committed branch 只存在本机；没有 push/PR 创建能力。
