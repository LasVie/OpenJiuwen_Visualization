export type DevelopmentAnalysisCapability =
  | "diagnosis"
  | "impact-analysis"
  | "change-plan"
  | "test-plan"
  | "patch-outline";

export interface DevelopmentAssistantSourceDefinition {
  id: string;
  label: string;
  description: string;
  engine: "deterministic-static";
  capabilities: readonly DevelopmentAnalysisCapability[];
  readOnly: true;
  repositoryWrite: false;
  modelAccess: false;
}

export interface RegisteredDevelopmentAssistantSource
  extends DevelopmentAssistantSourceDefinition {
  contributedBy: string;
}
