# Model Provider V1

Model Provider V1 是 Provider 厂商无关的观测合同。它把模型调用归一化为 Runtime Trace 事件，让同一套时间轴能够查看流式输出、用量、预算与取消。确定性 recording 本身不访问模型 API；首个实时实现由独立的 `openjiuwen.openrouter-provider` 插件提供，浏览器仍不会读取或保存 Provider 凭据。

## 插件边界

`openjiuwen.model-provider` 通过 Graph Kernel 注册两类贡献：

- `modelProviders`：声明 adapter 协议、运行模式、凭据策略和能力；
- `modelRecordings`：声明可确定性加载的归一化事件录制。

默认 recording adapter 为 `openjiuwen.recording-replay`，模式是 `recording-replay`，凭据策略是 `none`。OpenRouter adapter 的模式是 `local-service`、凭据策略是 `local-service-only`；React 组件只读取无凭据注册表并使用 Trace authority 发起调用。

## 结构化事件

Runtime Trace V1 在原有 `model.call` 之外增加：

- `model.stream`：一个完整、未截断的输出 delta；
- `model.usage`：输入、输出、缓存、推理 Token 与可选费用；
- `model.cancel`：显式取消原因。

这些事件必须携带 `model`：

```json
{
  "eventId": "model-delta-2",
  "kind": "model.stream",
  "phase": "instant",
  "timestampMs": 101,
  "spanId": "span-model-1",
  "model": {
    "invocationId": "model-invocation-1",
    "providerId": "provider.openai-compatible",
    "modelId": "reasoner-v1",
    "source": "recording",
    "recordingId": "recording-2026-08-18",
    "recordingSequence": 2,
    "delta": "完整输出增量"
  }
}
```

Prompt 或消息正文不放入 `model`，仍由 Context 事件保存。这样 Provider 元数据和 Context 所有权保持独立，Swarm 内的模型事件也可以绑定明确 `subject`。

## 一致性约束

本机采集服务对每个 Trace 强制以下约束：

1. 同一 `invocationId` 的 `providerId`、`modelId`、`source` 和 `recordingId` 不得变化；
2. `recording` 来源必须带 `recordingId` 与非负 `recordingSequence`；
3. 同一 recording 的帧序号必须按接收顺序严格递增；
4. `model.stream` 必须有 `delta`，`model.usage` 必须有 `usage`，`model.cancel` 必须有 `cancelReason`；
5. 费用使用整数 `costMicros`，避免浮点货币误差；币种由事件显式声明，不做价格推断。

## 投影与回放

`features/model-runtime/model.ts` 按全局 Trace sequence 重建 invocation：

- delta 按事件顺序拼接；
- usage 与 budget 采用当前步骤之前最后一次结构化更新；
- `model.call/end`、error 与 cancel 分别形成完成、失败和取消状态；
- 上一步/下一步只重建当前 sequence 之前的帧，不泄漏未来输出。

运行页在第一次出现结构化模型事件后显示 Model Provider 区域。默认输出经过脱敏和长度压缩，只有点击“完整输出”才显示原始文本；流式内容追加时输出区域自动跟随到底部。展开详情可以查看 invocation、span、subject、结束原因与每个模型事件帧。

“Core Trace → 模型录制”会创建一个新的内存 Trace，并载入 `plugins/model-provider/recordings/stream-and-cancel.ts`。示例包含一段完成调用和一段取消调用，用于验证流、预算、费用、隐私与时间旅行；它不访问外部网络，也不执行 Agent、Tool 或模型。

## 实时 OpenRouter 接入

实时 Provider adapter 在本地服务完成鉴权、固定域名请求、取消和响应归一化，然后只向现有 Trace 写入结构化事件。模型由服务端 allowlist 注册，费用只采用上游 usage，不在页面推断。完整接口、安全上限和配置见 [`openrouter-provider-v1.md`](openrouter-provider-v1.md)。
