import { loopbackHttpOrigin } from "../local-service/base-url";
import {
  runtimeManagedEnvironmentStatus,
  type RuntimeManagedEnvironmentStatus,
} from "../local-environments";

export const JIUWENSWARM_RUNTIME_API_VERSION = "1.0.0" as const;
export const DEFAULT_JIUWENSWARM_RUNTIME_SERVER = "http://127.0.0.1:8765";

export interface JiuwenSwarmRuntimeModel {
  id: string;
  label: string;
  default: boolean;
}

export interface JiuwenSwarmRuntimeStatus {
  id: "jiuwenswarm-agent-team";
  label: string;
  status: "ready" | "unconfigured" | "unavailable";
  configured: boolean;
  protocol: string;
  entrypoint: "jiuwenswarm.agents.swarm.enrich_team_spec_for_swarm";
  executionIsolation: "fixed-subprocess";
  credentialPolicy: "local-service-only";
  providerId: "openrouter";
  profile: "predefined-two-member";
  teamMode: "predefined";
  dispatchMode: "scheduled";
  spawnMode: "inprocess";
  swarmFlow: false;
  streaming: true;
  cancellation: true;
  contextOwnership: "per-member";
  tools: Array<{
    id: string;
    label: string;
    policy: "team-only" | "self-only";
  }>;
  models: JiuwenSwarmRuntimeModel[];
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
  managedEnvironment: RuntimeManagedEnvironmentStatus;
  frameworkVersion?: string;
}

export interface JiuwenSwarmInvocation {
  id: string;
  traceId: string;
  runtimeId: "jiuwenswarm-agent-team";
  providerId: "openrouter";
  modelId: string;
  teamName: string;
  sessionId: string;
  status: "accepted" | "cancelling";
  cancellationEndpoint?: string;
}

export interface StartJiuwenSwarmInvocation {
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

function runtimeStatus(value: unknown): JiuwenSwarmRuntimeStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== JIUWENSWARM_RUNTIME_API_VERSION ||
    !isRecord(value.runtime)
  ) {
    throw new TypeError("JiuwenSwarm runtime registry does not match API version 1.0.0.");
  }
  const runtime = value.runtime;
  const models = runtime.models;
  const tools = runtime.tools;
  const limits = runtime.limits;
  const diagnostic = runtime.diagnostic;
  if (
    runtime.id !== "jiuwenswarm-agent-team" ||
    typeof runtime.label !== "string" ||
    !["ready", "unconfigured", "unavailable"].includes(String(runtime.status)) ||
    typeof runtime.configured !== "boolean" ||
    runtime.configured !== (runtime.status === "ready") ||
    typeof runtime.protocol !== "string" ||
    runtime.entrypoint !== "jiuwenswarm.agents.swarm.enrich_team_spec_for_swarm" ||
    runtime.executionIsolation !== "fixed-subprocess" ||
    runtime.credentialPolicy !== "local-service-only" ||
    runtime.providerId !== "openrouter" ||
    runtime.profile !== "predefined-two-member" ||
    runtime.teamMode !== "predefined" ||
    runtime.dispatchMode !== "scheduled" ||
    runtime.spawnMode !== "inprocess" ||
    runtime.swarmFlow !== false ||
    runtime.streaming !== true ||
    runtime.cancellation !== true ||
    runtime.contextOwnership !== "per-member" ||
    !Array.isArray(tools) ||
    !tools.every((tool) =>
      isRecord(tool) &&
      typeof tool.id === "string" &&
      typeof tool.label === "string" &&
      ["team-only", "self-only"].includes(String(tool.policy))) ||
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
    !runtimeManagedEnvironmentStatus(runtime.managedEnvironment, "jiuwenswarm") ||
    (runtime.frameworkVersion !== undefined && typeof runtime.frameworkVersion !== "string")
  ) {
    throw new TypeError("JiuwenSwarm runtime registry has an invalid shape.");
  }
  return runtime as unknown as JiuwenSwarmRuntimeStatus;
}

function invocation(value: unknown): JiuwenSwarmInvocation {
  if (
    !isRecord(value) ||
    value.apiVersion !== JIUWENSWARM_RUNTIME_API_VERSION ||
    !isRecord(value.invocation)
  ) {
    throw new TypeError("JiuwenSwarm invocation does not match API version 1.0.0.");
  }
  const item = value.invocation;
  if (
    typeof item.id !== "string" ||
    typeof item.traceId !== "string" ||
    item.runtimeId !== "jiuwenswarm-agent-team" ||
    item.providerId !== "openrouter" ||
    typeof item.modelId !== "string" ||
    typeof item.teamName !== "string" ||
    typeof item.sessionId !== "string" ||
    !["accepted", "cancelling"].includes(String(item.status)) ||
    (item.cancellationEndpoint !== undefined && typeof item.cancellationEndpoint !== "string")
  ) {
    throw new TypeError("JiuwenSwarm invocation response has an invalid shape.");
  }
  return item as unknown as JiuwenSwarmInvocation;
}

export class JiuwenSwarmRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "JiuwenSwarmRuntimeClientError";
  }
}

export class JiuwenSwarmRuntimeClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_JIUWENSWARM_RUNTIME_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getStatus(signal?: AbortSignal, refresh = false): Promise<JiuwenSwarmRuntimeStatus> {
    return runtimeStatus(await this.request(
      `/api/v1/jiuwenswarm${refresh ? "?refresh=1" : ""}`,
      { signal },
    ));
  }

  async startInvocation(
    options: StartJiuwenSwarmInvocation,
    signal?: AbortSignal,
  ): Promise<JiuwenSwarmInvocation> {
    if (!options.traceId || !options.writeToken || !options.input.trim()) {
      throw new TypeError("Trace authority and a non-empty JiuwenSwarm input are required.");
    }
    return invocation(await this.request(
      "/api/v1/jiuwenswarm/invocations",
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
  ): Promise<JiuwenSwarmInvocation> {
    if (!invocationId || !writeToken) {
      throw new TypeError("Invocation id and Trace authority are required.");
    }
    return invocation(await this.request(
      `/api/v1/jiuwenswarm/invocations/${encodeURIComponent(invocationId)}/cancel`,
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
      throw new JiuwenSwarmRuntimeClientError(
        "本地服务返回了无效的 JiuwenSwarm JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new JiuwenSwarmRuntimeClientError(
        typeof error.message === "string" ? error.message : "JiuwenSwarm 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
