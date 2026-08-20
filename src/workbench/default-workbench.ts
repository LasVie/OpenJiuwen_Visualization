import { projectTraceGraph } from "../domain/trace/projection";
import { VisualizationPluginRegistry } from "../kernel";
import { agentCorePlugin } from "../plugins/agent-core";
import { agentCoreExecutorPlugin } from "../plugins/agent-core-executor";
import { deterministicReplayPlugin } from "../plugins/deterministic-replay";
import { jiuwenSwarmPlugin } from "../plugins/jiuwenswarm";
import { jiuwenSwarmExecutorPlugin } from "../plugins/jiuwenswarm-executor";
import { subagentExecutorPlugin } from "../plugins/subagent-executor";
import { swarmFlowExecutorPlugin } from "../plugins/swarmflow-executor";
import { localRepositoryPlugin } from "../plugins/local-repository";
import { gitChangePlugin } from "../plugins/git-change";
import { githubPullRequestPlugin } from "../plugins/github-pull-request";
import { modelProviderPlugin } from "../plugins/model-provider";
import { openRouterProviderPlugin } from "../plugins/openrouter-provider";
import { toolCatalogPlugin } from "../plugins/tool-catalog";
import { openJiuwenIntegrationPlugin } from "../plugins/openjiuwen-integration";
import { sourceConvergencePlugin } from "../plugins/source-convergence";
import { traceArchivePlugin } from "../plugins/trace-archive";
import { developmentAssistantPlugin } from "../plugins/development-assistant";

export function createDefaultPluginRegistry() {
  return new VisualizationPluginRegistry([
    agentCorePlugin,
    modelProviderPlugin,
    openRouterProviderPlugin,
    agentCoreExecutorPlugin,
    jiuwenSwarmPlugin,
    jiuwenSwarmExecutorPlugin,
    subagentExecutorPlugin,
    swarmFlowExecutorPlugin,
    openJiuwenIntegrationPlugin,
    deterministicReplayPlugin,
    traceArchivePlugin,
    localRepositoryPlugin,
    sourceConvergencePlugin,
    developmentAssistantPlugin,
    toolCatalogPlugin,
    gitChangePlugin,
    githubPullRequestPlugin,
  ]);
}

export const defaultWorkbench = createDefaultPluginRegistry().resolve();

export const defaultTraceGraph = projectTraceGraph(defaultWorkbench.graph);
