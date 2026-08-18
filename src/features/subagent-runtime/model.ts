import type {
  RuntimeSubagentObservation,
  RuntimeTraceEvent,
  RuntimeTraceEventKind,
} from "../../kernel";

export type SubagentExecutionStatus =
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "observed";

export type SubagentStageKind =
  | "dispatch"
  | "session"
  | "agent"
  | "context"
  | "rail"
  | "model"
  | "tool"
  | "ability"
  | "result";

export interface SubagentStageDetail {
  label: string;
  value: string;
}
export interface SubagentExecutionStage {
  id: string;
  kind: SubagentStageKind;
  label: string;
  summary: string;
  status: SubagentExecutionStatus;
  firstSequence: number;
  lastSequence: number;
  spanId: string;
  parentSpanId?: string;
  eventKinds: readonly RuntimeTraceEventKind[];
  eventIds: readonly string[];
  details: readonly SubagentStageDetail[];
  sourceLocation?: string;
}

export interface SubagentExecution {
  id: string;
  invocationId: string;
  subjectId: string;
  label: string;
  parentSubjectId?: string;
  parentLabel?: string;
  observation: RuntimeSubagentObservation;
  status: SubagentExecutionStatus;
  startSequence: number;
  endSequence?: number;
  stages: readonly SubagentExecutionStage[];
  eventCount: number;
  contextMessageCount: number;
  tokenUsed: number;
}

