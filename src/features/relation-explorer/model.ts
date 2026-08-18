import type { RegisteredGraphEdge, RegisteredGraphNode } from "../../kernel";
import type { DefinitionGraphIndex } from "../repository-browser";

export type RelationDirection = "all" | "incoming" | "outgoing";

export interface RelationExplorerOptions {
  direction?: RelationDirection;
  edgeKinds?: ReadonlySet<string>;
  perNodeLimit?: number;
  maxNodes?: number;
}

export interface RelationExplorerNode {
  record: RegisteredGraphNode;
  depth: number;
  column: number;
  position: { x: number; y: number };
  root: boolean;
  expanded: boolean;
  expandable: boolean;
  totalRelations: number;
  visibleRelations: number;
  hiddenRelations: number;
}

export interface RelationExplorerProjection {
  root: RegisteredGraphNode;
  nodes: readonly RelationExplorerNode[];
  edges: readonly RegisteredGraphEdge[];
  expandedNodeIds: ReadonlySet<string>;
  hiddenRelations: number;
  truncated: boolean;
}

const DEFAULT_PER_NODE_LIMIT = 18;
const DEFAULT_MAX_NODES = 64;
const HARD_MAX_NODES = 80;
const COLUMN_GAP = 322;
const ROW_GAP = 172;

const edgeKindOrder = new Map([
  ["contains", 0],
  ["inherits", 1],
  ["imports", 2],
]);

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function compareEdges(
  index: DefinitionGraphIndex,
  nodeId: string,
  first: RegisteredGraphEdge,
  second: RegisteredGraphEdge,
) {
  const kindDifference =
    (edgeKindOrder.get(first.kind) ?? 99) -
    (edgeKindOrder.get(second.kind) ?? 99);
  if (kindDifference !== 0) return kindDifference;
  const firstPeer = first.source === nodeId ? first.target : first.source;
  const secondPeer = second.source === nodeId ? second.target : second.source;
  const labelDifference = (index.nodesById.get(firstPeer)?.label ?? firstPeer).localeCompare(
    index.nodesById.get(secondPeer)?.label ?? secondPeer,
    "zh-CN",
    { numeric: true, sensitivity: "base" },
  );
  return labelDifference || first.id.localeCompare(second.id);
}

function edgeMatchesDirection(
  edge: RegisteredGraphEdge,
  nodeId: string,
  direction: RelationDirection,
) {
  if (direction === "incoming") return edge.target === nodeId;
  if (direction === "outgoing") return edge.source === nodeId;
  return edge.source === nodeId || edge.target === nodeId;
}

function relationEdges(
  index: DefinitionGraphIndex,
  nodeId: string,
  direction: RelationDirection,
  edgeKinds: ReadonlySet<string>,
) {
  const byId = new Map<string, RegisteredGraphEdge>();
  [
    ...(index.incomingByNode.get(nodeId) ?? []),
    ...(index.outgoingByNode.get(nodeId) ?? []),
  ].forEach((edge) => {
    if (
      edgeKinds.has(edge.kind) &&
      edgeMatchesDirection(edge, nodeId, direction) &&
      index.nodesById.has(edge.source === nodeId ? edge.target : edge.source)
    ) {
      byId.set(edge.id, edge);
    }
  });
  return [...byId.values()].sort((first, second) =>
    compareEdges(index, nodeId, first, second));
}

export function relationKinds(index: DefinitionGraphIndex) {
  return [...new Set(index.graph.edges.map((edge) => edge.kind))].sort(
    (first, second) =>
      (edgeKindOrder.get(first) ?? 99) - (edgeKindOrder.get(second) ?? 99) ||
      first.localeCompare(second),
  );
}

function projectedPositions(
  rootId: string,
  nodeIds: ReadonlySet<string>,
  edges: readonly RegisteredGraphEdge[],
) {
  const depthById = new Map([[rootId, 0]]);
  const columnById = new Map([[rootId, 0]]);
  const queue = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentDepth = depthById.get(currentId) ?? 0;
    const currentColumn = columnById.get(currentId) ?? 0;
    edges.forEach((edge) => {
      if (edge.source !== currentId && edge.target !== currentId) return;
      const peerId = edge.source === currentId ? edge.target : edge.source;
      if (!nodeIds.has(peerId) || depthById.has(peerId)) return;
      depthById.set(peerId, currentDepth + 1);
      columnById.set(peerId, currentColumn + (edge.source === currentId ? 1 : -1));
      queue.push(peerId);
    });
  }

  const columns = new Map<number, string[]>();
  nodeIds.forEach((nodeId) => {
    const column = columnById.get(nodeId) ?? 0;
    const values = columns.get(column);
    if (values) values.push(nodeId);
    else columns.set(column, [nodeId]);
  });
  columns.forEach((values) => values.sort((first, second) =>
    (depthById.get(first) ?? 0) - (depthById.get(second) ?? 0) ||
    first.localeCompare(second)));

  const positions = new Map<string, { depth: number; column: number; x: number; y: number }>();
  columns.forEach((values, column) => {
    values.forEach((nodeId, index) => {
      positions.set(nodeId, {
        depth: depthById.get(nodeId) ?? 0,
        column,
        x: column * COLUMN_GAP,
        y: (index - (values.length - 1) / 2) * ROW_GAP,
      });
    });
  });
  return positions;
}

