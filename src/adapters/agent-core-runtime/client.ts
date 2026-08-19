import { loopbackHttpOrigin } from "../local-service/base-url";

export const AGENT_CORE_RUNTIME_API_VERSION = "1.0.0" as const;
export const DEFAULT_AGENT_CORE_RUNTIME_SERVER = "http://127.0.0.1:8765";

export interface AgentCoreRuntimeModel {
  id: string;
  label: string;
  default: boolean;
}

export interface AgentCoreRuntimeStatus {
  id: "agent-core-deep-agent";
  label: string;
  status: "ready" | "unconfigured" | "unavailable";
  configured: boolean;
  protocol: string;
  entrypoint: "openjiuwen.harness.create_deep_agent";
  executionIsolation: "fixed-subprocess";
  credentialPolicy: "local-service-only";
  providerId: "openrouter";
  streaming: true;
  cancellation: true;
  reactLoop: true;
  rails: true;
  tools: Array<{
    id: string;
    label: string;
    policy: "read-only-allowlist";
  }>;
  models: AgentCoreRuntimeModel[];
  defaultModelId: string;
  limits: {
    maxInputCharacters: number;
    maxSystemCharacters: number;
    minOutputTokens: number;
    maxOutputTokens: number;
    defaultOutputTokens: number;
    maxIterations: number;
    maxActiveInvocations: number;
  };
  diagnostic: { code: string; message: string };
  frameworkVersion?: string;
}

export interface AgentCoreInvocation {
  id: string;
  traceId: string;
  runtimeId: "agent-core-deep-agent";
  providerId: "openrouter";
  modelId: string;
  status: "accepted" | "cancelling";
  cancellationEndpoint?: string;
}

export interface StartAgentCoreInvocation {
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

function runtimeStatus(value: unknown): AgentCoreRuntimeStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== AGENT_CORE_RUNTIME_API_VERSION ||
    !isRecord(value.runtime)
  ) {
    throw new TypeError("Agent Core runtime registry does not match API version 1.0.0.");
  }
  const runtime = value.runtime;
  const models = runtime.models;
  const tools = runtime.tools;
  const limits = runtime.limits;
  const diagnostic = runtime.diagnostic;
  if (
    runtime.id !== "agent-core-deep-agent" ||
    typeof runtime.label !== "string" ||
    !["ready", "unconfigured", "unavailable"].includes(String(runtime.status)) ||
    typeof runtime.configured !== "boolean" ||
    runtime.configured !== (runtime.status === "ready") ||
    typeof runtime.protocol !== "string" ||
    runtime.entrypoint !== "openjiuwen.harness.create_deep_agent" ||
    runtime.executionIsolation !== "fixed-subprocess" ||
    runtime.credentialPolicy !== "local-service-only" ||
    runtime.providerId !== "openrouter" ||
    runtime.streaming !== true ||
    runtime.cancellation !== true ||
    runtime.reactLoop !== true ||
    runtime.rails !== true ||
    !Array.isArray(tools) ||
    !tools.every((tool) =>
      isRecord(tool) &&
      typeof tool.id === "string" &&
      typeof tool.label === "string" &&
      tool.policy === "read-only-allowlist") ||
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every((model) =>
      isRecord(model) &&
      typeof model.id === "string" &&
      typeof model.label === "string" &&
      typeof model.default === "boolean") ||
    typeof runtime.defaultModelId !== "string" ||
    !models.some((model) => isRecord(model) && model.id === runtime.defaultModelId) ||
    !isRecord(limits) ||
    !nonNegativeInteger(limits.maxInputCharacters) ||
    !nonNegativeInteger(limits.maxSystemCharacters) ||
    !nonNegativeInteger(limits.minOutputTokens) ||
    !nonNegativeInteger(limits.maxOutputTokens) ||
    !nonNegativeInteger(limits.defaultOutputTokens) ||
    !nonNegativeInteger(limits.maxIterations) ||
    !nonNegativeInteger(limits.maxActiveInvocations) ||
    !isRecord(diagnostic) ||
    typeof diagnostic.code !== "string" ||
    typeof diagnostic.message !== "string" ||
    (runtime.frameworkVersion !== undefined && typeof runtime.frameworkVersion !== "string")
  ) {
    throw new TypeError("Agent Core runtime registry has an invalid shape.");
  }
  return runtime as unknown as AgentCoreRuntimeStatus;
}

function invocation(value: unknown): AgentCoreInvocation {
  if (
    !isRecord(value) ||
    value.apiVersion !== AGENT_CORE_RUNTIME_API_VERSION ||
    !isRecord(value.invocation)
  ) {
    throw new TypeError("Agent Core invocation does not match API version 1.0.0.");
  }
  const item = value.invocation;
  if (
    typeof item.id !== "string" ||
    typeof item.traceId !== "string" ||
    item.runtimeId !== "agent-core-deep-agent" ||
    item.providerId !== "openrouter" ||
    typeof item.modelId !== "string" ||
    !["accepted", "cancelling"].includes(String(item.status)) ||
    (item.cancellationEndpoint !== undefined && typeof item.cancellationEndpoint !== "string")
  ) {
    throw new TypeError("Agent Core invocation response has an invalid shape.");
  }
  return item as unknown as AgentCoreInvocation;
}

export class AgentCoreRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AgentCoreRuntimeClientError";
  }
}

export class AgentCoreRuntimeClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_AGENT_CORE_RUNTIME_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getStatus(signal?: AbortSignal, refresh = false): Promise<AgentCoreRuntimeStatus> {
    return runtimeStatus(await this.request(
      `/api/v1/agent-core${refresh ? "?refresh=1" : ""}`,
      { signal },
    ));
  }

  async startInvocation(
    options: StartAgentCoreInvocation,
    signal?: AbortSignal,
  ): Promise<AgentCoreInvocation> {
    if (!options.traceId || !options.writeToken || !options.input.trim()) {
      throw new TypeError("Trace authority and a non-empty Agent Core input are required.");
    }
    return invocation(await this.request(
      "/api/v1/agent-core/invocations",
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
  ): Promise<AgentCoreInvocation> {
    if (!invocationId || !writeToken) {
      throw new TypeError("Invocation id and Trace authority are required.");
    }
    return invocation(await this.request(
      `/api/v1/agent-core/invocations/${encodeURIComponent(invocationId)}/cancel`,
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
      throw new AgentCoreRuntimeClientError(
        "本地服务返回了无效的 Agent Core JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new AgentCoreRuntimeClientError(
        typeof error.message === "string" ? error.message : "Agent Core 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
