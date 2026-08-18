import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";
import { agentCoreEdges, agentCoreNodes } from "./definition-graph";

export const agentCorePlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.agent-core",
    name: "Agent Core Inspector",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供 DeepAgent、ReAct、Context、Model、Tool 与 Rail 定义图。",
    defaultEnabled: true,
    capabilities: ["graph.definition.agent-core", "graph.rail"],
  },
  contribute: () => ({
    graph: {
      nodes: agentCoreNodes,
      edges: agentCoreEdges,
    },
  }),
};