export function projectRelationExplorer(
  index: DefinitionGraphIndex,
  rootId: string,
  requestedExpandedIds: ReadonlySet<string>,
  options: RelationExplorerOptions = {},
): RelationExplorerProjection {
  const root = index.nodesById.get(rootId);
  if (!root) throw new Error(`Unknown relation explorer root: ${rootId}`);

  const direction = options.direction ?? "all";
  const enabledKinds = options.edgeKinds ?? new Set(relationKinds(index));
  const perNodeLimit = clampInteger(
    options.perNodeLimit,
    DEFAULT_PER_NODE_LIMIT,
    1,
    40,
  );
  const maxNodes = clampInteger(options.maxNodes, DEFAULT_MAX_NODES, 2, HARD_MAX_NODES);
  const expandedNodeIds = new Set([rootId, ...requestedExpandedIds]);
  const visibleNodeIds = new Set([rootId]);
  const selectedEdgeIds = new Set<string>();
  const queue = [rootId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId) || !expandedNodeIds.has(nodeId)) continue;
    visited.add(nodeId);
    const candidates = relationEdges(index, nodeId, direction, enabledKinds);
    for (const edge of candidates.slice(0, perNodeLimit)) {
      const peerId = edge.source === nodeId ? edge.target : edge.source;
      if (!visibleNodeIds.has(peerId) && visibleNodeIds.size >= maxNodes) continue;
      visibleNodeIds.add(peerId);
      selectedEdgeIds.add(edge.id);
      if (expandedNodeIds.has(peerId) && !visited.has(peerId)) queue.push(peerId);
    }
  }

  const visibleExpandedIds = new Set(
    [...expandedNodeIds].filter((nodeId) => visibleNodeIds.has(nodeId)),
  );
  index.graph.edges.forEach((edge) => {
    if (
      !enabledKinds.has(edge.kind) ||
      !visibleNodeIds.has(edge.source) ||
      !visibleNodeIds.has(edge.target)
    ) return;
    if (
      direction === "incoming" && !visibleExpandedIds.has(edge.target) ||
      direction === "outgoing" && !visibleExpandedIds.has(edge.source) ||
      direction === "all" &&
        !visibleExpandedIds.has(edge.source) &&
        !visibleExpandedIds.has(edge.target)
    ) return;
    selectedEdgeIds.add(edge.id);
  });

  const edges = index.graph.edges.filter((edge) => selectedEdgeIds.has(edge.id));
  const positions = projectedPositions(rootId, visibleNodeIds, edges);
  let hiddenRelations = 0;
  const nodes = [...visibleNodeIds]
    .map((nodeId) => {
      const record = index.nodesById.get(nodeId)!;
      const available = relationEdges(index, nodeId, direction, enabledKinds);
      const visibleRelations = edges.filter(
        (edge) => edge.source === nodeId || edge.target === nodeId,
      ).length;
      const hidden = Math.max(0, available.length - visibleRelations);
      if (visibleExpandedIds.has(nodeId)) hiddenRelations += hidden;
      const position = positions.get(nodeId) ?? { depth: 0, column: 0, x: 0, y: 0 };
      return {
        record,
        depth: position.depth,
        column: position.column,
        position: { x: position.x, y: position.y },
        root: nodeId === rootId,
        expanded: visibleExpandedIds.has(nodeId),
        expandable: available.length > 0,
        totalRelations: available.length,
        visibleRelations,
        hiddenRelations: hidden,
      } satisfies RelationExplorerNode;
    })
    .sort((first, second) =>
      first.column - second.column ||
      first.position.y - second.position.y ||
      first.record.label.localeCompare(second.record.label, "zh-CN"));

  return {
    root,
    nodes,
    edges,
    expandedNodeIds: visibleExpandedIds,
    hiddenRelations,
    truncated: hiddenRelations > 0,
  };
}

