# GitHub Pull Request Adapter V1

GitHub Pull Request Adapter V1 将公共 PR 的元数据与 changed files 归一化为 Change Kernel 的文件、统计和 hunk 合同，再与用户选中的本地仓 AST 定义图叠加。它只读远端网络和本地文件；不会 fetch、checkout、创建 refs、评论、review、merge 或修改 GitHub。

## 插件与信任边界

`openjiuwen.github-pull-request` 是独立 workspace 插件，依赖 `openjiuwen.local-repository`，贡献：

- capability：`github.pull-request.read`、`graph.change.github-pr.v1`；
- mode：`github-pr`；
- transport：`loopback-http`；
- `readOnly: true`、`remoteFetch: true`。

浏览器只把本地仓绝对路径和结构化的 `owner / repository / pullNumber` 发送给 loopback 服务。前端可接受 `https://github.com/owner/repo/pull/123` 或 `owner/repo#123`，但服务端从不接受任意 API URL；远端 origin 固定为 `https://api.github.com`，重定向不会被跟随。

## 本地 API

`POST /api/v1/repositories/github/pull-request`：

```json
{
  "path": "C:\\workspace\\jiuwenswarm",
  "owner": "LasVie",
  "repository": "jiuwenswarm",
  "pullNumber": 2,
  "options": {
    "maxFiles": 500
  }
}
```

服务端顺序调用 GitHub 官方 REST API：

1. `GET /repos/{owner}/{repo}/pulls/{pull_number}`；
2. `GET /repos/{owner}/{repo}/pulls/{pull_number}/files?per_page=100&page=N`。

请求固定发送 `Accept: application/vnd.github+json`、明确的 `User-Agent` 与 `X-GitHub-Api-Version: 2026-03-10`。单次响应、超时、PR 编号、标识符和返回文件数均有边界；V1 最多读取 1000 个文件，页面默认 500。GitHub 的 files endpoint 本身最多返回 3000 个文件，因此超限结果始终标记 `truncated`，不会伪装成完整 PR。

官方合同：

- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
- [List pull requests files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
- [REST API versioning](https://docs.github.com/en/rest/about-the-rest-api/api-versions)

## 响应归一化

响应同时包含：

- 当前本地 repository identity；
- PR 标题、作者、状态、draft/merged、GitHub 页面地址；
- base/head ref、SHA、label 与源仓；
- PR 总 changed files、additions、deletions；
- 当前返回文件的状态、重命名前路径、统计、patch 可用性和零上下文 hunk 行范围；
- GitHub rate-limit 的 limit、remaining、reset epoch；
- `remoteOperations.mutation: false` 与 `writeOperations: false`。

GitHub 可能因二进制文件或 diff 过大而省略 `patch`。适配器不会猜测缺失内容，而是设置 `patchAvailable: false`、写入 warning，并把该文件降级为文件级影响。

## 本地源码对齐

远端 PR 的 `head.sha` 是行号证据边界：

- 本地仓必须是干净检出；
- 本地 `revision` 必须等于 PR `head.sha`；
- 两项同时满足时，hunk 与 AST 符号范围相交可标记 `exact`；
- 否则仍展示路径/行号和关系投影，但统一标记 `inferred`。

V1 不为了获得精确映射而自动下载 PR。用户可以自行在本地准备对应 head checkout，再重新分析；工具本身始终保持只读。

## 认证与限流

公共仓默认使用 GitHub 未认证读取。若确实需要在受控开发机读取调用者已经授权的仓库，可仅在本地服务进程设置 `OPENJIUWEN_GITHUB_TOKEN`；token 只进入服务端 `Authorization` header，不通过 API 响应、浏览器状态、日志或插件偏好返回。页面只显示本次请求是否使用了服务端认证，不显示 token 或 scope。

GitHub 当前文档给出的主要 REST 速率是未认证每小时 60 次、认证用户每小时 5000 次；适配器复用响应头显示剩余额度，不额外轮询。GitHub App、OAuth、细粒度权限选择、组织 SSO 和任何写能力都属于后续独立决策，不在 V1 中推断开启。

限流合同见 [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

## 明确不做

- 不接收 GitHub token、PAT 或 cookie 的浏览器输入；
- 不调用 `git fetch`、`checkout`、`merge`、`reset`；
- 不读取完整文件正文补齐缺失 patch；
- 不评论、review、approve、close 或 merge PR；
- 不假设远端 PR head 与当前本地代码相同；
- 不缓存 PR 原文或凭据到磁盘。
