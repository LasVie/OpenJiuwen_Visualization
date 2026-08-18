import type { TraceScenario } from "./trace";
import type {
  RegisteredRuntimeSource,
  RegisteredRuntimeTraceRecording,
  RuntimeSourceDefinition,
  RuntimeTraceRecording,
} from "./runtime";
import type { GraphContribution, GraphSnapshot } from "./graph";
import type {
  ModelProviderDefinition,
  ModelRuntimeRecording,
  RegisteredModelProvider,
  RegisteredModelRuntimeRecording,
} from "./model-provider";
import type {
  GitChangeSourceDefinition,
  RegisteredGitChangeSource,
} from "./change";
import type {
  RegisteredToolCatalogSource,
  ToolCatalogSourceDefinition,
} from "./tool-catalog";

export const PLUGIN_API_VERSION = "1.0.0" as const;

export type VisualizationPluginGroup =
  | "agent-core"
  | "jiuwenswarm"
  | "integration"
  | "workspace";

export interface VisualizationPluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  description: string;
  group: VisualizationPluginGroup;
  defaultEnabled: boolean;
  dependencies?: readonly string[];
  capabilities: readonly string[];
}

export interface VisualizationPluginContribution {
  graph?: GraphContribution;
  scenarios?: readonly TraceScenario[];
  runtimeSources?: readonly RuntimeSourceDefinition[];
  runtimeRecordings?: readonly RuntimeTraceRecording[];
  modelProviders?: readonly ModelProviderDefinition[];
  modelRecordings?: readonly ModelRuntimeRecording[];
  changeSources?: readonly GitChangeSourceDefinition[];
  toolCatalogSources?: readonly ToolCatalogSourceDefinition[];
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
  description: string;
  group: VisualizationPluginGroup;
  state: PluginResolutionState;
  requestedEnabled: boolean;
  defaultEnabled: boolean;
  dependencies: readonly string[];
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
  runtimeRecordings: readonly RegisteredRuntimeTraceRecording[];
  modelProviders: readonly RegisteredModelProvider[];
  modelRecordings: readonly RegisteredModelRuntimeRecording[];
  changeSources: readonly RegisteredGitChangeSource[];
  toolCatalogSources: readonly RegisteredToolCatalogSource[];
  plugins: readonly ResolvedPluginStatus[];
  capabilities: Readonly<Record<string, readonly string[]>>;
}

export interface ResolvePluginOptions {
  pluginStates?: Readonly<Record<string, boolean>>;
}
