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

export const RUNTIME_TRACE_API_VERSION = "1.0.0" as const;
/** Backward-compatible name retained for existing Agent Core collectors. */
export const CORE_RUNTIME_API_VERSION = RUNTIME_TRACE_API_VERSION;

export const CORE_RUNTIME_EVENT_KINDS = [
  "agent.invoke",
  "agent.user_message",
  "agent.task_iteration",
  "agent.react_iteration",
  "model.call",
  "model.stream",
  "model.usage",
  "model.cancel",
  "tool.call",
  "rail.chain",
  "rail.hook",
  "context.snapshot",
  "context.delta",
  "ability.register",
  "trace.status",
] as const;

export type CoreRuntimeEventKind = (typeof CORE_RUNTIME_EVENT_KINDS)[number];

export const SWARM_RUNTIME_EVENT_KINDS = [
  "swarm.team",
  "swarm.member",
  "swarm.task",
  "swarm.message",
  "swarm.workflow",
  "swarm.phase",
  "swarm.agent",
  "swarm.human",
  "swarm.subagent",
] as const;

export type SwarmRuntimeEventKind = (typeof SWARM_RUNTIME_EVENT_KINDS)[number];

export const RUNTIME_TRACE_EVENT_KINDS = [
  ...CORE_RUNTIME_EVENT_KINDS,
  ...SWARM_RUNTIME_EVENT_KINDS,
] as const;

export type RuntimeTraceEventKind =
  (typeof RUNTIME_TRACE_EVENT_KINDS)[number];

export type CoreRuntimeEventPhase =
  | "start"
  | "end"
  | "error"
  | "instant";

export const RUNTIME_SUBJECT_KINDS = [
  "team",
  "workflow",
  "phase",
  "member",
  "agent",
  "subagent",
  "human",
  "task",
] as const;

export type RuntimeSubjectKind = (typeof RUNTIME_SUBJECT_KINDS)[number];

export interface RuntimeSubjectReference {
  /** Stable within one trace. Use runtime IDs instead of display labels. */
  id: string;
  kind: RuntimeSubjectKind;
  label: string;
  parentId?: string;
  role?: string;
  /** Context owner may differ from the structural node (for example a task). */
  contextOwnerId?: string;
}

export interface RuntimeTokenState {
  used: number;
  delta?: number;
  tool?: number;
  budget?: number;
}

export interface RuntimeModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costMicros?: number;
  currency?: string;
}

export interface RuntimeModelBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostMicros?: number;
  currency?: string;
}

/** Provider-neutral evidence attached to model.* events. Prompt text stays in Context. */
export interface RuntimeModelObservation {
  invocationId: string;
  providerId: string;
  modelId: string;
  source: "live" | "recording";
  recordingId?: string;
  recordingSequence?: number;
  delta?: string;
  responseText?: string;
  finishReason?: string;
  cancelReason?: string;
  usage?: RuntimeModelUsage;
  budget?: RuntimeModelBudget;
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
  /** Required by the local collector for jiuwenswarm-owned traces. */
  ownerId?: string;
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

export type RuntimeSubagentDispatcher =
  | "task-tool"
  | "agent-tool"
  | "session-spawn";

export type RuntimeSubagentRunMode = "foreground" | "background";
export type RuntimeSubagentSessionPolicy = "ephemeral" | "sticky";
export type RuntimeSubagentWorkspaceIsolation =
  | "subdirectory"
  | "shared"
  | "unknown";
export type RuntimeSubagentToolPolicy =
  | "configured"
  | "inherited-filtered"
  | "none"
  | "unknown";

/**
 * Exact Subagent dispatch evidence. Prompt and full result text belong in the
 * Subagent-owned Context so metadata cannot accidentally bypass redaction UI.
 */
export interface RuntimeSubagentObservation {
  invocationId: string;
  subagentType: string;
  dispatcher: RuntimeSubagentDispatcher;
  runMode: RuntimeSubagentRunMode;
  parentSessionId: string;
  sessionId: string;
  contextOwnerId: string;
  sessionPolicy: RuntimeSubagentSessionPolicy;
  workspaceIsolation: RuntimeSubagentWorkspaceIsolation;
  toolPolicy: RuntimeSubagentToolPolicy;
  toolCallSpanId?: string;
  resultPreview?: string;
  error?: string;
}

export interface RuntimeEnvironmentEvidence {
  id: "core-env" | "swarm-core-env";
  consumer: "agent-core" | "subagent" | "jiuwenswarm" | "swarmflow";
  fingerprint: string;
  pythonVersion: string;
  uvVersion: string;
  activatedAt: string;
  project: {
    slot: "agent-core" | "jiuwenswarm";
    revision: string | null;
    dirty: boolean | null;
  };
  coreDependency: {
    kind: "git" | "path" | "registry";
    revision: string | null;
  } | null;
  validation: "passed";
}

export interface RuntimeTraceEventInput<
  Kind extends RuntimeTraceEventKind = RuntimeTraceEventKind,
> {
  eventId: string;
  kind: Kind;
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
  model?: RuntimeModelObservation;
  subagent?: RuntimeSubagentObservation;
  subject?: RuntimeSubjectReference;
  definition?: GraphSourceReference;
  environment?: RuntimeEnvironmentEvidence;
  payload?: Readonly<Record<string, JsonValue>>;
}

export interface RuntimeTraceEvent<
  Kind extends RuntimeTraceEventKind = RuntimeTraceEventKind,
> extends RuntimeTraceEventInput<Kind> {
  traceId: string;
  sequence: number;
  receivedAt: string;
}

export type CoreRuntimeEventInput = RuntimeTraceEventInput<CoreRuntimeEventKind>;
export type CoreRuntimeEvent = RuntimeTraceEvent<CoreRuntimeEventKind>;

export type SwarmTraceEventKind =
  | SwarmRuntimeEventKind
  | CoreRuntimeEventKind;
export type SwarmRuntimeEventInput = RuntimeTraceEventInput<SwarmTraceEventKind>;
export type SwarmRuntimeEvent = RuntimeTraceEvent<SwarmTraceEventKind>;

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
  apiVersion: typeof RUNTIME_TRACE_API_VERSION;
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
  apiVersion: typeof RUNTIME_TRACE_API_VERSION;
  trace: RuntimeTraceSession;
  events: RuntimeTraceEvent[];
  storage: "memory-only";
}

export interface RuntimeSourceDefinition {
  id: string;
  owner: RuntimeOwner;
  label: string;
  description: string;
  transport: "loopback-sse";
  eventKinds: readonly RuntimeTraceEventKind[];
}

export interface RegisteredRuntimeSource extends RuntimeSourceDefinition {
  contributedBy: string;
}

export interface RuntimeTraceRecording {
  id: string;
  owner: RuntimeOwner;
  label: string;
  description: string;
  maxTokens: number;
  events: readonly RuntimeTraceEventInput[];
}

export interface RegisteredRuntimeTraceRecording extends RuntimeTraceRecording {
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

export function isSwarmRuntimeEventKind(value: unknown): value is SwarmRuntimeEventKind {
  return (
    typeof value === "string" &&
    (SWARM_RUNTIME_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export function isRuntimeTraceEventKind(value: unknown): value is RuntimeTraceEventKind {
  return isCoreRuntimeEventKind(value) || isSwarmRuntimeEventKind(value);
}

export function isRuntimeSubjectKind(value: unknown): value is RuntimeSubjectKind {
  return (
    typeof value === "string" &&
    (RUNTIME_SUBJECT_KINDS as readonly string[]).includes(value)
  );
}
