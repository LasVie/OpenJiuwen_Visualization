# OpenJiuwen Trace Visualization

面向 `agent-core` 与 `jiuwenswarm` 的确定性运行链路工作台。当前版本聚焦单 Agent：展示 Swarm 请求边界、Agent Core 的 DeepAgent/ReAct 内部链路、Context 累积、Rail/Hook 审查和逐步回放。

## 本地运行

```powershell
npm install
npm run dev
```

完整校验：

```powershell
npm run check
```

## 绑定本地仓库

本地仓读取通过独立的只读服务完成。启动时必须明确给出允许访问的目录；服务只监听 loopback，不导入或执行目标仓代码：

```powershell
python -B services/local-server/scripts/run_server.py `
  --allow-root "C:\Users\soong\Documents\OpenJiuwen_Visualization"
```

只读扫描烟测：

```powershell
python -B services/local-server/scripts/scan_repository.py `
  --allow-root "C:\Users\soong\Documents\OpenJiuwen_Visualization" `
  --path "C:\Users\soong\Documents\OpenJiuwen_Visualization\agent-core" `
  --summary
```

服务默认地址为 `http://127.0.0.1:8765`。进入页面顶部“定义图”后，可直接选择允许根目录下发现的 `agent-core` 或 `jiuwenswarm`，也可输入白名单范围内的仓库/子目录绝对路径。生成后的定义图支持：

- repository → package → module → class/function 的分层浏览与面包屑回退；
- Agent、Rail、Tool、Context、Workflow、Model、Team 语义分类；
- 全局符号/源码路径搜索、类型过滤和大层级分页；
- `contains`、`imports`、`inherits` 关系与源码行证据；
- 节点详情、拖拽、实时防重叠、磁性调节、缩放和缩略图。

页面每次只投影当前焦点和有限数量的子节点，不会把完整仓库的数千节点同时交给 ReactFlow。

## 视觉语义

- 浅青蓝：`agent-core`，负责 Agent 生命周期、ReAct、Context、Model、Tool 和 Rail。
- 浅紫：`jiuwenswarm`，负责请求入口、会话宿主、能力装配和响应出口。
- 暖橙：Rail 当前审查动作、Hook 连接、mutation 或控制信号。

Context 的“消息分段”默认显示脱敏精简摘要，用户可逐条展开完整原文；“连续原文”始终按实际追加顺序展示完整内容，并在新消息进入时自动跟随到底部。

点击任意 Rail 卡片会进入独立决策画布：可逐次切换该 Rail 在整条轨迹里的真实调用帧，并查看 `READ → DISPATCH → CHECK × 3 → APPLY → EMIT` 全过程。

## 代码结构

```text
src/
├─ adapters/                   # 本地服务等外部数据源客户端
├─ components/                 # 页面编排与 ReactFlow 适配组件
├─ kernel/                     # 版本化图协议、插件协议与注册器
├─ domain/
│  ├─ runtime/                 # agent-core / jiuwenswarm 来源语义
│  └─ trace/                   # 通用图到当前 Trace UI 的投影
├─ data/
│  ├─ fixtures/                # 确定性数据构造器
│  └─ scenarios/               # 一个文件一个演示轨迹
├─ features/
│  ├─ context-window/          # 脱敏、原文和展示 Token 模型
│  ├─ rail-review/             # Rail 调用帧、决策画布和证据面板
│  └─ trace-graph/             # 可调磁吸、实时节点避碰与共享画布控件
├─ plugins/                    # Core、Swarm、集成边与轨迹数据贡献者
├─ shared/ui/                  # 无业务状态的通用 UI
├─ state/                      # 回放状态与纯工具函数
├─ types/                      # 兼容导出；稳定合同由 kernel 管理
└─ workbench/                  # 组合默认插件并生成当前工作台快照
services/
└─ local-server/               # 路径白名单、Git 身份与 Python AST 索引
```

扩展约束、数据流和新增场景步骤见 [`docs/architecture.md`](docs/architecture.md)。
