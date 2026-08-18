# Repository Definition Scan Cache V1

Definition Scan Cache V1 减少同一仓库、同一扫描范围和同一选项下的重复 Python AST 解析。它属于本地只读服务能力 `repository.scan.cache.memory`，不会改变 Graph Kernel snapshot 的语义，也不会把缓存扩展为磁盘索引或后台文件监听器。

## 请求流程

每个 `/api/v1/repositories/scan` 请求仍执行以下步骤：

1. 重新解析并授权 repository root 与 scan scope；
2. 读取当前 HEAD、branch 和 dirty 状态；
3. 按 `ScanOptions` 重新枚举受限 Python 输入；
4. 构造输入清单指纹；
5. 只有缓存键和指纹都一致时返回深拷贝快照；否则重新执行 AST scan；
6. 新 AST scan 完成后再次验证输入清单，前后指纹一致才写入缓存。

因此 `hit` 表示“本次请求已经重新验证输入后复用 AST 结果”，不是跳过路径授权或工作树检查。

## 缓存键与指纹

缓存键包含：

- 规范化 repository root；
- 规范化 scan scope；
- `includeTests`、`includeFunctions`、`maxFiles`、`maxFileBytes` 与 `maxEdges`。

SHA-256 清单指纹包含：

- manifest schema 版本；
- root、scope、HEAD revision、branch 与 dirty 状态；
- 完整 ScanOptions；
- 按稳定顺序枚举的仓库相对路径、文件大小、mtime、ctime 与文件内容；
- 枚举阶段的非致命 warning。

源码文件新增、删除、重命名、内容修改、HEAD/branch/扫描范围或选项变化都会得到不同指纹。文件在清单读取期间消失或不可读时不尝试命中；文件在 AST 解析期间变化时，本次结果仍可返回，但状态降级为 `bypass` 且不会写入缓存。

## 容量与失效

默认边界：

| 参数 | 值 |
| --- | ---: |
| 最大条目 | 8 |
| TTL | 300 秒 |
| 清单内容读取上限 | 128 MB |
| 单条快照上限 | 24 MB |
| 快照总预算 | 96 MB |
| 内部可配置条目硬上限 | 32 |
| 内部 TTL 硬上限 | 3600 秒 |

条目按最近使用顺序淘汰，条目数或序列化快照总字节任一超限都会从最久未使用项开始释放。TTL 按最后访问时间计算；服务重启会清空全部条目。若清单内容超过 128 MB、单张图超过 24 MB，或读取时发生竞态，响应状态为 `bypass` 并执行正常 AST scan，结果不会进入缓存。

## API 统计

`statistics.cache` 返回：

```json
{
  "status": "hit",
  "storage": "memory-only",
  "validationMs": 8,
  "sourceDurationMs": 143,
  "ageMs": 1200,
  "pythonFiles": 824,
  "bytesHashed": 6392810,
  "ttlSeconds": 300,
  "maxEntries": 8,
  "resultBytes": 1839021,
  "maxEntryBytes": 24000000,
  "maxTotalBytes": 96000000
}
```

- `durationMs` 是本次请求总耗时；
- `validationMs` 是本次清单校验耗时；
- `sourceDurationMs` 是生成被复用 snapshot 时的原始 AST scan 耗时；
- `bypass` 额外返回 `bypassReason`，当前为 `manifest-byte-limit`、`manifest-read-race`、`manifest-changed-during-scan` 或 `result-byte-limit`。

前端只能把 `hit` 展示为缓存命中；`miss` 和 `bypass` 都不能表述为复用。

## 安全与非目标

- 缓存值在存入和返回时都进行深拷贝，调用方不能修改共享条目；
- 只缓存 Definition scan JSON，不缓存 Source Viewer 原文、Trace、模型输出、GitHub PR 或凭据；
- 不写磁盘、不创建索引文件、不启动 watcher、不修改目标仓；
- 不跨服务进程共享，不保证跨请求的原子文件系统快照；读取竞态会降级为 miss/bypass；
- V1 不做单文件 AST 增量合并。未来若加入增量索引，必须保持稳定 node id、显式失效和同样的允许根边界。
