import type {
  GraphSnapshot,
  RegisteredGraphEdge,
  RegisteredGraphNode,
} from "../../kernel";

export const DEFINITION_PAGE_SIZE = 16;

export interface DefinitionGraphIndex {
  graph: GraphSnapshot;
  nodesById: ReadonlyMap<string, RegisteredGraphNode>;
  childrenByParent: ReadonlyMap<string, readonly RegisteredGraphNode[]>;
  incomingByNode: ReadonlyMap<string, readonly RegisteredGraphEdge[]>;
  outgoingByNode: ReadonlyMap<string, readonly RegisteredGraphEdge[]>;
  roots: readonly RegisteredGraphNode[];
}

export interface DefinitionViewport {
  focus: RegisteredGraphNode;
  members: readonly RegisteredGraphNode[];
  edges: readonly RegisteredGraphEdge[];
  mode: "children" | "relations";
  page: number;
  pageCount: number;
  totalMembers: number;
  hiddenMembers: number;
}

const kindOrder = new Map([
  ["repository", 0],
  ["package", 1],
  ["module", 2],
  ["agent", 3],
  ["rail", 4],
  ["workflow", 5],
  ["team", 6],
  ["context", 7],
  ["tool", 8],
  ["model", 9],
  ["class", 10],
  ["function", 11],
]);

function compareNodes(first: RegisteredGraphNode, second: RegisteredGraphNode) {
  const kindDifference =
    (kindOrder.get(first.kind) ?? 99) - (kindOrder.get(second.kind) ?? 99);
  if (kindDifference !== 0) return kindDifference;
  return first.label.localeCompare(second.label, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function pushMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

export function createDefinitionGraphIndex(
  graph: GraphSnapshot,
): DefinitionGraphIndex {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, RegisteredGraphNode[]>();
  const incomingByNode = new Map<string, RegisteredGraphEdge[]>();
  const outgoingByNode = new Map<string, RegisteredGraphEdge[]>();

  graph.nodes.forEach((node) => {
    if (node.parentId) pushMapValue(childrenByParent, node.parentId, node);
  });
  graph.edges.forEach((edge) => {
    pushMapValue(outgoingByNode, edge.source, edge);
    pushMapValue(incomingByNode, edge.target, edge);
  });
  childrenByParent.forEach((children) => children.sort(compareNodes));

  const roots = graph.nodes
    .filter((node) => !node.parentId || !nodesById.has(node.parentId))
    .sort(compareNodes);
  return {
    graph,
    nodesById,
    childrenByParent,
    incomingByNode,
    outgoingByNode,
    roots,
  };
}

export function definitionBreadcrumb(
  index: DefinitionGraphIndex,
  nodeId: string,
): RegisteredGraphNode[] {
  const path: RegisteredGraphNode[] = [];
  const visited = new Set<string>();
  let current = index.nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId
      ? index.nodesById.get(current.parentId)
      : undefined;
  }
  return path;
}

function relationMembers(
  index: DefinitionGraphIndex,
  focusId: string,
): RegisteredGraphNode[] {
  const relatedIds = new Set<string>();
  const edges = [
    ...(index.incomingByNode.get(focusId) ?? []),
    ...(index.outgoingByNode.get(focusId) ?? []),
  ];
  edges.forEach((edge) => {
    if (edge.kind === "contains") return;
    relatedIds.add(edge.source === focusId ? edge.target : edge.source);
  });
  return [...relatedIds]
    .map((nodeId) => index.nodesById.get(nodeId))
    .filter((node): node is RegisteredGraphNode => Boolean(node))
    .sort(compareNodes);
}

export function projectDefinitionViewport(
  index: DefinitionGraphIndex,
  focusId: string,
  options: {
    kind?: string;
    page?: number;
    pageSize?: number;
  } = {},
): DefinitionViewport {
  const focus = index.nodesById.get(focusId) ?? index.roots[0];
  if (!focus) throw new Error("Definition graph has no root node.");

  const children = index.childrenByParent.get(focus.id) ?? [];
  const mode = children.length > 0 ? "children" : "relations";
  const candidates = mode === "children" ? children : relationMembers(index, focus.id);
  const filtered =
    options.kind && options.kind !== "all"
      ? candidates.filter((node) => node.kind === options.kind)
      : candidates;
  const pageSize = Math.max(1, options.pageSize ?? DEFINITION_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pageCount - 1, Math.max(0, options.page ?? 0));
  const members = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const visibleIds = new Set([focus.id, ...members.map((node) => node.id)]);
  const edges = index.graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );

  return {
    focus,
    members,
    edges,
    mode,
    page,
    pageCount,
    totalMembers: filtered.length,
    hiddenMembers: Math.max(0, filtered.length - members.length),
  };
}

function sourceText(node: RegisteredGraphNode) {
  const source = node.evidence[0]?.source;
  return [source?.path, source?.symbol].filter(Boolean).join(" ");
}

export function searchDefinitionNodes(
  index: DefinitionGraphIndex,
  rawQuery: string,
  limit = 30,
): RegisteredGraphNode[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];

  return index.graph.nodes
    .map((node) => {
      const label = node.label.toLocaleLowerCase();
      const kind = node.kind.toLocaleLowerCase();
      const source = sourceText(node).toLocaleLowerCase();
      const summary = node.summary.toLocaleLowerCase();
      let score = 0;
      if (label === query) score += 120;
      else if (label.startsWith(query)) score += 80;
      else if (label.includes(query)) score += 55;
      if (kind === query) score += 35;
      if (source.includes(query)) score += 24;
      if (summary.includes(query)) score += 8;
      return { node, score };
    })
    .filter((result) => result.score > 0)
    .sort(
      (first, second) =>
        second.score - first.score || compareNodes(first.node, second.node),
    )
    .slice(0, Math.max(1, limit))
    .map((result) => result.node);
}

export function definitionKinds(index: DefinitionGraphIndex) {
  return [...new Set(index.graph.nodes.map((node) => node.kind))].sort(
    (first, second) =>
      (kindOrder.get(first) ?? 99) - (kindOrder.get(second) ?? 99) ||
      first.localeCompare(second),
  );
}
