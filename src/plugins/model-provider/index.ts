import {
  PLUGIN_API_VERSION,
  type VisualizationPlugin,
} from "../../kernel";
import { streamAndCancelRecording } from "./recordings/stream-and-cancel";

export const modelProviderPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.model-provider",
    name: "Model Provider",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供厂商无关的模型流、用量、取消与确定性录制回放合同。",
    defaultEnabled: true,
    dependencies: ["openjiuwen.agent-core"],
    capabilities: [
      "runtime.model.observation.v1",
      "runtime.model.recording.v1",
    ],
  },
  contribute: () => ({
    modelProviders: [
      {
        id: "openjiuwen.recording-replay",
        label: "Normalized recording replay",
        description: "从已归一化事件重放模型流，不调用模型 API，也不读取凭据。",
        protocol: "openjiuwen.runtime-model/1.0",
        mode: "recording-replay",
        credentialPolicy: "none",
        capabilities: {
          streaming: true,
          usage: true,
          cancellation: true,
          deterministicReplay: true,
        },
      },
    ],
    modelRecordings: [streamAndCancelRecording],
  }),
};
