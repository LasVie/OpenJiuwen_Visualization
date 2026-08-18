import type {
  GraphSourceReference,
  JsonValue,
} from "./graph";
import type {
  ContextMessage,
  ContextRole,
  RuntimeOwner,
  TraceDetail,
} from "./trace";

export const CORE_RUNTIME_API_VERSION = "1.0.0" as const;

export const CORE_RUNTIME_EVENT_KINDS = [
  "agent.invoke",
  "agent.user_message",
  "agent.task_iteration",
  "agent.react_iteration",
  "model.call",
  "tool.call",
  "rail.chain",
  "rail.hook",
  "context.snapshot",
  "context.delta",
  "ability.register",
  "trace.status",
] as const;

export type CoreRuntimeEventKind = (typeof CORE_RUNTIME_EVENT_KINDS)[number];
export type CoreRuntimeEventPhase =
  | "start"
  | "end"
  | "error"
  | "instant";

export interface RuntimeTokenState {
  used: number;
  delta?: number;
  tool?: number;
  budget?: number;
}

export interface RuntimeContextMessage {
  id: string;
  role: ContextRole;
  label: string;
  raw: string;
  preview?: string;
  tokens: number;
  source: string;
}

export interface RuntimeContextDelta {
  operation: "append" | "replace" | "remove";
  messages?: RuntimeContextMessage[];
  removeMessageIds?: string[];
}

export interface RuntimeHookObservation {
  /** Exact only when an instrumentation Rail emits this field. */
  rail: string;
  railNodeId?: string;
  callback: string;
  priority: number;
  namespace: "outer" | "inner";
  durationMs: number;
  mutationDiff: string;
  controlSignal: string;
  noop?: boolean;
  exact: boolean;
  examines?: string[];
}

export interface CoreRuntimeEventInput {
  eventId: string;
  kind: CoreRuntimeEventKind;
  phase: CoreRuntimeEventPhase;
  timestampMs: number;
  spanId: string;
  parentSpanId?: string;
  iteration?: number;
  title?: string;
  summary?: string;
  durationMs?: number;
  activeNodeIds?: string[];
  activeEdgeIds?: string[];
  details?: TraceDetail[];
  token?: RuntimeTokenState;
  context?: RuntimeContextDelta;
  hook?: RuntimeHookObservation;
  definition?: GraphSourceReference;
  payload?: Readonly<Record<string, JsonValue>>;
}

export interface CoreRuntimeEvent extends CoreRuntimeEventInput {
  traceId: string;
  sequence: number;
  receivedAt: string;
}

export type RuntimeTraceStatus = "open" | "completed" | "failed";

export interface RuntimeTraceSession {
  id: string;
  owner: RuntimeOwner;
  label: string;
  status: RuntimeTraceStatus;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  lastSequence: number;
  maxTokens: number;
  byteCount: number;
}

export interface CreatedRuntimeTrace {
  apiVersion: typeof CORE_RUNTIME_API_VERSION;
  trace: RuntimeTraceSession;
  writeToken: string;
  endpoints: {
    events: string;
    snapshot: string;
    stream: string;
  };
  storage: "memory-only";
}

export interface RuntimeTraceSnapshot {
  apiVersion: typeof CORE_RUNTIME_API_VERSION;
  trace: RuntimeTraceSession;
  events: CoreRuntimeEvent[];
  storage: "memory-only";
}

export interface RuntimeSourceDefinition {
  id: string;
  owner: RuntimeOwner;
  label: string;
  description: string;
  transport: "loopback-sse";
  eventKinds: readonly CoreRuntimeEventKind[];
}

export interface RegisteredRuntimeSource extends RuntimeSourceDefinition {
  contributedBy: string;
}

export function runtimeMessageToContextMessage(
  message: RuntimeContextMessage,
  addedAt: number,
): ContextMessage {
  return { ...message, addedAt };
}

export function isCoreRuntimeEventKind(value: unknown): value is CoreRuntimeEventKind {
  return (
    typeof value === "string" &&
    (CORE_RUNTIME_EVENT_KINDS as readonly string[]).includes(value)
  );
}
