import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";

export const jiuwenSwarmExecutorPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.jiuwenswarm-executor",
    name: "JiuwenSwarm Agent Team Executor",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过固定隔离桥接运行真实 JiuwenSwarm Agent Team，并投影成员、任务、消息、Rail 与独立 Context。",
    group: "jiuwenswarm",
    defaultEnabled: true,
    dependencies: [
      "openjiuwen.jiuwenswarm",
      "openjiuwen.openrouter-provider",
    ],
    capabilities: ["runtime.jiuwenswarm.execute.v1"],
  },
  contribute: () => ({}),
};
