export const TOOL_CATALOG_SCHEMA_VERSION = "1.0.0" as const;

export type ToolDefinitionKind =
  | "decorated-function"
  | "tool-class"
  | "tool-card";

export type ToolRegistrationMechanism =
  | "ability-card"
  | "ability-resource"
  | "resource-manager"
  | "ownership-helper";

export type ToolRegistrationConfidence = "exact" | "inferred" | "dynamic";

export interface ToolCatalogSourceReference {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
}

export interface ToolCardMetadata {
  description: string;
  exposure: "direct" | "deferred" | "unknown";
  stateless: boolean | null;
  parallelSafe: boolean | null;
  idempotent: boolean | null;
  parameters: readonly string[];
  nameSource: "literal" | "symbol";
}

export interface ToolDefinitionRecord {
  id: string;
  name: string;
  symbol: string;
  kind: ToolDefinitionKind;
  owner: string;
  summary: string;
  source: ToolCatalogSourceReference;
  card: ToolCardMetadata;
  registrationSiteIds: readonly string[];
}

export interface ToolRegistrationSiteRecord {
  id: string;
  mechanism: ToolRegistrationMechanism;
  callee: string;
  container: string;
  targetExpression: string;
  candidateNames: readonly string[];
  resolvedToolIds: readonly string[];
  confidence: ToolRegistrationConfidence;
  source: ToolCatalogSourceReference;
}

export interface ToolCatalogStatistics {
  pythonFiles: number;
  tools: number;
  registrationSites: number;
  linkedRegistrations: number;
  dynamicRegistrations: number;
  durationMs: number;
  truncated: boolean;
}

export interface ToolCatalogSourceDefinition {
  id: string;
  label: string;
  description: string;
  transport: "loopback-http";
  scanMode: "python-ast";
  runtimeEventKind: "ability.register";
  readOnly: true;
  importsTargetCode: false;
}

export interface RegisteredToolCatalogSource extends ToolCatalogSourceDefinition {
  contributedBy: string;
}

export interface RuntimeToolRegistration {
  id: string;
  name: string;
  abilityType: string;
  ownerId?: string;
  source?: string;
  sequence: number;
  timestampMs: number;
}
