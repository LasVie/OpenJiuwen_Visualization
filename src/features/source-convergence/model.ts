import type {
  GraphSnapshot,
  GraphSourceReference,
  RegisteredGraphNode,
  RuntimeTraceEvent,
} from "../../kernel";
import {
  canonicalSourceIdentity,
  sameSourceLocation,
  sourceIdentityKey,
  sourceLocationKey,
} from "../../kernel";

export type RuntimeSourceMatchStatus =
  | "exact"
  | "revision-unverified"
  | "revision-mismatch"
  | "worktree-dirty"
  | "ambiguous"
  | "unmatched";

export interface RuntimeSourceMatch {
  event: RuntimeTraceEvent;
  source: GraphSourceReference;
  identity: string;
  status: RuntimeSourceMatchStatus;
  node?: RegisteredGraphNode;
  candidateNodeIds: readonly string[];
  reason: string;
}

export interface DefinitionRuntimeSummary {
  nodeId: string;
  observations: readonly RuntimeSourceMatch[];
  eventCount: number;
  spanCount: number;
  tokenCount: number;
  lastEvent: RuntimeTraceEvent;
  strongestStatus: RuntimeSourceMatchStatus;
}

export interface RuntimeDefinitionProjection {
  matches: readonly RuntimeSourceMatch[];
  summariesByNode: ReadonlyMap<string, DefinitionRuntimeSummary>;
  exactCount: number;
  degradedCount: number;
  unmatchedCount: number;
}

export interface SourceNavigationRequest {
  id: number;
  source: GraphSourceReference;
  origin?: {
    traceId: string;
    sequence: number;
  };
}

const statusPriority: Record<RuntimeSourceMatchStatus, number> = {
  exact: 0,
  "worktree-dirty": 1,
  "revision-unverified": 2,
  "revision-mismatch": 3,
  ambiguous: 4,
  unmatched: 5,
};

function nodeSource(node: RegisteredGraphNode) {
  return node.evidence.find((evidence) => evidence.source)?.source;
}

function locationCandidates(
  graph: GraphSnapshot,
  source: GraphSourceReference,
) {
  const runtime = canonicalSourceIdentity(source);
  return graph.nodes.filter((node) => {
    const candidate = nodeSource(node);
    if (!candidate) return false;
    const canonical = canonicalSourceIdentity(candidate);
    if (
      canonical.repository !== runtime.repository ||
      canonical.path !== runtime.path
    ) {
      return false;
    }
    if (runtime.symbol) return canonical.symbol === runtime.symbol;
    return node.kind === "module" && !canonical.symbol;
  });
}

function matchReason(
  status: RuntimeSourceMatchStatus,
  source: GraphSourceReference,
  node?: RegisteredGraphNode,
) {
  const definition = node ? nodeSource(node) : undefined;
  switch (status) {
    case "exact":
      return "仓库、revision、路径与 symbol 完全一致。";
    case "worktree-dirty":
      return "路径与 symbol 一致，但定义扫描来自含未提交修改的工作树。";
    case "revision-unverified":
      return "路径与 symbol 一致，但 Runtime 或 Definition 未声明 revision。";
    case "revision-mismatch":
      return `路径与 symbol 一致，但 Runtime ${source.revision?.slice(0, 12) ?? "?"} 与 Definition ${definition?.revision?.slice(0, 12) ?? "?"} 不一致。`;
    case "ambiguous":
      return "同一结构化源码位置对应多个 Definition 节点，未自动选择。";
    case "unmatched":
      return "当前 Definition 图没有相同仓库、路径与 symbol 的节点。";
  }
}

