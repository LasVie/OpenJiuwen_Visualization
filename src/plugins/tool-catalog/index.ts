import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const toolCatalogPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.tool-catalog",
    name: "Registered Tools Catalog",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供 Tool 声明、静态注册路径与 ability.register 运行确认视图。",
    group: "workspace",
    defaultEnabled: true,
    dependencies: ["openjiuwen.local-repository"],
    capabilities: [
      "repository.tools.static.read",
      "runtime.ability.register.observe",
      "graph.definition.tool-registry.v1",
    ],
  },
  contribute: () => ({
    toolCatalogSources: [
      {
        id: "openjiuwen.local-tool-catalog",
        label: "Local Tool registry catalog",
        description: "只读解析 @tool、ToolCard 与注册调用；不会导入或执行目标仓代码。",
        transport: "loopback-http",
        scanMode: "python-ast",
        runtimeEventKind: "ability.register",
        readOnly: true,
        importsTargetCode: false,
      },
    ],
  }),
};
