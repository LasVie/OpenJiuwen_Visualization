export const MODEL_PROVIDER_SCHEMA_VERSION = "1.0.0" as const;

export type ModelProviderAdapterMode =
  | "recording-replay"
  | "local-service";

export interface ModelProviderCapabilities {
  streaming: boolean;
  usage: boolean;
  cancellation: boolean;
  deterministicReplay: boolean;
}

/**
 * Declares an adapter boundary, not a credential-bearing browser client.
 * Live adapters must keep provider credentials inside the loopback service.
 */
export interface ModelProviderDefinition {
  id: string;
  label: string;
  description: string;
  protocol: string;
  mode: ModelProviderAdapterMode;
  credentialPolicy: "none" | "local-service-only";
  capabilities: ModelProviderCapabilities;
}

export interface RegisteredModelProvider extends ModelProviderDefinition {
  contributedBy: string;
}

export interface ModelRuntimeRecording {
  id: string;
  label: string;
  description: string;
  maxTokens: number;
  events: readonly RuntimeTraceEventInput[];
}

export interface RegisteredModelRuntimeRecording extends ModelRuntimeRecording {
  contributedBy: string;
}
import type { RuntimeTraceEventInput } from "./runtime";
