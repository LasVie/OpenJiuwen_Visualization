import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const localRepositoryPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.local-repository",
    name: "Local Repository",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过只读本地服务把 Python 仓库静态索引为定义图，并按需读取有界源码证据。",
    group: "workspace",
    defaultEnabled: true,
    capabilities: [
      "repository.local.read",
      "repository.source.read",
      "graph.definition.static",
    ],
  },
  contribute: () => ({}),
};
