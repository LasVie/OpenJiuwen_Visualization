import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";

export const swarmFlowExecutorPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.swarmflow-executor",
    name: "Agent Core SwarmFlow Executor",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "运行固定两阶段 SwarmFlow，并投影 Workflow、Phase、临时 Worker、Rail 与独立 Context。",
    group: "integration",
    defaultEnabled: true,
    dependencies: [
      "openjiuwen.agent-core",
      "openjiuwen.jiuwenswarm",
      "openjiuwen.openrouter-provider",
    ],
    capabilities: ["runtime.swarmflow.execute.v1"],
  },
  contribute: () => ({}),
};
