import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const gitChangePlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.git-change",
    name: "Git Change Plane",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供工作树、commit range 与本地 PR refs 的只读变更和节点影响映射。",
    defaultEnabled: true,
    dependencies: ["openjiuwen.local-repository"],
    capabilities: ["git.change.local.read", "graph.change.impact.v1"],
  },
  contribute: () => ({
    changeSources: [
      {
        id: "openjiuwen.local-git-change",
        label: "Local Git comparison",
        description: "只比较本地已有工作树、commit 与 refs；不会 fetch、checkout 或写入 Git。",
        transport: "loopback-http",
        modes: ["working-tree", "compare"],
        readOnly: true,
        remoteFetch: false,
      },
    ],
  }),
};
