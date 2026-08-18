import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";
import { jiuwenSwarmNodes } from "./definition-graph";

export const jiuwenSwarmPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.jiuwenswarm",
    name: "JiuWenSwarm Inspector",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供 Swarm 请求入口、会话边界和响应出口定义图。",
    defaultEnabled: true,
    capabilities: ["graph.definition.jiuwenswarm"],
  },
  contribute: () => ({
    graph: { nodes: jiuwenSwarmNodes },
  }),
};
