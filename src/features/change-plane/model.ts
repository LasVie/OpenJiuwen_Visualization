import type {
  GitChangedFile,
  GraphSnapshot,
  NodeChangeImpact,
  RegisteredGraphEdge,
  RegisteredGraphNode,
  RuntimeTraceEvent,
} from "../../kernel";
import type {
  LocalGitChangeResult,
  LocalRepositoryScanResult,
} from "../../adapters/local-repository";
import type { GitHubPullRequestResult } from "../../adapters/github-pull-request";
import {
  projectRuntimeDefinitions,
  type DefinitionRuntimeSummary,
  type RuntimeDefinitionProjection,
} from "../source-convergence";

export type RepositoryChangeResult =
  | LocalGitChangeResult
  | GitHubPullRequestResult;

export interface FileImpactProjection {
  file: GitChangedFile;
  direct: readonly NodeChangeImpact[];
  containers: readonly NodeChangeImpact[];
  dependents: readonly NodeChangeImpact[];
  fileLevel: readonly NodeChangeImpact[];
  runtimeObserved: readonly DefinitionRuntimeSummary[];
}

export interface ChangeImpactProjection {
  graph: GraphSnapshot;
  changes: RepositoryChangeResult;
  files: readonly FileImpactProjection[];
  impacts: readonly NodeChangeImpact[];
  impactsById: ReadonlyMap<string, NodeChangeImpact>;
  nodesById: ReadonlyMap<string, RegisteredGraphNode>;
  edgesById: ReadonlyMap<string, RegisteredGraphEdge>;
  headAligned: boolean;
  runtime: RuntimeDefinitionProjection;
}

const statusOrder = new Map([
  ["conflicted", 0],
  ["deleted", 1],
  ["renamed", 2],
  ["added", 3],
  ["untracked", 4],
  ["modified", 5],
  ["copied", 6],
]);

function sourceFor(node: RegisteredGraphNode) {
  return node.evidence.find((evidence) => evidence.source)?.source;
}

function fileMatches(node: RegisteredGraphNode, file: GitChangedFile) {
  const path = sourceFor(node)?.path;
  return path === file.path || path === file.previousPath;
}

function hunkRange(file: GitChangedFile, hunkIndex: number) {
  const hunk = file.hunks[hunkIndex];
  const useOld = file.status === "deleted" || hunk.newLines === 0;
  const start = useOld ? hunk.oldStart : hunk.newStart;
  const count = useOld ? hunk.oldLines : hunk.newLines;
  return { start, end: start + Math.max(1, count) - 1 };
}

function intersectingHunks(node: RegisteredGraphNode, file: GitChangedFile) {
  const source = sourceFor(node);
  if (!source?.startLine || !source.endLine) return [];
  return file.hunks.flatMap((_, index) => {
    const range = hunkRange(file, index);
    return source.startLine! <= range.end && source.endLine! >= range.start
      ? [index]
      : [];
  });
}

function impactId(fileId: string, nodeId: string, kind: NodeChangeImpact["kind"]) {
  return `${fileId}:${kind}:${nodeId}`;
}

function pushUnique(
  impacts: Map<string, NodeChangeImpact>,
  impact: NodeChangeImpact,
) {
  if (!impacts.has(impact.id)) impacts.set(impact.id, impact);
}

function isHeadAligned(
  scan: LocalRepositoryScanResult,
  changes: RepositoryChangeResult,
) {
  if (changes.comparison.mode === "working-tree") return true;
  return (
    !scan.repository.dirty &&
    changes.comparison.head.resolved === scan.repository.revision
  );
}

