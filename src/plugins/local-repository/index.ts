import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const localRepositoryPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.local-repository",
    name: "Local Repository",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过只读本地服务把 Python 仓库静态索引为定义图。",
    group: "workspace",
    defaultEnabled: true,
    capabilities: ["repository.local.read", "graph.definition.static"],
  },
  contribute: () => ({}),
};
