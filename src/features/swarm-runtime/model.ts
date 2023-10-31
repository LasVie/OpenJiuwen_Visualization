import type {
  ContextMessage,
  RuntimeSubjectKind,
  RuntimeTraceEvent,
  RuntimeTraceSession,
  TraceDetail,
  TraceScenario,
  TraceStep,
} from "../../kernel";
import { runtimeMessageToContextMessage } from "../../kernel";

export type SwarmSubjectStatus =
  | "planned"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "observed";

export interface SwarmSubjectRevision {
  stepIndex: number;
  eventId: string;
  eventKind: RuntimeTraceEvent["kind"];
  phase: RuntimeTraceEvent["phase"];
  status: SwarmSubjectStatus;
  title: string;
  summary: string;
}

export interface SwarmRuntimeSubject {
  id: string;
  kind: RuntimeSubjectKind;
  label: string;
  parentId?: string;
  role?: string;
  contextOwnerId?: string;
  firstStep: number;
  lastStep: number;
  eventCount: number;
  sourceLocation?: string;
  sourceConfidence: "exact" | "inferred" | "unavailable";
  revisions: SwarmSubjectRevision[];
}

export type SwarmRelationKind = "hierarchy" | "message" | "assignment";

export interface SwarmRuntimeRelation {
  id: string;
  source: string;
  target: string;
  kind: SwarmRelationKind;
  label?: string;
  firstStep: number;
  lastStep: number;
  count: number;
}

export interface SwarmContextScope {
  id: string;
  label: string;
  kind: RuntimeSubjectKind | "unresolved";
  subjectId?: string;
  messageCount: number;
  tokenUsed: number;
  messages: readonly ContextMessage[];
  tokenRevisions: readonly { stepIndex: number; used: number }[];
}

export interface SwarmRuntimeProjection {
  trace: RuntimeTraceSession | null;
  scenario: TraceScenario;
  subjects: SwarmRuntimeSubject[];
  relations: SwarmRuntimeRelation[];
  contextScopes: SwarmContextScope[];
  activeContextOwnerId: string | null;
  events: RuntimeTraceEvent[];
}

const SUBJECT_SOURCE: Partial<Record<RuntimeTraceEvent["kind"], string>> = {
  "swarm.team": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
  "swarm.member": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
  "swarm.task": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
  "swarm.message": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
  "swarm.workflow": "jiuwenswarm/agents/harness/team/handlers/workflow_monitor_handler.py",
  "swarm.phase": "jiuwenswarm/agents/harness/team/handlers/workflow_state.py",
  "swarm.agent": "jiuwenswarm/agents/harness/team/handlers/workflow_state.py",
  "swarm.human": "jiuwenswarm/agents/harness/team/handlers/workflow_state.py",
  "swarm.subagent": "jiuwenswarm/agents/harness/agent_observability.py",
};

const EVENT_PRESENTATION: Record<
  RuntimeTraceEvent["kind"],
  { phase: string; title: string; summary: string }
