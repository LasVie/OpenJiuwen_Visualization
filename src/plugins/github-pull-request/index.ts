import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const githubPullRequestPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.github-pull-request",
    name: "GitHub PR Adapter",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过本地服务只读获取 GitHub PR 元数据与文件 patch，并投影到当前本地源码节点。",
    group: "workspace",
    defaultEnabled: true,
    dependencies: ["openjiuwen.local-repository"],
    capabilities: ["github.pull-request.read", "graph.change.github-pr.v1"],
  },
  contribute: () => ({
    changeSources: [
      {
        id: "openjiuwen.github-pull-request",
        label: "GitHub pull request",
        description: "远程只读读取 PR；本地映射不会 fetch、checkout、写 refs 或修改 GitHub。",
        transport: "loopback-http",
        modes: ["github-pr"],
        readOnly: true,
        remoteFetch: true,
      },
    ],
  }),
};
