export const GRAPH_SCHEMA_VERSION = "1.0.0" as const;

export type GraphPlane = "definition" | "runtime" | "change";

export type GraphLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type GraphEvidenceProvenance =
  | "static"
  | "config"
  | "runtime"
  | "git"
  | "fixture";

export type GraphEvidenceConfidence =
  | "exact"
  | "inferred"
  | "runtime-confirmed";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface GraphSourceReference {
  repository: string;
  path: string;
  revision?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export interface GraphEvidence {
  provenance: GraphEvidenceProvenance;
  confidence: GraphEvidenceConfidence;
  source?: GraphSourceReference;
  note?: string;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphViewDescriptor {
  renderer: string;
  position?: GraphPosition;
  properties?: Readonly<Record<string, JsonValue>>;
}

export interface GraphNodeRecord {
  id: string;
  kind: string;
  plane: GraphPlane;
  level: GraphLevel;
  owner: string;
  label: string;
  summary: string;
  parentId?: string;
  expandable?: boolean;
  attributes?: Readonly<Record<string, JsonValue>>;
  evidence: readonly GraphEvidence[];
  views?: Readonly<Record<string, GraphViewDescriptor>>;
}

export interface GraphEdgeRecord {
  id: string;
  kind: string;
  plane: GraphPlane;
  source: string;
  target: string;
  label?: string;
  attributes?: Readonly<Record<string, JsonValue>>;
  evidence: readonly GraphEvidence[];
  views?: Readonly<Record<string, GraphViewDescriptor>>;
}

export interface GraphContribution {
  nodes?: readonly GraphNodeRecord[];
  edges?: readonly GraphEdgeRecord[];
}

export interface RegisteredGraphNode extends GraphNodeRecord {
  contributedBy: string;
}

export interface RegisteredGraphEdge extends GraphEdgeRecord {
  contributedBy: string;
}

export interface GraphSnapshot {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  nodes: readonly RegisteredGraphNode[];
  edges: readonly RegisteredGraphEdge[];
}
