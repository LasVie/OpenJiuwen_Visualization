# Source Evidence Viewer V1

Source Evidence Viewer V1 把 Definition、Change 和 Tool 节点已有的源码引用升级为可按需打开的统一只读窗口。它展示当前工作树中的有界源码行、聚焦范围、行号、内容哈希与 revision 对齐状态，不执行目标代码，也不向浏览器开放任意文件系统路径。

## 触发位置

统一 `features/source-viewer/` 组件当前接入：

- Definition 节点的 `GraphSourceReference`；
- Change 节点影响的源码证据；
- Tool 声明与静态注册点的 `ToolCatalogSourceReference`；
- Runtime 事件通过结构化 source identity 定位后的 Definition/Change 节点。

Package/目录节点不会显示源码按钮。窗口只在用户点击“查看源码”后请求内容；切换节点、关闭窗口或卸载组件会中止未完成请求。

## 本地 API

`POST /api/v1/repositories/source`：

```json
{
  "path": "C:\\workspace\\agent-core",
  "relativePath": "openjiuwen/core/agent/agent.py",
  "startLine": 120,
  "endLine": 168,
  "revision": "0123456789abcdef",
  "options": {
    "contextLines": 6,
    "maxLines": 240,
    "maxFileBytes": 2000000
  }
}
```

响应包含：

- 当前 repository identity 与 dirty 状态；
- repository-relative path、语言、检测到的编码和完整文件 SHA-256；
- 请求 revision、当前 HEAD 与 `revisionMatches`；
- 请求范围、有效 focus、实际 excerpt、总行数和截断状态；
- 每行的稳定行号、原文与 `focus` 标志；
- `contentBasis: working-tree`、`readOnly: true`、`writeOperations: false`。

没有 `endLine` 的 module/file 引用默认聚焦起始行后的 80 行；窗口最多返回 240 行，服务协议硬上限为 500 行。超过上限时不会静默声称完整，而是返回 `truncated` 或 `focusTruncated`。

## 路径与内容安全

服务先解析请求中的仓库/子目录，随后对源码路径执行独立校验：

1. 只接受规范化的 repository-relative path；
2. 拒绝绝对路径、空段、`.`、`..` 与超长路径；
3. 逐段拒绝 symlink 和 junction；
4. 最终解析路径必须仍位于用户选中的 `scanScope`；
5. 只读取 regular file；目录、缺失文件和越界文件均返回结构化错误；
6. 单文件默认最多读取 2 MB，协议允许值不超过 4 MB；
7. 包含 NUL 的二进制内容不进入 UI；Python 遵循源文件编码声明，其他文本使用 UTF-8。

API 不提供目录枚举、任意绝对路径读取、保存、编辑或执行能力。响应继续使用 loopback Origin 白名单、`Cache-Control: no-store` 与 `nosniff`。

## Revision 语义

窗口读取的是当前工作树，而不是历史 Git blob：

- source revision 等于当前 HEAD 且仓库干净时，窗口显示对齐证据；
- source revision 不同，窗口显示明确 warning；
- 仓库 dirty 时，即使 HEAD 相同也提示内容可能包含未提交修改；
- V1 不自动 checkout 或调用 `git show` 获取历史内容。

这与 Change Plane 的 exact/inferred 规则保持一致，避免把当前文件正文伪装成历史 commit 或远端 PR head 的原文。

真实执行器会在本地服务边界读取已验证仓库的 HEAD，并为已知 Runtime definition 附加 revision。该值只证明启动时观察到的 commit；仓库 dirty 时仍必须显示 warning。确定性录制或外部 producer 未提供 revision 时，跨平面匹配显示 `revision-unverified`，不会把缺失值当作对齐。

## UI 行为

源码窗口使用浅色、行号稳定的独立画布：

- 聚焦范围以暖色行背景和左侧标记展示；
- 非聚焦上下文仍保留，方便理解函数/类边界；
- Esc、关闭按钮和遮罩空白处均可关闭，焦点回到原触发按钮；
- modal 打开时锁定页面滚动，并在内部循环键盘焦点；
- loading、结构化错误、重试、dirty/revision warning 和截断提示都在同一组件处理。

后续编辑、跳转 IDE、历史 revision 浏览或语义 diff 必须作为新的显式能力加入；不能把本 V1 的只读读取入口扩成隐式写接口。
