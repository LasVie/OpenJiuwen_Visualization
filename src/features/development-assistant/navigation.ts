import type {
  GitChangedFile,
  GitChangeComparison,
  GraphSourceReference,
  NodeChangeImpact,
  RegisteredGraphNode,
  RuntimeTraceEvent,
} from "../../kernel";
import type {
  DefinitionRuntimeSummary,
  RuntimeSourceMatchStatus,
} from "../source-convergence";

export type DevelopmentEntryPlane = "runtime" | "definition" | "change";

export interface DevelopmentRuntimeEvidence {
  traceId: string;
  lastSequence: number;
  lastPhase: RuntimeTraceEvent["phase"];
  spanCount: number;
  eventCount: number;
  tokenCount: number;
  strongestStatus?: RuntimeSourceMatchStatus;
}

export interface DevelopmentRuntimeOrigin {
  plane: "runtime";
  traceId: string;
  sequence: number;
  eventKind: RuntimeTraceEvent["kind"];
  phase: RuntimeTraceEvent["phase"];
  subject?: {
    id: string;
    kind: string;
    label: string;
  };
  tokenCount: number;
}

export interface DevelopmentDefinitionOrigin {
  plane: "definition";
  nodeId: string;
  nodeLabel: string;
  nodeKind: string;
  runtime?: DevelopmentRuntimeEvidence;
}

export interface DevelopmentChangeOrigin {
  plane: "change";
  nodeId: string;
  nodeLabel: string;
  nodeKind: string;
  comparison: {
    mode: GitChangeComparison["mode"];
    base: string;
    head: string;
  };
  file: {
    path: string;
    status: GitChangedFile["status"];
  };
  impact: {
    kind: NodeChangeImpact["kind"];
    confidence: NodeChangeImpact["confidence"];
    hunkIndexes: readonly number[];
    reason: string;
  };
  runtime?: DevelopmentRuntimeEvidence;
}

export type DevelopmentNavigationOrigin =
  | DevelopmentRuntimeOrigin
  | DevelopmentDefinitionOrigin
  | DevelopmentChangeOrigin;

export interface DevelopmentNavigationSeed {
  source: GraphSourceReference;
  intent: string;
  origin: DevelopmentNavigationOrigin;
}

export interface DevelopmentNavigationRequest extends DevelopmentNavigationSeed {
  id: number;
}

function runtimeEvidence(
  summary: DefinitionRuntimeSummary | undefined,
): DevelopmentRuntimeEvidence | undefined {
  if (!summary) return undefined;
  return {
    traceId: summary.lastEvent.traceId,
    lastSequence: summary.lastEvent.sequence,
    lastPhase: summary.lastEvent.phase,
    spanCount: summary.spanCount,
    eventCount: summary.eventCount,
    tokenCount: summary.tokenCount,
    strongestStatus: summary.strongestStatus,
  };
}

function targetLabel(source: GraphSourceReference, fallback?: string) {
  return source.symbol ?? fallback ?? source.path.split("/").at(-1) ?? source.path;
}

export function createRuntimeDevelopmentNavigation(
  event: RuntimeTraceEvent,
): DevelopmentNavigationSeed | null {
  if (!event.definition) return null;
  const label = targetLabel(event.definition);
  return {
    source: event.definition,
    intent: `检视 ${label} 在 Runtime step #${event.sequence}（${event.kind} · ${event.phase}）中的实现边界，给出保持现有运行合同的修改与测试建议`,
    origin: {
      plane: "runtime",
      traceId: event.traceId,
      sequence: event.sequence,
      eventKind: event.kind,
      phase: event.phase,
      ...(event.subject ? {
        subject: {
          id: event.subject.id,
          kind: event.subject.kind,
          label: event.subject.label,
        },
      } : {}),
      tokenCount: event.model?.usage?.totalTokens
        ?? Math.max(0, event.token?.delta ?? 0),
    },
  };
}

export function createDefinitionDevelopmentNavigation(input: {
  node: RegisteredGraphNode;
  source: GraphSourceReference;
  runtimeSummary?: DefinitionRuntimeSummary;
}): DevelopmentNavigationSeed {
  const label = targetLabel(input.source, input.node.label);
  return {
    source: input.source,
    intent: `检视 ${label}（${input.node.kind}）的定义边界与静态关系，给出保持公开合同的修改与测试建议`,
    origin: {
      plane: "definition",
      nodeId: input.node.id,
      nodeLabel: input.node.label,
      nodeKind: input.node.kind,
      ...(input.runtimeSummary ? {
        runtime: runtimeEvidence(input.runtimeSummary),
      } : {}),
    },
  };
}

export function createChangeDevelopmentNavigation(input: {
  node: RegisteredGraphNode;
  source: GraphSourceReference;
  impact: NodeChangeImpact;
  file: GitChangedFile;
  comparison: GitChangeComparison;
  runtimeSummary?: DefinitionRuntimeSummary;
}): DevelopmentNavigationSeed {
  const label = targetLabel(input.source, input.node.label);
  return {
    source: input.source,
    intent: `检视 ${label} 在 ${input.file.status} 变更中的 ${input.impact.kind} 影响，给出有界修改与回归测试建议`,
    origin: {
      plane: "change",
      nodeId: input.node.id,
      nodeLabel: input.node.label,
      nodeKind: input.node.kind,
      comparison: {
        mode: input.comparison.mode,
        base: input.comparison.base.requested,
        head: input.comparison.head.requested,
      },
      file: {
        path: input.file.path,
        status: input.file.status,
      },
      impact: {
        kind: input.impact.kind,
        confidence: input.impact.confidence,
        hunkIndexes: input.impact.hunkIndexes,
        reason: input.impact.reason,
      },
      ...(input.runtimeSummary ? {
        runtime: runtimeEvidence(input.runtimeSummary),
      } : {}),
    },
  };
}
