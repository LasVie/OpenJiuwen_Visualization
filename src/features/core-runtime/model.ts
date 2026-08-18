import type {
  CoreRuntimeEvent,
  RuntimeHookObservation,
  RuntimeTraceSession,
  TraceDetail,
  TraceScenario,
  TraceStep,
} from "../../kernel";
import { runtimeMessageToContextMessage } from "../../kernel";

const TRACE_NODE_IDS = new Set([
  "input",
  "output",
  "deep-agent",
  "react-loop",
  "context",
  "model",
  "decision",
  "tool",
  "rail-init",
  "rail-safety",
  "rail-context",
  "rail-retry",
  "rail-trajectory",
  "rail-compression",
  "rail-tool",
]);

const TRACE_EDGE_IDS = new Set([
  "e-input-deep",
  "e-deep-context",
  "e-context-model",
  "e-model-decision",
  "e-decision-tool",
  "e-tool-context",
  "e-decision-output",
  "e-rail-init-deep",
  "e-rail-safety-input",
  "e-rail-context-context",
  "e-rail-retry-model",
  "e-rail-trajectory-decision",
  "e-rail-compression-context",
  "e-rail-tool-tool",
]);

const CALLBACK_RAIL: Record<string, string> = {
  before_invoke: "rail-init",
  after_invoke: "rail-trajectory",
  on_user_message: "rail-safety",
  before_model_call: "rail-context",
  after_model_call: "rail-context",
  on_model_exception: "rail-retry",
  before_tool_call: "rail-tool",
  after_tool_call: "rail-tool",
  on_tool_exception: "rail-tool",
  after_react_iteration: "rail-trajectory",
};

const CALLBACK_TARGET: Record<string, string> = {
  before_invoke: "deep-agent",
  after_invoke: "deep-agent",
  on_user_message: "input",
  before_model_call: "context",
  after_model_call: "model",
  on_model_exception: "model",
  before_tool_call: "tool",
  after_tool_call: "tool",
  on_tool_exception: "tool",
  after_react_iteration: "decision",
};

const EVENT_PRESENTATION: Record<
  CoreRuntimeEvent["kind"],
  { phase: string; title: string; summary: string }
> = {
  "agent.invoke": {
    phase: "Lifecycle",
    title: "Agent invoke",
    summary: "进入或离开 DeepAgent invoke 生命周期。",
  },
  "agent.user_message": {
    phase: "Ingress",
    title: "接收用户消息",
    summary: "消息在写入 ModelContext 前经过输入回调。",
  },
  "agent.task_iteration": {
    phase: "Task",
    title: "任务迭代",
    summary: "DeepAgent 外层任务循环推进了一次。",
  },
  "agent.react_iteration": {
    phase: "ReAct",
    title: "ReAct 迭代",
    summary: "模型、工具与 observation 组成的一轮 ReAct 边界。",
  },
  "model.call": {
    phase: "Model",
    title: "模型调用",
    summary: "最终 ContextWindow 被发送给模型并接收响应。",
  },
  "tool.call": {
    phase: "Tool",
    title: "工具调用",
    summary: "AbilityManager 执行工具并回填 ToolMessage。",
  },
  "rail.chain": {
    phase: "Rail",
    title: "Rail callback chain",
    summary: "框架确认一次 callback 链边界；不推断链内单个 Rail 的决策。",
  },
  "rail.hook": {
    phase: "Rail",
    title: "Rail hook",
    summary: "显式探针记录单个 Rail 的输入、变更与控制信号。",
  },
  "context.snapshot": {
    phase: "Context",
    title: "ContextWindow 快照",
    summary: "记录本次实际送入模型的完整消息窗口。",
  },
  "context.delta": {
    phase: "Context",
    title: "Context 增量",
    summary: "ModelContext 追加、替换或移除了消息。",
  },
  "ability.register": {
    phase: "Registry",
    title: "Ability 注册",
    summary: "工具或能力进入当前 Agent 的可调用注册表。",
  },
  "trace.status": {
    phase: "Trace",
    title: "Trace 状态",
    summary: "运行时采集会话状态发生变化。",
  },
};