> = {
  "swarm.team": {
    phase: "Team",
    title: "Team lifecycle",
    summary: "团队运行时建立、更新或结束。",
  },
  "swarm.member": {
    phase: "Member",
    title: "成员状态",
    summary: "成员被创建、唤醒、执行、重启或关闭。",
  },
  "swarm.task": {
    phase: "Task",
    title: "任务状态",
    summary: "团队任务被创建、分配、执行、审查或完成。",
  },
  "swarm.message": {
    phase: "Message",
    title: "成员消息",
    summary: "成员间点对点消息或广播被观测。",
  },
  "swarm.workflow": {
    phase: "Workflow",
    title: "SwarmFlow workflow",
    summary: "一个 workflow run 的状态发生变化。",
  },
  "swarm.phase": {
    phase: "Workflow",
    title: "Workflow phase",
    summary: "Workflow 的 author phase 或 child phase 推进。",
  },
  "swarm.agent": {
    phase: "Agent",
    title: "Workflow agent",
    summary: "Workflow 内 Agent 节点开始、完成或失败。",
  },
  "swarm.human": {
    phase: "Human",
    title: "Human node",
    summary: "Workflow 内 Human 节点等待或接收回复。",
  },
  "swarm.subagent": {
    phase: "Subagent",
    title: "Subagent lifecycle",
    summary: "独立 Subagent 被创建、执行或结束；上下文不与父 Agent 混合。",
  },
  "agent.invoke": {
    phase: "Agent Core",
    title: "成员 Agent invoke",
    summary: "Swarm 主体内部的 Agent Core 生命周期事件。",
  },
  "agent.user_message": {
    phase: "Agent Core",
    title: "成员接收消息",
    summary: "消息进入指定成员或 Agent 的 Context。",
  },
  "agent.task_iteration": {
    phase: "Agent Core",
    title: "成员任务迭代",
    summary: "指定执行主体推进了一次外层任务循环。",
  },
  "agent.react_iteration": {
    phase: "Agent Core",
    title: "成员 ReAct 迭代",
    summary: "指定执行主体推进了一次 ReAct 循环。",
  },
  "model.call": {
    phase: "Model",
    title: "成员模型调用",
    summary: "指定执行主体调用模型。",
  },
  "model.stream": {
    phase: "Model stream",
    title: "成员模型输出增量",
    summary: "指定执行主体接收一个结构化模型流增量。",
  },
  "model.usage": {
    phase: "Model usage",
    title: "成员模型用量",
    summary: "指定执行主体收到 Provider 用量或费用更新。",
  },
  "model.cancel": {
    phase: "Model cancel",
    title: "成员模型调用取消",
    summary: "指定执行主体的模型调用被显式取消。",
  },
  "tool.call": {
    phase: "Tool",
    title: "成员工具调用",
    summary: "指定执行主体调用工具并接收 observation。",
  },
  "rail.chain": {
    phase: "Rail",
    title: "成员 Rail chain",
    summary: "仅确认指定执行主体的 callback 链边界。",
  },
  "rail.hook": {
    phase: "Rail",
    title: "成员 Rail hook",
    summary: "显式探针记录指定执行主体的单个 Rail 决策。",
  },
  "context.snapshot": {
    phase: "Context",
    title: "主体 Context 快照",
    summary: "记录一个明确 Context owner 的完整窗口。",
  },
  "context.delta": {
    phase: "Context",
    title: "主体 Context 增量",
    summary: "向一个明确 Context owner 追加、替换或移除消息。",
  },
  "ability.register": {
    phase: "Registry",
    title: "成员能力注册",
    summary: "工具或能力注册到指定执行主体。",
  },
  "trace.status": {
    phase: "Trace",
    title: "Swarm Trace 状态",
    summary: "本机 Trace 采集会话状态发生变化。",
  },
};

const KIND_ORDER: Record<RuntimeSubjectKind, number> = {
  team: 0,
  workflow: 1,
  member: 2,
  phase: 3,
  task: 4,
  agent: 5,
  human: 6,
  subagent: 7,
};

