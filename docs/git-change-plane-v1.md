# Git Change Plane V1

Git Change Plane V1 把本地只读 Git diff 与 Repository Definition 图叠加，回答“哪些文件变了、哪些代码节点被直接命中、哪些容器或关系节点可能受影响”。当前只读取工作树、commit 与本地已有 refs；不会执行 `fetch`、`checkout`、`merge`、`reset` 或任何写操作。

## 数据源插件

`openjiuwen.git-change` 依赖 `openjiuwen.local-repository`，并注册 `openjiuwen.local-git-change`：

- transport：`loopback-http`；
- modes：`working-tree | compare`；
- `readOnly: true`；
- `remoteFetch: false`。

关闭 Local Repository 插件时，Git Change 插件会自动进入 `blocked`，不会留下半可用的变更数据源。

## 本地 API

`POST /api/v1/repositories/changes`：

```json
{
  "path": "C:\\workspace\\agent-core",
  "mode": "compare",
  "base": "main",
  "head": "HEAD",
  "options": {
    "includeUntracked": true,
    "maxFiles": 500
  }
}
```

### `working-tree`

- 以当前 `HEAD` 为 base；
- 通过 porcelain v1 同时区分 staged、unstaged 与 untracked；
- tracked 文件的统计和零上下文 hunk 来自 `git diff HEAD`；
- 未跟踪文件不读取或伪造 patch，保留文件级影响。

### `compare`

- base/head 必须是非 option 的本地 Git revision expression；
- 服务先把两者解析为 commit SHA，再计算 merge base；
- 变更范围采用 `merge-base → head`，与 PR 的变更语义兼容；
- `refs/pull/<id>/head` 等 ref 只有已存在本地时才可使用，服务不会自行 fetch。

响应包含 repository identity、resolved refs、merge base、文件状态、重命名源路径、增删统计、二进制标记和 hunk 的 old/new 行范围。所有路径再次规范化为仓库相对路径；输出、文件数量和 Git 命令都有边界与超时。

## 节点影响映射

页面并行读取 Git change set 与 Python AST Definition snapshot，再由 `features/change-plane/model.ts` 归一化：

1. `direct`：节点源码范围与 hunk 行范围相交；
2. `container`：直接变更节点的 module/package/repository 祖先；
3. `dependent`：通过 imports、inherits 等非 contains 关系连接的节点；
4. `file`：没有可对齐完整符号范围时的文件级影响。

只有 `working-tree`，或 compare head 等于当前干净检出的 revision 时，行号命中才标记为 `exact`。比较其他 commit、当前检出含未提交内容、删除/重命名/二进制等情况会标记为 `inferred`。这避免用当前 AST 错配历史 commit 的源码行号。

## 页面交互

顶部“变更图”进入独立 Change Plane：

- 左侧选择仓库、工作树或 base/head，并浏览变更文件；
- 中间画布按 Change Set → File → Direct/Container → Dependent 展示，可拖拽、缩放、fit、开关磁吸；
- 右侧展示 staged/unstaged、增删行、hunk 范围、源码证据与置信度；
- 文件列表和画布只展示关系，不读取或执行目标代码正文。

## GitHub PR 后续边界

远端 PR adapter 只需把 GitHub base/head 元数据和 refs 归一化到同一 change contract。是否允许自动 fetch、使用 GitHub App 还是个人 token、私有仓权限与评论/写操作范围都属于后续产品决策；V1 不预设也不请求这些权限。
