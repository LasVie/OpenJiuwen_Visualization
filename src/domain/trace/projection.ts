import type {
  GraphSnapshot,
  JsonValue,
  RegisteredGraphEdge,
  RegisteredGraphNode,
} from "../../kernel";
import { TRACE_FLOW_VIEW_ID } from "../../kernel";
import type {
  HookDefinition,
  RuntimeOwner,
  TraceEdgeDefinition,
  TraceNodeDefinition,
  TraceNodeKind,
} from "../../types/trace";

const TRACE_NODE_KINDS = new Set<TraceNodeKind>([
  "input",
  "agent",
  "loop",
  "context",
  "model",
  "decision",
  "tool",
  "output",
]);

function stringValue(value: JsonValue | undefined, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function runtimeOwner(value: string): RuntimeOwner {
  if (value === "agent-core" || value === "jiuwenswarm") return value;
  throw new Error(`Trace projection does not support owner "${value}".`);
}

function sourceLocation(node: RegisteredGraphNode) {
  return node.evidence.find((item) => item.source)?.source?.path ?? "unknown";
}

function hookDefinitions(value: JsonValue | undefined): HookDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const event = item.event;
    const priority = item.priority;
    const namespace = item.namespace;
    if (
      typeof event !== "string" ||
      typeof priority !== "number" ||
      (namespace !== "outer" && namespace !== "inner")
    ) {
      return [];
    }
    return [{ event, priority, namespace }];
  });
}

function projectNode(node: RegisteredGraphNode): TraceNodeDefinition | null {
  const view = node.views?.[TRACE_FLOW_VIEW_ID];
  if (!view?.position) return null;
  const subtitle = stringValue(view.properties?.subtitle);
  const owner = runtimeOwner(node.owner);

  if (view.renderer === "stage") {
    if (!TRACE_NODE_KINDS.has(node.kind as TraceNodeKind)) {
      throw new Error(`Node "${node.id}" has unsupported trace kind "${node.kind}".`);
    }
    const accent = view.properties?.accent;
    return {
      id: node.id,
      type: "stage",
      position: view.position,
      label: node.label,
      subtitle,
      kind: node.kind as TraceNodeKind,
      description: node.summary,
      sourceLocation: sourceLocation(node),
      owner,
      accent:
        accent === "signal" || accent === "context" || accent === "fault"
          ? accent
          : undefined,
    };
  }

  if (view.renderer === "rail") {
    const lifecycle = node.attributes?.lifecycle;
    return {
      id: node.id,
      type: "rail",
      position: view.position,
      label: node.label,
      subtitle,
      description: node.summary,
      sourceLocation: sourceLocation(node),
      owner,
      hooks: hookDefinitions(node.attributes?.hooks),
      lifecycle:
        lifecycle === "init" || lifecycle === "runtime"
          ? lifecycle
          : undefined,
    };
  }

  return null;
}

function projectEdge(edge: RegisteredGraphEdge): TraceEdgeDefinition | null {
  if (!edge.views?.[TRACE_FLOW_VIEW_ID]) return null;
  if (edge.kind !== "causal" && edge.kind !== "rail") {
    throw new Error(`Edge "${edge.id}" has unsupported trace kind "${edge.kind}".`);
  }
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: stringValue(edge.attributes?.sourceHandle) || undefined,
    targetHandle: stringValue(edge.attributes?.targetHandle) || undefined,
    label: edge.label,
    kind: edge.kind,
  };
}

export function projectTraceGraph(graph: GraphSnapshot): {
  nodes: TraceNodeDefinition[];
  edges: TraceEdgeDefinition[];
} {
  return {
    nodes: graph.nodes.flatMap((node) => {
      const projected = projectNode(node);
      return projected ? [projected] : [];
    }),
    edges: graph.edges.flatMap((edge) => {
      const projected = projectEdge(edge);
      return projected ? [projected] : [];
    }),
  };
}
