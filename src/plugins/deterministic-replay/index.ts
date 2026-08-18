import { compression } from "../../data/scenarios/context-compression";
import { directResponse } from "../../data/scenarios/direct-response";
import { guardrailRetry } from "../../data/scenarios/guardrail-retry";
import { toolLoop } from "../../data/scenarios/tool-loop";
import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const deterministicReplayPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.deterministic-replay",
    name: "Deterministic Replay",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供无需模型网络调用即可重复播放的确定性轨迹。",
    defaultEnabled: true,
    dependencies: ["openjiuwen.integration"],
    capabilities: ["trace.fixture", "trace.replay"],
  },
  contribute: () => ({
    scenarios: [toolLoop, directResponse, compression, guardrailRetry],
  }),
};
