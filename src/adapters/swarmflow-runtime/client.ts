import { loopbackHttpOrigin } from "../local-service/base-url";

export const SWARMFLOW_RUNTIME_API_VERSION = "1.0.0" as const;
export const DEFAULT_SWARMFLOW_RUNTIME_SERVER = "http://127.0.0.1:8765";

export interface SwarmFlowRuntimeModel {
  id: string;
  label: string;
  default: boolean;
}

export interface SwarmFlowRuntimePhase {
  id: string;
  label: string;
  agent: string;
}

export interface SwarmFlowRuntimeStatus {
  id: "agent-core-swarmflow";
  label: string;
  status: "ready" | "unconfigured" | "unavailable";
  configured: boolean;
  protocol: string;
  entrypoint: "openjiuwen.agent_teams.workflow.run_swarmflow";
  executionIsolation: "fixed-subprocess";
  credentialPolicy: "local-service-only";
  providerId: "openrouter";
  profile: "fixed-two-phase";
  teamMode: "workflow";
  dispatchMode: "sequential";
  workerMode: "ephemeral-team-harness";
  swarmFlow: true;
  streaming: true;
  cancellation: true;
  humanInLoop: false;
  parallel: false;
  contextOwnership: "per-agent";
  tools: [];
  phases: SwarmFlowRuntimePhase[];
  models: SwarmFlowRuntimeModel[];
  defaultModelId: string;
  limits: {
    maxInputCharacters: number;
    maxSystemCharacters: number;
    minOutputTokens: number;
    maxOutputTokens: number;
    defaultOutputTokens: number;
    maxIterations: number;
    maxActiveInvocations: number;
    maxPhases: 2;
    maxAgents: 2;
  };
  diagnostic: { code: string; message: string };
  frameworkVersion?: string;
}

export interface SwarmFlowInvocation {
  id: string;
  traceId: string;
  runtimeId: "agent-core-swarmflow";
  providerId: "openrouter";
  modelId: string;
  teamName: string;
  sessionId: string;
  runId: string;
  status: "accepted" | "cancelling";
  cancellationEndpoint?: string;
}

export interface StartSwarmFlowInvocation {
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

function runtimeStatus(value: unknown): SwarmFlowRuntimeStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== SWARMFLOW_RUNTIME_API_VERSION ||
    !isRecord(value.runtime)
  ) {
    throw new TypeError("SwarmFlow runtime registry does not match API version 1.0.0.");
  }
  const runtime = value.runtime;
  const models = runtime.models;
  const phases = runtime.phases;
  const limits = runtime.limits;
  const diagnostic = runtime.diagnostic;
  if (
    runtime.id !== "agent-core-swarmflow" ||
    typeof runtime.label !== "string" ||
    !["ready", "unconfigured", "unavailable"].includes(String(runtime.status)) ||
    typeof runtime.configured !== "boolean" ||
    runtime.configured !== (runtime.status === "ready") ||
    typeof runtime.protocol !== "string" ||
    runtime.entrypoint !== "openjiuwen.agent_teams.workflow.run_swarmflow" ||
    runtime.executionIsolation !== "fixed-subprocess" ||
    runtime.credentialPolicy !== "local-service-only" ||
    runtime.providerId !== "openrouter" ||
    runtime.profile !== "fixed-two-phase" ||
    runtime.teamMode !== "workflow" ||
    runtime.dispatchMode !== "sequential" ||
    runtime.workerMode !== "ephemeral-team-harness" ||
    runtime.swarmFlow !== true ||
    runtime.streaming !== true ||
    runtime.cancellation !== true ||
    runtime.humanInLoop !== false ||
    runtime.parallel !== false ||
    runtime.contextOwnership !== "per-agent" ||
    !Array.isArray(runtime.tools) ||
    runtime.tools.length !== 0 ||
    !Array.isArray(phases) ||
    phases.length !== 2 ||
    !phases.every((phase) =>
      isRecord(phase) &&
      typeof phase.id === "string" &&
      typeof phase.label === "string" &&
      typeof phase.agent === "string") ||
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
    limits.maxPhases !== 2 ||
    limits.maxAgents !== 2 ||
    !isRecord(diagnostic) ||
    typeof diagnostic.code !== "string" ||
    typeof diagnostic.message !== "string" ||
    (runtime.frameworkVersion !== undefined && typeof runtime.frameworkVersion !== "string")
  ) {
    throw new TypeError("SwarmFlow runtime registry has an invalid shape.");
  }
  return runtime as unknown as SwarmFlowRuntimeStatus;
}

function invocation(value: unknown): SwarmFlowInvocation {
  if (
    !isRecord(value) ||
    value.apiVersion !== SWARMFLOW_RUNTIME_API_VERSION ||
    !isRecord(value.invocation)
  ) {
    throw new TypeError("SwarmFlow invocation does not match API version 1.0.0.");
  }
  const item = value.invocation;
  if (
    typeof item.id !== "string" ||
    typeof item.traceId !== "string" ||
    item.runtimeId !== "agent-core-swarmflow" ||
    item.providerId !== "openrouter" ||
    typeof item.modelId !== "string" ||
    typeof item.teamName !== "string" ||
    typeof item.sessionId !== "string" ||
    typeof item.runId !== "string" ||
    !["accepted", "cancelling"].includes(String(item.status)) ||
    (item.cancellationEndpoint !== undefined && typeof item.cancellationEndpoint !== "string")
  ) {
    throw new TypeError("SwarmFlow invocation response has an invalid shape.");
  }
  return item as unknown as SwarmFlowInvocation;
}

export class SwarmFlowRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SwarmFlowRuntimeClientError";
  }
}

export class SwarmFlowRuntimeClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_SWARMFLOW_RUNTIME_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getStatus(signal?: AbortSignal, refresh = false): Promise<SwarmFlowRuntimeStatus> {
    return runtimeStatus(await this.request(
      `/api/v1/swarmflows${refresh ? "?refresh=1" : ""}`,
      { signal },
    ));
  }

  async startInvocation(
    options: StartSwarmFlowInvocation,
    signal?: AbortSignal,
  ): Promise<SwarmFlowInvocation> {
    if (!options.traceId || !options.writeToken || !options.input.trim()) {
      throw new TypeError("Trace authority and a non-empty SwarmFlow input are required.");
    }
    return invocation(await this.request(
      "/api/v1/swarmflows/invocations",
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
  ): Promise<SwarmFlowInvocation> {
    if (!invocationId || !writeToken) {
      throw new TypeError("Invocation id and Trace authority are required.");
    }
    return invocation(await this.request(
      `/api/v1/swarmflows/invocations/${encodeURIComponent(invocationId)}/cancel`,
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
      throw new SwarmFlowRuntimeClientError(
        "本地服务返回了无效的 SwarmFlow JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new SwarmFlowRuntimeClientError(
        typeof error.message === "string" ? error.message : "SwarmFlow 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