function payloadText(event: RuntimeTraceEvent, key: string) {
  const value = event.payload?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function sourceLocation(event: RuntimeTraceEvent) {
  const definition = event.definition;
  if (!definition) return undefined;
  const symbol = definition.symbol ? `:${definition.symbol}` : "";
  const line = definition.startLine ? `:${definition.startLine}` : "";
  return `${definition.repository}/${definition.path}${symbol}${line}`;
}

function phaseStatus(event: RuntimeTraceEvent): SubagentExecutionStatus {
  if (event.phase === "error") return "failed";
  if (event.phase === "end") return "completed";
  if (event.phase === "start") return "running";
  return "observed";
}

function latestStatus(events: readonly RuntimeTraceEvent[]) {
  if (events.some((event) => event.phase === "error")) return "failed";
  if (events.some((event) => event.phase === "end")) return "completed";
  if (events.some((event) => event.phase === "start")) return "running";
  return "observed";
}

function eventDetails(event: RuntimeTraceEvent): SubagentStageDetail[] {
  const details: SubagentStageDetail[] = [
    { label: "event", value: event.kind },
    { label: "phase", value: event.phase },
    { label: "span", value: event.spanId },
    { label: "sequence", value: String(event.sequence) },
  ];
  if (event.durationMs !== undefined) {
    details.push({ label: "duration", value: `${event.durationMs} ms` });
  }
  if (event.context?.ownerId) {
    details.push({ label: "context owner", value: event.context.ownerId });
    details.push({
      label: "context operation",
      value: `${event.context.operation} · ${event.context.messages?.length ?? 0} messages`,
    });
  }
  if (event.model) {
    details.push({ label: "model", value: `${event.model.providerId} / ${event.model.modelId}` });
    details.push({ label: "invocation", value: event.model.invocationId });
    if (event.model.usage) {
      details.push({
        label: "usage",
        value: `${event.model.usage.inputTokens} in · ${event.model.usage.outputTokens} out`,
      });
    }
  }
  if (event.hook) {
    details.push({ label: "rail", value: event.hook.rail });
    details.push({ label: "callback", value: `${event.hook.callback} · p${event.hook.priority}` });
    details.push({ label: "control", value: event.hook.controlSignal });
  }
  const toolName = payloadText(event, "toolName");
  if (toolName) details.push({ label: "tool", value: toolName });
  return details;
}

function stageKind(event: RuntimeTraceEvent): SubagentStageKind | null {
  if (event.kind === "agent.invoke" || event.kind === "agent.react_iteration" ||
      event.kind === "agent.task_iteration") return "agent";
  if (event.kind === "context.snapshot" || event.kind === "context.delta") return "context";
  if (event.kind === "rail.chain" || event.kind === "rail.hook") return "rail";
  if (event.kind.startsWith("model.")) return "model";
  if (event.kind === "tool.call") return "tool";
  if (event.kind === "ability.register") return "ability";
  return null;
}

function stageGroupKey(event: RuntimeTraceEvent, kind: SubagentStageKind) {
  if (kind === "model" && event.model) return `model:${event.model.invocationId}`;
  if (kind === "rail" && event.hook) {
    return `rail:${event.hook.rail}:${event.hook.callback}:${event.sequence}`;
  }
  if (kind === "context") return `context:${event.eventId}`;
  if (kind === "ability") return `ability:${payloadText(event, "toolName") ?? event.eventId}`;
  return `${kind}:${event.spanId}`;
}

function stageLabel(kind: SubagentStageKind, events: readonly RuntimeTraceEvent[]) {
  const first = events[0];
  if (kind === "model") return first.model?.modelId ?? "Model call";
  if (kind === "tool") return payloadText(first, "toolName") ?? first.title ?? "Tool call";
  if (kind === "rail") return first.hook?.rail ?? first.title ?? "Rail review";
  if (kind === "context") return first.context?.operation === "replace"
    ? "Context snapshot"
    : "Context delta";
  if (kind === "ability") return payloadText(first, "toolName") ?? "Ability registration";
  return first.title ?? "Child Agent invoke";
}

function aggregateStage(
  id: string,
  kind: SubagentStageKind,
  events: readonly RuntimeTraceEvent[],
): SubagentExecutionStage {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const first = sorted[0];
  const last = sorted.at(-1)!;
  const summary = last.summary ?? first.summary ?? last.title ?? first.title ?? last.kind;
  return {
    id,
    kind,
    label: stageLabel(kind, sorted),
    summary,
    status: latestStatus(sorted),
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    spanId: first.spanId,
    parentSpanId: first.parentSpanId,
    eventKinds: [...new Set(sorted.map((event) => event.kind))],
    eventIds: sorted.map((event) => event.eventId),
    details: sorted.flatMap(eventDetails),
    sourceLocation: sorted.map(sourceLocation).find(Boolean),
  };
}

function syntheticStage(
  id: string,
  kind: "dispatch" | "session" | "result",
  event: RuntimeTraceEvent,
  label: string,
  summary: string,
  details: SubagentStageDetail[],
  status = phaseStatus(event),
): SubagentExecutionStage {
  return {
    id,
    kind,
    label,
    summary,
    status,
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    eventKinds: [event.kind],
    eventIds: [event.eventId],
    details,
    sourceLocation: sourceLocation(event),
  };
}

function executionForLifecycle(
  events: readonly RuntimeTraceEvent[],
  lifecycle: readonly RuntimeTraceEvent[],
): SubagentExecution {
  const started = lifecycle[0];
  const finished = [...lifecycle].reverse().find((event) =>
    event.phase === "end" || event.phase === "error");
  const observation = started.subagent!;
  const subject = started.subject!;
  const parentLabel = events.find((event) => event.subject?.id === subject.parentId)
    ?.subject?.label;
  const dispatchEvents = observation.toolCallSpanId
    ? events.filter((event) => event.spanId === observation.toolCallSpanId)
    : [];
  const dispatchEvent = dispatchEvents[0] ?? started;
  const dispatchStatus = latestStatus(dispatchEvents.length ? dispatchEvents : [started]);
  const stages: SubagentExecutionStage[] = [
    syntheticStage(
      `${observation.invocationId}:dispatch`,
      "dispatch",
      dispatchEvent,
      observation.dispatcher,
      `${parentLabel ?? subject.parentId ?? "Parent Agent"} 通过 ${observation.dispatcher} 派发。`,
      [
        { label: "dispatcher", value: observation.dispatcher },
        { label: "run mode", value: observation.runMode },
        { label: "parent session", value: observation.parentSessionId },
        { label: "tool span", value: observation.toolCallSpanId ?? "not supplied" },
      ],
      dispatchStatus,
    ),
    syntheticStage(
      `${observation.invocationId}:session`,
      "session",
      started,
      observation.sessionId,
      "Subagent 使用独立 session 与 Context owner。",
      [
        { label: "subagent type", value: observation.subagentType },
        { label: "session", value: observation.sessionId },
        { label: "context owner", value: observation.contextOwnerId },
        { label: "session policy", value: observation.sessionPolicy },
        { label: "workspace", value: observation.workspaceIsolation },
        { label: "tool policy", value: observation.toolPolicy },
      ],
      finished ? phaseStatus(finished) : "running",
    ),
  ];

  const childEvents = events.filter((event) =>
    event.subject?.id === subject.id &&
    event.kind !== "swarm.subagent" &&
    event.sequence >= started.sequence &&
    (!finished || event.sequence <= finished.sequence));
  const groups = new Map<string, { kind: SubagentStageKind; events: RuntimeTraceEvent[] }>();
  childEvents.forEach((event) => {
    const kind = stageKind(event);
    if (!kind) return;
    const key = stageGroupKey(event, kind);
    const group = groups.get(key) ?? { kind, events: [] };
    group.events.push(event);
    groups.set(key, group);
  });
  [...groups.entries()]
    .map(([id, group]) => aggregateStage(`${observation.invocationId}:${id}`, group.kind, group.events))
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .forEach((stage) => stages.push(stage));

  if (finished) {
    stages.push(syntheticStage(
      `${observation.invocationId}:result`,
      "result",
      finished,
      finished.phase === "error" ? "Subagent error" : "Return to parent",
      finished.subagent?.resultPreview ?? finished.subagent?.error ??
        finished.summary ?? "Subagent completed without a result preview.",
      [
        { label: "phase", value: finished.phase },
        { label: "duration", value: `${finished.durationMs ?? 0} ms` },
        { label: "result preview", value: finished.subagent?.resultPreview ?? "not supplied" },
        { label: "error", value: finished.subagent?.error ?? "none" },
      ],
    ));
  }

  const executionEvents = events.filter((event) =>
    event.subject?.id === subject.id && event.sequence >= started.sequence &&
    (!finished || event.sequence <= finished.sequence));
  const contextMessageCount = executionEvents.reduce(
    (count, event) => count + (event.context?.messages?.length ?? 0),
    0,
  );
  const tokenUsed = executionEvents.reduce(
    (latest, event) => event.token?.used ?? latest,
    0,
  );

  return {
    id: observation.invocationId,
    invocationId: observation.invocationId,
    subjectId: subject.id,
    label: subject.label,
    parentSubjectId: subject.parentId,
    parentLabel,
    observation,
    status: finished ? phaseStatus(finished) : "running",
    startSequence: started.sequence,
    endSequence: finished?.sequence,
    stages,
    eventCount: executionEvents.length,
    contextMessageCount,
    tokenUsed,
  };
}

export function projectSubagentExecutions(
  events: readonly RuntimeTraceEvent[],
): SubagentExecution[] {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const lifecycleByInvocation = new Map<string, RuntimeTraceEvent[]>();
  sorted.forEach((event) => {
    if (
      event.kind !== "swarm.subagent" ||
      !event.subagent ||
      event.subject?.kind !== "subagent"
    ) return;
    const group = lifecycleByInvocation.get(event.subagent.invocationId) ?? [];
    group.push(event);
    lifecycleByInvocation.set(event.subagent.invocationId, group);
  });
  return [...lifecycleByInvocation.values()]
    .map((lifecycle) => executionForLifecycle(sorted, lifecycle))
    .sort((left, right) => left.startSequence - right.startSequence);
}

export function visibleSubagentStages(
  execution: SubagentExecution,
  throughSequence: number,
) {
  return execution.stages.filter((stage) => stage.firstSequence <= throughSequence);
}
