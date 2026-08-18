import {
  CORE_RUNTIME_EVENT_KINDS,
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";
import { agentCoreEdges, agentCoreNodes } from "./definition-graph";

export const agentCorePlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.agent-core",
    name: "Agent Core Inspector",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供 DeepAgent、ReAct、Context、Model、Tool 与 Rail 定义图。",
    group: "agent-core",
    defaultEnabled: true,
    capabilities: [
      "graph.definition.agent-core",
      "graph.rail",
      "trace.runtime.agent-core",
    ],
  },
  contribute: () => ({
    graph: {
      nodes: agentCoreNodes,
      edges: agentCoreEdges,
    },
    runtimeSources: [
      {
        id: "openjiuwen.agent-core.runtime",
        owner: "agent-core",
        label: "Core Runtime",
        description: "通过本机内存 Trace 会话接收 Agent、Rail、Context、Model 与 Tool 事件。",
        transport: "loopback-sse",
        eventKinds: CORE_RUNTIME_EVENT_KINDS,
      },
    ],
  }),
};
