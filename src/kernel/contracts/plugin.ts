import type { TraceScenario } from "./trace";
import type { RegisteredRuntimeSource, RuntimeSourceDefinition } from "./runtime";
import type { GraphContribution, GraphSnapshot } from "./graph";

export const PLUGIN_API_VERSION = "1.0.0" as const;

export interface VisualizationPluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  description: string;
  defaultEnabled: boolean;
  dependencies?: readonly string[];
  capabilities: readonly string[];
}

export interface VisualizationPluginContribution {
  graph?: GraphContribution;
  scenarios?: readonly TraceScenario[];
  runtimeSources?: readonly RuntimeSourceDefinition[];
}

export interface VisualizationPlugin {
  manifest: VisualizationPluginManifest;
  contribute: () => VisualizationPluginContribution;
}

export type PluginResolutionState = "enabled" | "disabled" | "blocked";

export interface ResolvedPluginStatus {
  id: string;
  name: string;
  version: string;
  state: PluginResolutionState;
  reason?: string;
  capabilities: readonly string[];
}

export interface RegisteredTraceScenario extends TraceScenario {
  contributedBy: string;
}

export interface WorkbenchSnapshot {
  pluginApiVersion: typeof PLUGIN_API_VERSION;
  graph: GraphSnapshot;
  scenarios: readonly RegisteredTraceScenario[];
  runtimeSources: readonly RegisteredRuntimeSource[];
  plugins: readonly ResolvedPluginStatus[];
  capabilities: Readonly<Record<string, readonly string[]>>;
}

export interface ResolvePluginOptions {
  pluginStates?: Readonly<Record<string, boolean>>;
}
