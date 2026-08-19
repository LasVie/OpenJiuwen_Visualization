import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";

export const subagentExecutorPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.subagent-executor",
    name: "Agent Core Subagent Executor",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过固定前台 TaskTool 桥接运行一个真实 child DeepAgent，并投影父子 ReAct、Rail、Tool 与独立 Context。",
    group: "jiuwenswarm",
    defaultEnabled: true,
    dependencies: [
      "openjiuwen.agent-core",
      "openjiuwen.jiuwenswarm",
      "openjiuwen.openrouter-provider",
    ],
    capabilities: ["runtime.subagent.execute.v1"],
  },
  contribute: () => ({}),
};