export function matchRuntimeSource(
  graph: GraphSnapshot,
  event: RuntimeTraceEvent,
  options: { repositoryDirty?: boolean } = {},
): RuntimeSourceMatch | null {
  const source = event.definition;
  if (!source) return null;
  const candidates = locationCandidates(graph, source);
  if (candidates.length === 0) {
    return {
      event,
      source,
      identity: sourceIdentityKey(source),
      status: "unmatched",
      candidateNodeIds: [],
      reason: matchReason("unmatched", source),
    };
  }
  if (candidates.length > 1) {
    return {
      event,
      source,
      identity: sourceIdentityKey(source),
      status: "ambiguous",
      candidateNodeIds: candidates.map((node) => node.id),
      reason: matchReason("ambiguous", source),
    };
  }

  const node = candidates[0];
  const definition = nodeSource(node)!;
  const runtimeRevision = canonicalSourceIdentity(source).revision;
  const definitionRevision = canonicalSourceIdentity(definition).revision;
  const status: RuntimeSourceMatchStatus =
    runtimeRevision && definitionRevision && runtimeRevision !== definitionRevision
      ? "revision-mismatch"
      : options.repositoryDirty
        ? "worktree-dirty"
        : !runtimeRevision || !definitionRevision
          ? "revision-unverified"
          : "exact";
  return {
    event,
    source,
    identity: sourceIdentityKey(source),
    status,
    node,
    candidateNodeIds: [node.id],
    reason: matchReason(status, source, node),
  };
}

function observedTokens(event: RuntimeTraceEvent) {
  return event.model?.usage?.totalTokens ?? Math.max(0, event.token?.delta ?? 0);
}

export function projectRuntimeDefinitions(
  graph: GraphSnapshot,
  events: readonly RuntimeTraceEvent[],
  options: { repositoryDirty?: boolean } = {},
): RuntimeDefinitionProjection {
  const matches = events.flatMap((event) => {
    const match = matchRuntimeSource(graph, event, options);
    return match ? [match] : [];
  });
  const byNode = new Map<string, RuntimeSourceMatch[]>();
  matches.forEach((match) => {
    if (!match.node) return;
    const observations = byNode.get(match.node.id) ?? [];
    observations.push(match);
    byNode.set(match.node.id, observations);
  });
  const summariesByNode = new Map<string, DefinitionRuntimeSummary>();
  byNode.forEach((observations, nodeId) => {
    const ordered = [...observations].sort(
      (left, right) => left.event.sequence - right.event.sequence,
    );
    const last = ordered.at(-1)!;
    const strongest = ordered.reduce(
      (current, observation) =>
        statusPriority[observation.status] < statusPriority[current]
          ? observation.status
          : current,
      ordered[0].status,
    );
    summariesByNode.set(nodeId, {
      nodeId,
      observations: ordered,
      eventCount: ordered.length,
      spanCount: new Set(
        ordered.map(({ event }) => `${event.traceId}:${event.spanId}`),
      ).size,
      tokenCount: ordered.reduce(
        (total, observation) => total + observedTokens(observation.event),
        0,
      ),
      lastEvent: last.event,
      strongestStatus: strongest,
    });
  });

  return {
    matches,
    summariesByNode,
    exactCount: matches.filter((match) => match.status === "exact").length,
    degradedCount: matches.filter(
      (match) => !["exact", "unmatched"].includes(match.status),
    ).length,
    unmatchedCount: matches.filter((match) => match.status === "unmatched").length,
  };
}

export function matchSourceToDefinition(
  graph: GraphSnapshot,
  source: GraphSourceReference,
  options: { repositoryDirty?: boolean } = {},
) {
  const synthetic: RuntimeTraceEvent = {
    traceId: "source-navigation",
    eventId: `source-navigation:${sourceLocationKey(source)}`,
    sequence: 0,
    receivedAt: "",
    kind: "trace.status",
    phase: "instant",
    timestampMs: 0,
    spanId: "source-navigation",
    definition: source,
  };
  return matchRuntimeSource(graph, synthetic, options);
}

export function repositoryMatchesSource(
  repository: { id: string; name: string; owner: string },
  source: GraphSourceReference,
) {
  const expected = canonicalSourceIdentity(source).repository;
  return [repository.id, repository.name, repository.owner]
    .map((value) => value.trim().toLocaleLowerCase())
    .includes(expected);
}

export function sourceMatchesNode(
  source: GraphSourceReference,
  node: RegisteredGraphNode,
) {
  const definition = nodeSource(node);
  return Boolean(definition && sameSourceLocation(source, definition));
}
