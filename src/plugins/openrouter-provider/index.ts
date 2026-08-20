import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";

export const openRouterProviderPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.openrouter-provider",
    name: "OpenRouter Provider",
    version: "0.2.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "通过本地服务安全调用 OpenRouter，并把流、用量与取消写入 Runtime Trace。",
    group: "agent-core",
    defaultEnabled: true,
    dependencies: ["openjiuwen.model-provider"],
    capabilities: [
      "runtime.model.openrouter.v1",
      "development.enhancement.readonly.v1",
    ],
  },
  contribute: () => ({
    modelProviders: [
      {
        id: "openrouter",
        label: "OpenRouter",
        description: "服务端持有凭据的 OpenRouter Chat Completions 流式 adapter。",
        protocol: "openrouter.chat-completions/1.0",
        mode: "local-service",
        credentialPolicy: "local-service-only",
        capabilities: {
          streaming: true,
          usage: true,
          cancellation: true,
          deterministicReplay: false,
        },
      },
    ],
  }),
};