export function projectChangeImpacts(
  scan: LocalRepositoryScanResult,
  changes: RepositoryChangeResult,
  runtimeEvents: readonly RuntimeTraceEvent[] = [],
): ChangeImpactProjection {
  const nodesById = new Map(scan.graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(scan.graph.edges.map((edge) => [edge.id, edge]));
  const headAligned = isHeadAligned(scan, changes);
  const runtime = projectRuntimeDefinitions(scan.graph, runtimeEvents, {
    repositoryDirty: scan.repository.dirty,
  });
  const files = [...changes.files].sort(
    (left, right) =>
      (statusOrder.get(left.status) ?? 99) - (statusOrder.get(right.status) ?? 99) ||
      left.path.localeCompare(right.path, "en", { numeric: true }),
  );
  const globalImpacts = new Map<string, NodeChangeImpact>();
  const projections = files.map<FileImpactProjection>((file) => {
    const relevantNodes = scan.graph.nodes.filter((node) => fileMatches(node, file));
    const local = new Map<string, NodeChangeImpact>();
    const directNodeIds = new Set<string>();

    relevantNodes.forEach((node) => {
      const hunkIndexes = intersectingHunks(node, file);
      if (hunkIndexes.length === 0) return;
      directNodeIds.add(node.id);
      pushUnique(local, {
        id: impactId(file.id, node.id, "direct"),
        nodeId: node.id,
        fileId: file.id,
        kind: "direct",
        confidence: headAligned ? "exact" : "inferred",
        hunkIndexes,
        reason: headAligned
          ? "源码范围与变更 hunk 直接相交。"
          : "路径与行号相交，但比较 head 并非当前干净检出。",
      });
    });

    directNodeIds.forEach((nodeId) => {
      let parentId = nodesById.get(nodeId)?.parentId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = nodesById.get(parentId);
        if (!parent) break;
        pushUnique(local, {
          id: impactId(file.id, parent.id, "container"),
          nodeId: parent.id,
          fileId: file.id,
          kind: "container",
          confidence: headAligned ? "exact" : "inferred",
          hunkIndexes: [],
          reason: "包含直接变更的定义节点。",
        });
        parentId = parent.parentId;
      }

      scan.graph.edges.forEach((edge) => {
        if (edge.kind === "contains") return;
        const relatedId = edge.source === nodeId
          ? edge.target
          : edge.target === nodeId
            ? edge.source
            : null;
        if (!relatedId || directNodeIds.has(relatedId) || !nodesById.has(relatedId)) return;
        pushUnique(local, {
          id: impactId(file.id, relatedId, "dependent"),
          nodeId: relatedId,
          fileId: file.id,
          kind: "dependent",
          confidence: "inferred",
          hunkIndexes: [],
          reason: `${edge.kind} 关系连接到直接变更节点。`,
        });
      });
    });

    if (directNodeIds.size === 0) {
      const fileNodes = relevantNodes.filter((node) =>
        node.kind === "module" || node.kind === "repository");
      (fileNodes.length ? fileNodes : relevantNodes.slice(0, 1)).forEach((node) => {
        pushUnique(local, {
          id: impactId(file.id, node.id, "file"),
          nodeId: node.id,
          fileId: file.id,
          kind: "file",
          confidence: "inferred",
          hunkIndexes: [],
          reason: file.hunks.length
            ? "文件已变更，但索引中没有可相交的完整符号范围。"
            : "重命名、删除、二进制或未跟踪文件仅能建立文件级影响。",
        });
      });
    }

    local.forEach((impact) => pushUnique(globalImpacts, impact));
    const values = [...local.values()];
    const impactedNodeIds = new Set(values.map((impact) => impact.nodeId));
    return {
      file,
      direct: values.filter((impact) => impact.kind === "direct"),
      containers: values.filter((impact) => impact.kind === "container"),
      dependents: values.filter((impact) => impact.kind === "dependent"),
      fileLevel: values.filter((impact) => impact.kind === "file"),
      runtimeObserved: [...runtime.summariesByNode.values()].filter((summary) =>
        impactedNodeIds.has(summary.nodeId)),
    };
  });

  return {
    graph: scan.graph,
    changes,
    files: projections,
    impacts: [...globalImpacts.values()],
    impactsById: globalImpacts,
    nodesById,
    edgesById,
    headAligned,
    runtime,
  };
}

export function refreshRuntimeCoverage(
  projection: ChangeImpactProjection,
  runtimeEvents: readonly RuntimeTraceEvent[],
): ChangeImpactProjection {
  const runtime = projectRuntimeDefinitions(projection.graph, runtimeEvents, {
    repositoryDirty: projection.changes.repository.dirty,
  });
  return {
    ...projection,
    runtime,
    files: projection.files.map((file) => {
      const impactedNodeIds = new Set([
        ...file.direct,
        ...file.containers,
        ...file.dependents,
        ...file.fileLevel,
      ].map((impact) => impact.nodeId));
      return {
        ...file,
        runtimeObserved: [...runtime.summariesByNode.values()].filter((summary) =>
          impactedNodeIds.has(summary.nodeId)),
      };
    }),
  };
}
