import { loopbackHttpOrigin } from "../local-service/base-url";

export const OPENROUTER_PROVIDER_API_VERSION = "1.0.0" as const;
export const DEFAULT_OPENROUTER_PROVIDER_SERVER = "http://127.0.0.1:8765";

export interface OpenRouterProviderModel {
  id: string;
  label: string;
  default: boolean;
}

export interface OpenRouterProviderLimits {
  maxInputCharacters: number;
  maxSystemCharacters: number;
  minOutputTokens: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  maxActiveInvocations: number;
}

export interface OpenRouterProviderStatus {
  id: "openrouter";
  label: string;
  status: "ready" | "unconfigured";
  configured: boolean;
  protocol: string;
  credentialPolicy: "local-service-only";
  streaming: true;
  cancellation: true;
  usage: true;
  models: OpenRouterProviderModel[];
  defaultModelId: string;
  limits: OpenRouterProviderLimits;
  network: {
    origin: "https://openrouter.ai";
    endpoint: string;
  };
}

export interface OpenRouterInvocation {
  id: string;
  traceId: string;
  providerId: "openrouter";
  modelId: string;
  status: "accepted" | "cancelling";
  cancellationEndpoint?: string;
}

export interface StartOpenRouterInvocation {
  traceId: string;
  writeToken: string;
  modelId: string;
  input: string;
  systemPrompt?: string;
  maxOutputTokens: number;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function providerStatus(value: unknown): OpenRouterProviderStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== OPENROUTER_PROVIDER_API_VERSION ||
    !isRecord(value.provider)
  ) {
    throw new TypeError("OpenRouter provider registry does not match API version 1.0.0.");
  }
  const provider = value.provider;
  const models = provider.models;
  const limits = provider.limits;
  const network = provider.network;
  if (
    provider.id !== "openrouter" ||
    typeof provider.label !== "string" ||
    !["ready", "unconfigured"].includes(String(provider.status)) ||
    typeof provider.configured !== "boolean" ||
    provider.configured !== (provider.status === "ready") ||
    typeof provider.protocol !== "string" ||
    provider.credentialPolicy !== "local-service-only" ||
    provider.streaming !== true ||
    provider.cancellation !== true ||
    provider.usage !== true ||
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every((model) =>
      isRecord(model) &&
      typeof model.id === "string" &&
      typeof model.label === "string" &&
      typeof model.default === "boolean") ||
    typeof provider.defaultModelId !== "string" ||
    !models.some((model) => model.id === provider.defaultModelId) ||
    !isRecord(limits) ||
    !nonNegativeInteger(limits.maxInputCharacters) ||
    !nonNegativeInteger(limits.maxSystemCharacters) ||
    !nonNegativeInteger(limits.minOutputTokens) ||
    !nonNegativeInteger(limits.maxOutputTokens) ||
    !nonNegativeInteger(limits.defaultOutputTokens) ||
    !nonNegativeInteger(limits.maxActiveInvocations) ||
    !isRecord(network) ||
    network.origin !== "https://openrouter.ai" ||
    typeof network.endpoint !== "string"
  ) {
    throw new TypeError("OpenRouter provider registry has an invalid shape.");
  }
  return provider as unknown as OpenRouterProviderStatus;
}

function invocation(value: unknown): OpenRouterInvocation {
  if (
    !isRecord(value) ||
    value.apiVersion !== OPENROUTER_PROVIDER_API_VERSION ||
    !isRecord(value.invocation)
  ) {
    throw new TypeError("OpenRouter invocation does not match API version 1.0.0.");
  }
  const item = value.invocation;
  if (
    typeof item.id !== "string" ||
    typeof item.traceId !== "string" ||
    item.providerId !== "openrouter" ||
    typeof item.modelId !== "string" ||
    !["accepted", "cancelling"].includes(String(item.status)) ||
    (item.cancellationEndpoint !== undefined &&
      typeof item.cancellationEndpoint !== "string")
  ) {
    throw new TypeError("OpenRouter invocation response has an invalid shape.");
  }
  return item as unknown as OpenRouterInvocation;
}

export class OpenRouterProviderClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "OpenRouterProviderClientError";
  }
}

export class OpenRouterProviderClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_OPENROUTER_PROVIDER_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getStatus(signal?: AbortSignal): Promise<OpenRouterProviderStatus> {
    return providerStatus(await this.request(
      "/api/v1/model-providers/openrouter",
      { signal },
    ));
  }

  async startInvocation(
    options: StartOpenRouterInvocation,
    signal?: AbortSignal,
  ): Promise<OpenRouterInvocation> {
    if (!options.traceId || !options.writeToken || !options.input.trim()) {
      throw new TypeError("Trace authority and a non-empty OpenRouter input are required.");
    }
    return invocation(await this.request(
      "/api/v1/model-providers/openrouter/invocations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trace-Token": options.writeToken,
        },
        body: JSON.stringify({
          traceId: options.traceId,
          modelId: options.modelId,
          input: options.input,
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
          maxOutputTokens: options.maxOutputTokens,
        }),
        signal,
      },
    ));
  }

  async cancelInvocation(
    invocationId: string,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<OpenRouterInvocation> {
    if (!invocationId || !writeToken) {
      throw new TypeError("Invocation id and Trace authority are required.");
    }
    return invocation(await this.request(
      `/api/v1/model-providers/openrouter/invocations/${encodeURIComponent(invocationId)}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trace-Token": writeToken,
        },
        body: "{}",
        signal,
      },
    ));
  }

  private async request(path: string, init: RequestInit) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      cache: "no-store",
      ...init,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new OpenRouterProviderClientError(
        "本地服务返回了无效的 OpenRouter JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new OpenRouterProviderClientError(
        typeof error.message === "string" ? error.message : "OpenRouter 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
