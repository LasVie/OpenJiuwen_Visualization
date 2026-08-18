import type {
  GraphEdgeRecord,
  GraphLevel,
  GraphNodeRecord,
  GraphPosition,
  JsonValue,
} from "../../kernel";
import { TRACE_FLOW_VIEW_ID } from "../../kernel";

interface FixtureNodeInput {
  id: string;
  kind: string;
  level: GraphLevel;
  owner: string;
  label: string;
  summary: string;
  repository: string;
  path: string;
  symbol?: string;
  position: GraphPosition;
  renderer: "stage" | "rail";
  subtitle: string;
  parentId?: string;
  expandable?: boolean;
  attributes?: Readonly<Record<string, JsonValue>>;
  viewProperties?: Readonly<Record<string, JsonValue>>;
}

interface FixtureEdgeInput {
  id: string;
  kind: "causal" | "rail";
  source: string;
  target: string;
  label?: string;
  repository: string;
  path: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export function fixtureNode(input: FixtureNodeInput): GraphNodeRecord {
  return {
    id: input.id,
    kind: input.kind,
    plane: "definition",
    level: input.level,
    owner: input.owner,
    label: input.label,
    summary: input.summary,
    parentId: input.parentId,
    expandable: input.expandable,
    attributes: input.attributes,
    evidence: [
      {
        provenance: "fixture",
        confidence: "inferred",
        source: {
          repository: input.repository,
          path: input.path,
          symbol: input.symbol,
        },
      },
    ],
    views: {
      [TRACE_FLOW_VIEW_ID]: {
        renderer: input.renderer,
        position: input.position,
        properties: {
          subtitle: input.subtitle,
          ...input.viewProperties,
        },
      },
    },
  };
}

export function fixtureEdge(input: FixtureEdgeInput): GraphEdgeRecord {
  return {
    id: input.id,
    kind: input.kind,
    plane: "definition",
    source: input.source,
    target: input.target,
    label: input.label,
    attributes: {
      ...(input.sourceHandle ? { sourceHandle: input.sourceHandle } : {}),
      ...(input.targetHandle ? { targetHandle: input.targetHandle } : {}),
    },
    evidence: [
      {
        provenance: "fixture",
        confidence: "inferred",
        source: {
          repository: input.repository,
          path: input.path,
        },
      },
    ],
    views: {
      [TRACE_FLOW_VIEW_ID]: {
        renderer: "trace",
      },
    },
  };
}
