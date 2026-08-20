import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const developmentAssistantPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.development-assistant",
    name: "Read-only Development Assistant",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "把开发意图投影为源码证据、影响范围、修改建议、测试建议与不可应用的补丁草案；不会修改绑定仓库。",
    group: "workspace",
    defaultEnabled: true,
    dependencies: ["openjiuwen.local-repository", "openjiuwen.source-convergence"],
    capabilities: [
      "development.analysis.readonly.v1",
      "graph.development.evidence.v1",
      "development.patch-outline.preview.v1",
    ],
  },
  contribute: () => ({
    developmentSources: [{
      id: "openjiuwen.deterministic-static-development",
      label: "Deterministic static development analysis",
      description: "基于当前 revision 的静态定义与关系证据生成只读开发建议。",
      engine: "deterministic-static",
      capabilities: [
        "diagnosis",
        "impact-analysis",
        "change-plan",
        "test-plan",
        "patch-outline",
      ],
      readOnly: true,
      repositoryWrite: false,
      modelAccess: false,
    }],
  }),
};