function payloadString(event: RuntimeTraceEvent, key: string) {
  const value = event.payload?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function subjectStatus(event: RuntimeTraceEvent): SwarmSubjectStatus {
  const explicit = payloadString(event, "status")?.toLowerCase();
  if (explicit) {
    if (["waiting", "waiting_for_human", "planning", "in_review"].includes(explicit)) {
      return "waiting";
    }
    if (["complete", "completed", "verified", "success"].includes(explicit)) {
      return "completed";
    }
    if (["failed", "error"].includes(explicit)) {
      return "failed";
    }
    if (["cancelled", "canceled", "stopped", "shutdown"].includes(explicit)) {
      return "stopped";
    }
    if (["planned", "pending"].includes(explicit)) return "planned";
    if (["running", "active", "in_progress", "executing"].includes(explicit)) {
      return "running";
    }
  }
  if (event.phase === "error") return "failed";
  if (event.phase === "end") return "completed";
  if (event.phase === "start") return "running";
  return "observed";
}

function sourceFor(event: RuntimeTraceEvent) {
  if (event.definition) {
    const suffix = event.definition.symbol ? `:${event.definition.symbol}` : "";
    return {
      location: `${event.definition.repository}/${event.definition.path}${suffix}`,
      confidence: "exact" as const,
    };
  }
  const inferred = SUBJECT_SOURCE[event.kind];
  return inferred
    ? { location: inferred, confidence: "inferred" as const }
    : { location: undefined, confidence: "unavailable" as const };
}

function upsertRelation(
  relations: Map<string, SwarmRuntimeRelation>,
  input: Omit<SwarmRuntimeRelation, "count" | "lastStep">,
  stepIndex: number,
) {
  const existing = relations.get(input.id);
  if (existing) {
    existing.lastStep = stepIndex;
    existing.count += 1;
    if (input.label) existing.label = input.label;
    return;
  }
  relations.set(input.id, { ...input, lastStep: stepIndex, count: 1 });
}

function applyContextDelta(
  messages: ContextMessage[],
  event: RuntimeTraceEvent,
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

function runtimeDetails(event: RuntimeTraceEvent): TraceDetail[] {
  const subject = event.subject;
  const payloadDetails = [
    "teamId",
    "runId",
    "taskId",
    "correlationId",
    "fromSubjectId",
    "toSubjectId",
    "assigneeId",
    "status",
    "nodeType",
  ].flatMap((key) => {
    const value = payloadString(event, key);
    return value ? [{ label: key, value }] : [];
  });
  return [
    { label: "trace", value: event.traceId },
    { label: "span", value: event.spanId },
    { label: "phase", value: event.phase },
    ...(subject ? [{ label: "subject", value: `${subject.kind}:${subject.id}` }] : []),
    ...(event.context?.ownerId
      ? [{ label: "context owner", value: event.context.ownerId }]
      : []),
    ...(event.definition
      ? [{ label: "source evidence", value: "instrumented exact" }]
      : []),
    ...(event.model
      ? [
          { label: "provider", value: event.model.providerId },
          { label: "model", value: event.model.modelId },
          { label: "invocation", value: event.model.invocationId },
          { label: "model source", value: event.model.source },
        ]
      : []),
    ...(event.environment
      ? [
          { label: "environment", value: event.environment.id },
          { label: "environment fingerprint", value: event.environment.fingerprint },
          { label: "python", value: event.environment.pythonVersion },
          { label: "uv", value: event.environment.uvVersion },
          ...(event.environment.project.revision
            ? [{ label: `${event.environment.project.slot} revision`, value: event.environment.project.revision }]
            : []),
          ...(event.environment.coreDependency?.revision
            ? [{ label: "Core dependency", value: event.environment.coreDependency.revision }]
            : []),
        ]
      : []),
    ...payloadDetails,
    ...(event.details ?? []),
  ];
}

function waitingStep(trace?: RuntimeTraceSession): TraceStep {
  const traceId = trace?.id ?? "pending";
  return {
    id: `swarm-runtime:${traceId}:waiting`,
    phase: "Trace",
    title: trace ? "等待 Swarm Runtime 事件" : "尚未创建 Swarm Trace 会话",
    eventCode: "trace.waiting",
    summary: trace
      ? "Team、Workflow、Agent 与 Subagent 事件会按到达顺序进入层级画布。"
      : "创建只存在于本机内存中的 jiuwenswarm 监听会话。",
    timestampMs: 0,
    durationMs: 0,
    activeNodeIds: [],
    activeEdgeIds: [],
    tokenUsed: 0,
    tokenDelta: 0,
    toolTokens: 0,
    hooks: [],
    details: [],
  };
}

export function emptySwarmRuntimeProjection(
  trace?: RuntimeTraceSession,
): SwarmRuntimeProjection {
  const traceId = trace?.id ?? "pending";
  return {
    trace: trace ?? null,
    subjects: [],
    relations: [],
    contextScopes: [],
    activeContextOwnerId: null,
    events: [],
    scenario: {
      id: `swarm-runtime:${traceId}`,
      name: trace?.label ?? "Swarm Runtime",
      shortName: "Swarm trace",
      description: trace
        ? "Trace 已就绪，可接收外部事件，也可由 Agent Team 执行模块启动受控的真实 JiuwenSwarm 团队。"
        : "创建本机内存 Trace 会话后，Swarm 层级与各主体 Context 会实时投影。",
      defaultInput: "",
      railNodeIds: [],
      maxTokens: trace?.maxTokens ?? 32768,
      messages: [],
      steps: [waitingStep(trace)],
      provenance: {
        kind: "runtime",
        owner: "jiuwenswarm",
        traceId: trace?.id,
        status: trace?.status ?? "open",
      },
    },
  };
}

export function projectSwarmRuntimeTrace(
  trace: RuntimeTraceSession,
  sourceEvents: readonly RuntimeTraceEvent[],
  requestedContextOwnerId?: string | null,
): SwarmRuntimeProjection {
  if (sourceEvents.length === 0) return emptySwarmRuntimeProjection(trace);

  const events = [...sourceEvents].sort((left, right) => left.sequence - right.sequence);
  const subjects = new Map<string, SwarmRuntimeSubject>();
  const relations = new Map<string, SwarmRuntimeRelation>();
  const messagesByOwner = new Map<string, ContextMessage[]>();
  const contextOwnerIds = new Set<string>();
  const latestTokenByOwner = new Map<string, number>();
  const tokenRevisionsByOwner = new Map<string, { stepIndex: number; used: number }[]>();

  events.forEach((event, stepIndex) => {
    const reference = event.subject;
    if (reference) {
      const presentation = EVENT_PRESENTATION[event.kind];
      const revision: SwarmSubjectRevision = {
        stepIndex,
        eventId: event.eventId,
        eventKind: event.kind,
        phase: event.phase,
        status: subjectStatus(event),
        title: event.title ?? presentation.title,
        summary: event.summary ?? presentation.summary,
      };
      const existing = subjects.get(reference.id);
      if (existing) {
        existing.label = reference.label;
        existing.parentId = existing.parentId ?? reference.parentId;
        existing.role = reference.role ?? existing.role;
        existing.contextOwnerId = reference.contextOwnerId ?? existing.contextOwnerId;
        existing.lastStep = stepIndex;
        existing.eventCount += 1;
        existing.revisions.push(revision);
        if (event.definition) {
          const source = sourceFor(event);
          existing.sourceLocation = source.location;
          existing.sourceConfidence = source.confidence;
        }
      } else {
        const source = sourceFor(event);
        subjects.set(reference.id, {
          ...reference,
          firstStep: stepIndex,
          lastStep: stepIndex,
          eventCount: 1,
          sourceLocation: source.location,
          sourceConfidence: source.confidence,
          revisions: [revision],
        });
      }

      if (reference.parentId) {
        upsertRelation(relations, {
          id: `hierarchy:${reference.parentId}:${reference.id}`,
          source: reference.parentId,
          target: reference.id,
          kind: "hierarchy",
          firstStep: stepIndex,
        }, stepIndex);
      }
      if (reference.contextOwnerId) contextOwnerIds.add(reference.contextOwnerId);
    }

    const fromSubjectId = payloadString(event, "fromSubjectId");
    const toSubjectId = payloadString(event, "toSubjectId");
    if (fromSubjectId && toSubjectId) {
      upsertRelation(relations, {
        id: `message:${fromSubjectId}:${toSubjectId}`,
        source: fromSubjectId,
        target: toSubjectId,
        kind: "message",
        label: payloadString(event, "protocol") ?? "message",
        firstStep: stepIndex,
      }, stepIndex);
    }

    const assigneeId = payloadString(event, "assigneeId");
    if (reference?.kind === "task" && assigneeId) {
      upsertRelation(relations, {
        id: `assignment:${assigneeId}:${reference.id}`,
        source: assigneeId,
        target: reference.id,
        kind: "assignment",
        label: "assigned",
        firstStep: stepIndex,
      }, stepIndex);
    }

    const contextOwnerId = event.context?.ownerId;
    if (contextOwnerId) {
      contextOwnerIds.add(contextOwnerId);
      const messages = messagesByOwner.get(contextOwnerId) ?? [];
      applyContextDelta(messages, event, stepIndex);
      messagesByOwner.set(contextOwnerId, messages);
    }
    const tokenOwnerId = contextOwnerId ?? reference?.contextOwnerId ?? reference?.id;
    if (event.token && tokenOwnerId) {
      latestTokenByOwner.set(tokenOwnerId, event.token.used);
      const revisions = tokenRevisionsByOwner.get(tokenOwnerId) ?? [];
      revisions.push({ stepIndex, used: event.token.used });
      tokenRevisionsByOwner.set(tokenOwnerId, revisions);
    }
  });

  const subjectList = [...subjects.values()].sort(
    (left, right) => left.firstStep - right.firstStep ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.label.localeCompare(right.label),
  );
  const contextScopes = [...contextOwnerIds].map((ownerId): SwarmContextScope => {
    const direct = subjects.get(ownerId);
    const proxy = subjectList.find((subject) => subject.contextOwnerId === ownerId);
    const subject = direct ?? proxy;
    return {
      id: ownerId,
      label: subject?.label ?? ownerId,
      kind: subject?.kind ?? "unresolved",
      subjectId: subject?.id,
      messageCount: messagesByOwner.get(ownerId)?.filter(
        (message) => message.removedAt === undefined,
      ).length ?? 0,
      tokenUsed: latestTokenByOwner.get(ownerId) ?? 0,
      messages: messagesByOwner.get(ownerId) ?? [],
      tokenRevisions: tokenRevisionsByOwner.get(ownerId) ?? [],
    };
  }).sort((left, right) => {
    const leftOrder = left.kind === "unresolved" ? 99 : KIND_ORDER[left.kind];
    const rightOrder = right.kind === "unresolved" ? 99 : KIND_ORDER[right.kind];
    const leftSubject = subjects.get(left.id) ??
      subjectList.find((subject) => subject.contextOwnerId === left.id);
    const rightSubject = subjects.get(right.id) ??
      subjectList.find((subject) => subject.contextOwnerId === right.id);
    return leftOrder - rightOrder ||
      (leftSubject?.firstStep ?? Number.MAX_SAFE_INTEGER) -
        (rightSubject?.firstStep ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label);
  });

  const requestedIsAvailable = requestedContextOwnerId &&
    contextScopes.some((scope) => scope.id === requestedContextOwnerId);
  const activeContextOwnerId = requestedIsAvailable
    ? requestedContextOwnerId
    : contextScopes[0]?.id ?? null;

  let tokenUsed = 0;
  let maxTokens = trace.maxTokens;
  const steps: TraceStep[] = events.map((event) => {
    const presentation = EVENT_PRESENTATION[event.kind];
    const contextOwnerId = event.context?.ownerId;
    const eventTokenOwner = contextOwnerId ?? event.subject?.contextOwnerId ?? event.subject?.id;
    const previousTokenUsed = tokenUsed;
    if (event.token && (!activeContextOwnerId || eventTokenOwner === activeContextOwnerId)) {
      tokenUsed = event.token.used;
      maxTokens = event.token.budget ?? maxTokens;
    }
    const subjectId = event.subject?.id;
    const parentId = event.subject?.parentId;
    const hierarchyEdgeId = parentId && subjectId
      ? `hierarchy:${parentId}:${subjectId}`
      : undefined;
    const fromSubjectId = payloadString(event, "fromSubjectId");
    const toSubjectId = payloadString(event, "toSubjectId");
    const messageEdgeId = fromSubjectId && toSubjectId
      ? `message:${fromSubjectId}:${toSubjectId}`
      : undefined;
    const assigneeId = payloadString(event, "assigneeId");
    const assignmentEdgeId = assigneeId && event.subject?.kind === "task"
      ? `assignment:${assigneeId}:${event.subject.id}`
      : undefined;

    return {
      id: `${trace.id}:${event.sequence}`,
      phase: presentation.phase,
      title: event.title ?? `${presentation.title} · ${event.phase}`,
      eventCode: event.kind,
      summary: event.summary ?? presentation.summary,
      timestampMs: event.timestampMs,
      durationMs: event.durationMs ?? 0,
      activeNodeIds: subjectId ? [subjectId] : [],
      activeEdgeIds: [hierarchyEdgeId, messageEdgeId, assignmentEdgeId].filter(
        (id): id is string => Boolean(id),
      ),
      tokenUsed,
      tokenDelta:
        event.token && (!activeContextOwnerId || eventTokenOwner === activeContextOwnerId)
          ? event.token.delta ?? tokenUsed - previousTokenUsed
          : 0,
      toolTokens:
        event.token && (!activeContextOwnerId || eventTokenOwner === activeContextOwnerId)
          ? event.token.tool ?? 0
          : 0,
      hooks: [],
      details: runtimeDetails(event),
    };
  });

  return {
    trace,
    subjects: subjectList,
    relations: [...relations.values()],
    contextScopes,
    activeContextOwnerId,
    events,
    scenario: {
      id: `swarm-runtime:${trace.id}:${activeContextOwnerId ?? "no-context"}`,
      name: trace.label,
      shortName: "Swarm trace",
      description: activeContextOwnerId
        ? `实时 Swarm 层级；Context Window 当前只显示 ${contextScopes.find((scope) => scope.id === activeContextOwnerId)?.label ?? activeContextOwnerId} 的独立上下文。`
        : "实时 Swarm 层级；等待带 context.ownerId 的事件后启用独立 Context 视图。",
      defaultInput: "",
      railNodeIds: [],
      maxTokens,
      messages: activeContextOwnerId
        ? messagesByOwner.get(activeContextOwnerId) ?? []
        : [],
      steps,
      provenance: {
        kind: "runtime",
        owner: "jiuwenswarm",
        traceId: trace.id,
        status: trace.status,
      },
    },
  };
}

export function swarmSubjectStatusAt(
  subject: SwarmRuntimeSubject,
  stepIndex: number,
): SwarmSubjectStatus {
  const revision = [...subject.revisions].reverse().find(
    (candidate) => candidate.stepIndex <= stepIndex,
  );
  return revision?.status ?? "planned";
}

export function swarmContextScopeAt(
  scope: SwarmContextScope,
  stepIndex: number,
) {
  const messageCount = scope.messages.filter((message) =>
    message.addedAt <= stepIndex &&
    (message.removedAt === undefined || message.removedAt > stepIndex)).length;
  const tokenUsed = [...scope.tokenRevisions].reverse().find(
    (revision) => revision.stepIndex <= stepIndex,
  )?.used ?? 0;
  return { messageCount, tokenUsed };
}

export function swarmSubjectIsContainer(kind: RuntimeSubjectKind) {
  return ["team", "workflow", "phase", "member", "agent"].includes(kind);
}
