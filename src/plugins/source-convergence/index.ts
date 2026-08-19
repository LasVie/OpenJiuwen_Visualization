import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const sourceConvergencePlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.source-convergence",
    name: "Runtime Source Convergence",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "用稳定源码身份连接 Runtime、Definition 与 Change 证据。",
    group: "integration",
    defaultEnabled: true,
    dependencies: ["openjiuwen.local-repository"],
    capabilities: ["graph.cross-plane.source.v1"],
  },
  contribute: () => ({}),
};
