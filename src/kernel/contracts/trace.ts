export const TRACE_FLOW_VIEW_ID = "trace-flow" as const;

export type TraceNodeKind =
  | "input"
  | "agent"
  | "loop"
  | "context"
  | "model"
  | "decision"
  | "tool"
  | "output";

export type TraceNodeStatus = "idle" | "visited" | "active" | "muted";

export type TraceViewMode = "macro" | "micro";

export type RuntimeOwner = "agent-core" | "jiuwenswarm";

export type ContextRole = "system" | "user" | "assistant" | "tool" | "summary";

export interface HookDefinition {
  event: string;
  priority: number;
  namespace: "outer" | "inner";
}

export interface StageNodeDefinition {
  id: string;
  type: "stage";
  position: { x: number; y: number };
  label: string;
  subtitle: string;
  kind: TraceNodeKind;
  description: string;
  sourceLocation: string;
  owner: RuntimeOwner;
  accent?: "signal" | "context" | "fault";
}

export interface RailNodeDefinition {
  id: string;
  type: "rail";
  position: { x: number; y: number };
  label: string;
  subtitle: string;
  description: string;
  sourceLocation: string;
  owner: RuntimeOwner;
  hooks: HookDefinition[];
  lifecycle?: "init" | "runtime";
}

export type TraceNodeDefinition = StageNodeDefinition | RailNodeDefinition;

export interface TraceEdgeDefinition {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  kind?: "causal" | "rail";
}

export interface ContextMessage {
  id: string;
  role: ContextRole;
  label: string;
  raw: string;
  preview?: string;
  tokens: number;
  addedAt: number;
  removedAt?: number;
  source: string;
}

export interface HookInvocation {
  id: string;
  rail: string;
  event: string;
  priority: number;
  namespace: "outer" | "inner";
  durationMs: number;
  mutationDiff: string;
  controlSignal: string;
  noop?: boolean;
}

export interface CompressionEvent {
  state: "started" | "completed" | "noop" | "failed";
  processor: string;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  durationMs: number;
}

export interface TraceDetail {
  label: string;
  value: string;
}

export interface TraceStep {
  id: string;
  phase: string;
  title: string;
  eventCode: string;
  summary: string;
  timestampMs: number;
  durationMs: number;
  activeNodeIds: string[];
  activeEdgeIds: string[];
  tokenUsed: number;
  tokenDelta: number;
  toolTokens: number;
  hooks: HookInvocation[];
  details: TraceDetail[];
  compression?: CompressionEvent;
}

export interface TraceScenario {
  id: string;
  name: string;
  shortName: string;
  description: string;
  defaultInput: string;
  railNodeIds: string[];
  mutedNodeIds?: string[];
  messages: ContextMessage[];
  steps: TraceStep[];
  maxTokens: number;
  provenance?: {
    kind: "fixture" | "runtime";
    owner: RuntimeOwner;
    traceId?: string;
    status?: "open" | "completed" | "failed";
  };
}
