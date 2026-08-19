import { projectTraceGraph } from "../domain/trace/projection";
import { VisualizationPluginRegistry } from "../kernel";
import { agentCorePlugin } from "../plugins/agent-core";
import { deterministicReplayPlugin } from "../plugins/deterministic-replay";
import { jiuwenSwarmPlugin } from "../plugins/jiuwenswarm";
import { localRepositoryPlugin } from "../plugins/local-repository";
import { gitChangePlugin } from "../plugins/git-change";
import { githubPullRequestPlugin } from "../plugins/github-pull-request";
import { modelProviderPlugin } from "../plugins/model-provider";
import { openRouterProviderPlugin } from "../plugins/openrouter-provider";
import { toolCatalogPlugin } from "../plugins/tool-catalog";
import { openJiuwenIntegrationPlugin } from "../plugins/openjiuwen-integration";

export function createDefaultPluginRegistry() {
  return new VisualizationPluginRegistry([
    agentCorePlugin,
    modelProviderPlugin,
    openRouterProviderPlugin,
    jiuwenSwarmPlugin,
    openJiuwenIntegrationPlugin,
    deterministicReplayPlugin,
    localRepositoryPlugin,
    toolCatalogPlugin,
    gitChangePlugin,
    githubPullRequestPlugin,
  ]);
}

export const defaultWorkbench = createDefaultPluginRegistry().resolve();

export const defaultTraceGraph = projectTraceGraph(defaultWorkbench.graph);
