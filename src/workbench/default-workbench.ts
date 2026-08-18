import { projectTraceGraph } from "../domain/trace/projection";
import { VisualizationPluginRegistry } from "../kernel";
import { agentCorePlugin } from "../plugins/agent-core";
import { deterministicReplayPlugin } from "../plugins/deterministic-replay";
import { jiuwenSwarmPlugin } from "../plugins/jiuwenswarm";
import { openJiuwenIntegrationPlugin } from "../plugins/openjiuwen-integration";

export function createDefaultPluginRegistry() {
  return new VisualizationPluginRegistry([
    agentCorePlugin,
    jiuwenSwarmPlugin,
    openJiuwenIntegrationPlugin,
    deterministicReplayPlugin,
  ]);
}

export const defaultWorkbench = createDefaultPluginRegistry().resolve();

export const defaultTraceGraph = projectTraceGraph(defaultWorkbench.graph);
