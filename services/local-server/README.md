# Local Repository Service

该服务为 Visualization Web 提供本地仓库的只读边界。它只使用 Python 标准库，不导入目标仓模块，不执行仓库脚本，也不提供 Git 或文件写接口。

## 启动

从仓库根目录运行：

```powershell
python -B services/local-server/scripts/run_server.py `
  --allow-root "C:\path\to\workspace" `
  --allow-origin "http://127.0.0.1:4173"
```

默认只监听 `127.0.0.1:8765`。`--allow-root` 可重复；所有扫描路径及 Git 根都必须位于其中。非 loopback host 会被拒绝。

## API V1

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | 返回 API 版本与 `read-only` 模式 |
| `GET` | `/api/v1/repositories` | 返回启动时配置的允许根目录 |
| `POST` | `/api/v1/repositories/scan` | 解析一个允许范围内的 Git 仓库或子目录 |

扫描请求：

```json
{
  "path": "C:\\path\\to\\agent-core",
  "options": {
    "includeTests": false,
    "includeFunctions": false,
    "maxFiles": 5000,
    "maxEdges": 20000
  }
}
```

响应包含 repository identity、Graph Kernel V1 snapshot、扫描统计和非致命 warnings。节点 ID 组合 Git revision、仓库相对路径与符号限定名；工作树存在修改时，evidence 会明确标记其超出引用 revision。

## 安全约束

- 使用规范化绝对路径与允许根目录校验，跳过 symlink/junction 和越界解析结果。
- Git 只通过参数数组执行只读命令，禁用 shell。
- Python 仅经 `ast.parse` 分析；不 import、eval、exec 或运行目标仓入口。
- 浏览器 Origin 必须在启动白名单中；响应禁止缓存并设置 `nosniff`。
- 请求体有大小上限，文件、文件数量和边数量均有扫描上限。
- 当前没有任何写、命令执行、模型调用或凭据接口。

## 验证

```powershell
python -B services/local-server/scripts/run_tests.py
```