function payloadString(event: CoreRuntimeEvent, key: string) {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function callbackName(event: CoreRuntimeEvent) {
  return event.hook?.callback.toLowerCase() ?? payloadString(event, "callback")?.toLowerCase();
}

function inferredNodeIds(event: CoreRuntimeEvent) {
  if (event.activeNodeIds?.length) {
    return event.activeNodeIds.filter((id) => TRACE_NODE_IDS.has(id));
  }
  const callback = callbackName(event);
  if (event.kind === "rail.chain") {
    const targetId = callback ? CALLBACK_TARGET[callback] : undefined;
    return targetId && TRACE_NODE_IDS.has(targetId) ? [targetId] : [];
  }
  if (event.kind === "rail.hook") {
    if (!event.hook?.exact) {
      const targetId = callback ? CALLBACK_TARGET[callback] : undefined;
      return targetId && TRACE_NODE_IDS.has(targetId) ? [targetId] : [];
    }
    const railId = event.hook?.railNodeId ?? (callback ? CALLBACK_RAIL[callback] : undefined);
    const targetId = callback ? CALLBACK_TARGET[callback] : undefined;
    return [railId, targetId].filter(
      (id): id is string => Boolean(id && TRACE_NODE_IDS.has(id)),
    );
  }
  switch (event.kind) {
    case "agent.invoke":
      return event.phase === "end" ? ["deep-agent", "output"] : ["input", "deep-agent"];
    case "agent.user_message":
      return ["input"];
    case "agent.task_iteration":
      return ["deep-agent"];
    case "agent.react_iteration":
      return ["react-loop", "decision"];
    case "model.call":
      return event.phase === "start" ? ["context", "model"] : ["model", "decision"];
    case "tool.call":
      return event.phase === "end" ? ["tool", "context"] : ["decision", "tool"];
    case "context.snapshot":
    case "context.delta":
      return ["context"];
    case "ability.register":
      return ["tool"];
    case "trace.status":
      return event.phase === "end" ? ["output"] : ["deep-agent"];
    default:
      return [];
  }
}

function inferredEdgeIds(event: CoreRuntimeEvent) {
  if (event.activeEdgeIds?.length) {
    return event.activeEdgeIds.filter((id) => TRACE_EDGE_IDS.has(id));
  }
  const callback = callbackName(event);
  if (event.kind === "rail.chain") return [];
  if (event.kind === "rail.hook") {
    if (!event.hook?.exact) return [];
    const railId = event.hook?.railNodeId ?? (callback ? CALLBACK_RAIL[callback] : undefined);
    const edgeByRail: Record<string, string> = {
      "rail-init": "e-rail-init-deep",
      "rail-safety": "e-rail-safety-input",
      "rail-context": "e-rail-context-context",
      "rail-retry": "e-rail-retry-model",
      "rail-trajectory": "e-rail-trajectory-decision",
      "rail-compression": "e-rail-compression-context",
      "rail-tool": "e-rail-tool-tool",
    };
    return railId && edgeByRail[railId] ? [edgeByRail[railId]] : [];
  }
  switch (event.kind) {
    case "agent.invoke":
      return event.phase === "end" ? ["e-decision-output"] : ["e-input-deep"];
    case "model.call":
      return event.phase === "start" ? ["e-context-model"] : ["e-model-decision"];
    case "tool.call":
      return event.phase === "end" ? ["e-tool-context"] : ["e-decision-tool"];
    default:
      return [];
  }
}

function hookInvocation(event: CoreRuntimeEvent, hook: RuntimeHookObservation) {
  return {
    id: `${event.traceId}:${event.sequence}:hook`,
    rail: hook.rail,
    event: hook.callback,
    priority: hook.priority,
    namespace: hook.namespace,
    durationMs: hook.durationMs,
    mutationDiff: hook.mutationDiff,
    controlSignal: hook.controlSignal,
    noop: hook.noop,
  };
}

function applyContextDelta(
  messages: TraceScenario["messages"],
  event: CoreRuntimeEvent,
  stepIndex: number,
) {
  const delta = event.context;
  if (!delta) return;
  const removalIds = new Set(delta.removeMessageIds ?? []);
  if (delta.operation === "replace" && removalIds.size === 0) {
    messages.forEach((message) => {
      if (message.removedAt === undefined) message.removedAt = stepIndex;
    });
  } else if (removalIds.size) {
    messages.forEach((message) => {
      if (removalIds.has(message.id) && message.removedAt === undefined) {
        message.removedAt = stepIndex;
      }
    });
  }
  (delta.messages ?? []).forEach((runtimeMessage) => {
    const previous = [...messages].reverse().find(
      (message) => message.id === runtimeMessage.id && message.removedAt === undefined,
    );
    if (previous) previous.removedAt = stepIndex;
    messages.push(runtimeMessageToContextMessage(runtimeMessage, stepIndex));
  });
}

function runtimeDetails(event: CoreRuntimeEvent): TraceDetail[] {
  return [
    { label: "trace", value: event.traceId },
    { label: "span", value: event.spanId },
    { label: "phase", value: event.phase },
    ...(event.iteration === undefined
      ? []
      : [{ label: "iteration", value: String(event.iteration) }]),
    ...(event.definition
      ? [{ label: "source", value: `${event.definition.path}${event.definition.symbol ? `:${event.definition.symbol}` : ""}` }]
      : []),
    ...(event.hook
      ? [{ label: "rail evidence", value: event.hook.exact ? "instrumented exact" : "callback boundary" }]
      : []),
    ...(event.details ?? []),
  ];
}

export function emptyRuntimeScenario(
  trace?: RuntimeTraceSession,
): TraceScenario {
  const traceId = trace?.id ?? "pending";
  return {
    id: `runtime:${traceId}`,
    name: trace?.label ?? "Core Runtime",
    shortName: "Live trace",
    description: trace
      ? "采集器已就绪，等待 agent-core 事件；服务不会执行 Agent 或模型。"
      : "创建本机内存 Trace 会话后，运行事件会按到达顺序进入链路。",
    defaultInput: "",
    railNodeIds: [],
    maxTokens: trace?.maxTokens ?? 8192,
    messages: [],
    provenance: {
      kind: "runtime",
      owner: "agent-core",
      traceId: trace?.id,
      status: trace?.status ?? "open",
    },
    steps: [
      {
        id: `runtime:${traceId}:waiting`,
        phase: "Trace",
        title: trace ? "等待 Runtime 事件" : "尚未创建 Trace 会话",
        eventCode: "trace.waiting",
        summary: trace
          ? "SSE 已连接时，新事件会自动追加；回退到历史步骤后不会抢占当前位置。"
          : "切换到 Core Runtime 后创建一个只存在于内存中的监听会话。",
        timestampMs: 0,
        durationMs: 0,
        activeNodeIds: ["input"],
        activeEdgeIds: [],
        tokenUsed: 0,
        tokenDelta: 0,
        toolTokens: 0,
        hooks: [],
        details: [],
      },
    ],
  };
}

export function projectCoreRuntimeTrace(
  trace: RuntimeTraceSession,
  events: readonly CoreRuntimeEvent[],
): TraceScenario {
  if (events.length === 0) return emptyRuntimeScenario(trace);

  const messages: TraceScenario["messages"] = [];
  const railNodeIds = new Set<string>();
  let tokenUsed = 0;
  let maxTokens = trace.maxTokens;

  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const steps: TraceStep[] = orderedEvents.map((event, stepIndex) => {
    applyContextDelta(messages, event, stepIndex);
    const previousTokenUsed = tokenUsed;
    if (event.token) {
      tokenUsed = event.token.used;
      maxTokens = event.token.budget ?? maxTokens;
    }
    const activeNodeIds = inferredNodeIds(event);
    activeNodeIds.filter((id) => id.startsWith("rail-")).forEach((id) => railNodeIds.add(id));
    const presentation = EVENT_PRESENTATION[event.kind];
    const callback = callbackName(event);
    const eventCode = callback ?? event.kind;

    return {
      id: `${trace.id}:${event.sequence}`,
      phase: presentation.phase,
      title: event.title ?? `${presentation.title} · ${event.phase}`,
      eventCode,
      summary: event.summary ?? presentation.summary,
      timestampMs: event.timestampMs,
      durationMs: event.durationMs ?? 0,
      activeNodeIds,
      activeEdgeIds: inferredEdgeIds(event),
      tokenUsed,
      tokenDelta: event.token?.delta ?? tokenUsed - previousTokenUsed,
      toolTokens: event.token?.tool ?? 0,
      hooks: event.hook?.exact ? [hookInvocation(event, event.hook)] : [],
      details: runtimeDetails(event),
    };
  });

  return {
    id: `runtime:${trace.id}`,
    name: trace.label,
    shortName: "Live trace",
    description: "来自本机内存采集器的 agent-core 事件；单个 Rail 决策仅在显式探针提供时标记为精确。",
    defaultInput: "",
    railNodeIds: [...railNodeIds],
    maxTokens,
    messages,
    steps,
    provenance: {
      kind: "runtime",
      owner: trace.owner,
      traceId: trace.id,
      status: trace.status,
    },
  };
}
