import type {
  RuntimeModelBudget,
  RuntimeModelUsage,
  RuntimeSubjectReference,
  RuntimeTraceEvent,
} from "../../kernel";

export type ModelInvocationStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

export interface ModelInvocationFrame {
  eventId: string;
  sequence: number;
  timestampMs: number;
  kind: RuntimeTraceEvent["kind"];
  phase: RuntimeTraceEvent["phase"];
  delta?: string;
  title: string;
}

export interface ModelRuntimeInvocation {
  id: string;
  providerId: string;
  modelId: string;
  source: "live" | "recording";
  recordingId?: string;
  subject?: RuntimeSubjectReference;
  spanId: string;
  parentSpanId?: string;
  status: ModelInvocationStatus;
  output: string;
  finishReason?: string;
  cancelReason?: string;
  usage?: RuntimeModelUsage;
  budget?: RuntimeModelBudget;
  startedAtMs: number;
  updatedAtMs: number;
  durationMs: number;
  firstSequence: number;
  lastSequence: number;
  frames: ModelInvocationFrame[];
}

export interface ModelRuntimeProjection {
  invocations: ModelRuntimeInvocation[];
  activeInvocationId: string | null;
  observedEventCount: number;
}

function initialStatus(event: RuntimeTraceEvent): ModelInvocationStatus {
  if (event.kind === "model.cancel") return "cancelled";
  if (event.phase === "error") return "failed";
  if (event.kind === "model.call" && event.phase === "end") return "completed";
  if (event.kind === "model.call" || event.kind === "model.stream") return "streaming";
  return "pending";
}

function nextStatus(
  current: ModelInvocationStatus,
  event: RuntimeTraceEvent,
): ModelInvocationStatus {
  if (["completed", "cancelled", "failed"].includes(current)) return current;
  if (event.kind === "model.cancel") return "cancelled";
  if (event.phase === "error") return "failed";
  if (event.kind === "model.call" && event.phase === "end") return "completed";
  if (
    current === "pending" &&
    (event.kind === "model.call" || event.kind === "model.stream")
  ) {
    return "streaming";
  }
  return current;
}

function frameTitle(event: RuntimeTraceEvent) {
  if (event.title?.trim()) return event.title;
  const labels: Partial<Record<RuntimeTraceEvent["kind"], string>> = {
    "model.call": event.phase === "start" ? "请求已发送" : "调用已结束",
    "model.stream": "输出增量",
    "model.usage": "用量更新",
    "model.cancel": "调用取消",
  };
  return labels[event.kind] ?? event.kind;
}

export function projectModelRuntime(
  events: readonly RuntimeTraceEvent[],
  throughSequence = Number.POSITIVE_INFINITY,
): ModelRuntimeProjection {
  const invocations = new Map<string, ModelRuntimeInvocation>();
  let activeInvocationId: string | null = null;
  let observedEventCount = 0;

  [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => event.sequence <= throughSequence && event.model)
    .forEach((event) => {
      const observation = event.model!;
      observedEventCount += 1;
      activeInvocationId = observation.invocationId;
      const existing = invocations.get(observation.invocationId);
      const frame: ModelInvocationFrame = {
        eventId: event.eventId,
        sequence: event.sequence,
        timestampMs: event.timestampMs,
        kind: event.kind,
        phase: event.phase,
        delta: observation.delta,
        title: frameTitle(event),
      };

      if (!existing) {
        invocations.set(observation.invocationId, {
          id: observation.invocationId,
          providerId: observation.providerId,
          modelId: observation.modelId,
          source: observation.source,
          recordingId: observation.recordingId,
          subject: event.subject,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
          status: initialStatus(event),
          output: observation.responseText ?? observation.delta ?? "",
          finishReason: observation.finishReason,
          cancelReason: observation.cancelReason,
          usage: observation.usage,
          budget: observation.budget,
          startedAtMs: event.timestampMs,
          updatedAtMs: event.timestampMs,
          durationMs: event.durationMs ?? 0,
          firstSequence: event.sequence,
          lastSequence: event.sequence,
          frames: [frame],
        });
        return;
      }

      existing.status = nextStatus(existing.status, event);
      existing.updatedAtMs = event.timestampMs;
      existing.lastSequence = event.sequence;
      existing.durationMs = event.durationMs ?? Math.max(
        existing.durationMs,
        event.timestampMs - existing.startedAtMs,
      );
      existing.subject = event.subject ?? existing.subject;
      existing.recordingId = observation.recordingId ?? existing.recordingId;
      existing.finishReason = observation.finishReason ?? existing.finishReason;
      existing.cancelReason = observation.cancelReason ?? existing.cancelReason;
      existing.usage = observation.usage ?? existing.usage;
      existing.budget = observation.budget
        ? { ...existing.budget, ...observation.budget }
        : existing.budget;
      if (observation.responseText !== undefined) {
        existing.output = observation.responseText;
      } else if (observation.delta !== undefined) {
        existing.output += observation.delta;
      }
      existing.frames.push(frame);
    });

  return {
    invocations: [...invocations.values()].sort(
      (left, right) => left.firstSequence - right.firstSequence,
    ),
    activeInvocationId,
    observedEventCount,
  };
}
