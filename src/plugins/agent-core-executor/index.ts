import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";

export const agentCoreExecutorPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.agent-core-executor",
    name: "Agent Core Executor",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过隔离桥接执行真实 DeepAgent、ReAct、Rail 与只读 Tool，并投影 Runtime Trace。",
    group: "agent-core",
    defaultEnabled: true,
    dependencies: [
      "openjiuwen.agent-core",
      "openjiuwen.openrouter-provider",
    ],
    capabilities: ["runtime.agent-core.execute.v1"],
  },
  contribute: () => ({}),
};
