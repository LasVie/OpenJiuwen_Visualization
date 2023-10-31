import { loopbackHttpOrigin } from "../local-service/base-url";
import {
  runtimeManagedEnvironmentStatus,
  type RuntimeManagedEnvironmentStatus,
} from "../local-environments";

export const SUBAGENT_RUNTIME_API_VERSION = "1.0.0" as const;
export const DEFAULT_SUBAGENT_RUNTIME_SERVER = "http://127.0.0.1:8765";

export interface SubagentRuntimeModel {
  id: string;
  label: string;
  default: boolean;
}

export interface SubagentRuntimeStatus {
  id: "agent-core-task-tool-subagent";
  label: string;
  status: "ready" | "unconfigured" | "unavailable";
  configured: boolean;
  protocol: string;
  entrypoint: "openjiuwen.harness.tools.subagent.task_tool.TaskTool.invoke";
  executionIsolation: "fixed-subprocess";
  credentialPolicy: "local-service-only";
  providerId: "openrouter";
  profile: "fixed-single-child";
  dispatcher: "task-tool";
  runMode: "foreground";
  sessionPolicy: "ephemeral";
  workspaceIsolation: "subdirectory";
  contextOwnership: "per-agent";
  swarmFlow: false;
  streaming: true;
  cancellation: true;
  childType: "analysis_subagent";
  tools: Array<{
    id: string;
    role: "parent" | "child";
    policy: "delegate-only" | "read-only";
  }>;
  models: SubagentRuntimeModel[];
  defaultModelId: string;
  limits: {
    maxInputCharacters: number;
    maxSystemCharacters: number;
    minOutputTokens: number;
    maxOutputTokens: number;
    defaultOutputTokens: number;
    maxIterations: number;
    maxDepth: 1;
    maxChildren: 1;
    maxActiveInvocations: number;
  };
  diagnostic: { code: string; message: string };
  managedEnvironment: RuntimeManagedEnvironmentStatus;
  frameworkVersion?: string;
}

export interface SubagentInvocation {
  id: string;
  traceId: string;
  runtimeId: "agent-core-task-tool-subagent";
  providerId: "openrouter";
  modelId: string;
  parentSessionId: string;
  childType: "analysis_subagent";
  childSubjectId: string;
  status: "accepted" | "cancelling";
  cancellationEndpoint?: string;
}

export interface StartSubagentInvocation {
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

function runtimeStatus(value: unknown): SubagentRuntimeStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== SUBAGENT_RUNTIME_API_VERSION ||
    !isRecord(value.runtime)
  ) {
    throw new TypeError("Subagent runtime registry does not match API version 1.0.0.");
  }
  const runtime = value.runtime;
  const models = runtime.models;
  const tools = runtime.tools;
  const limits = runtime.limits;
  const diagnostic = runtime.diagnostic;
  if (
    runtime.id !== "agent-core-task-tool-subagent" ||
    typeof runtime.label !== "string" ||
    !["ready", "unconfigured", "unavailable"].includes(String(runtime.status)) ||
    typeof runtime.configured !== "boolean" ||
    runtime.configured !== (runtime.status === "ready") ||
    typeof runtime.protocol !== "string" ||
    runtime.entrypoint !== "openjiuwen.harness.tools.subagent.task_tool.TaskTool.invoke" ||
    runtime.executionIsolation !== "fixed-subprocess" ||
    runtime.credentialPolicy !== "local-service-only" ||
    runtime.providerId !== "openrouter" ||
    runtime.profile !== "fixed-single-child" ||
    runtime.dispatcher !== "task-tool" ||
    runtime.runMode !== "foreground" ||
    runtime.sessionPolicy !== "ephemeral" ||
    runtime.workspaceIsolation !== "subdirectory" ||
    runtime.contextOwnership !== "per-agent" ||
    runtime.swarmFlow !== false ||
    runtime.streaming !== true ||
    runtime.cancellation !== true ||
    runtime.childType !== "analysis_subagent" ||
    !Array.isArray(tools) ||
    !tools.every((tool) =>
      isRecord(tool) &&
      typeof tool.id === "string" &&
      ["parent", "child"].includes(String(tool.role)) &&
      ["delegate-only", "read-only"].includes(String(tool.policy))) ||
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
    limits.maxDepth !== 1 ||
    limits.maxChildren !== 1 ||
    !nonNegativeInteger(limits.maxActiveInvocations) ||
    !isRecord(diagnostic) ||
    typeof diagnostic.code !== "string" ||
    typeof diagnostic.message !== "string" ||
    !runtimeManagedEnvironmentStatus(runtime.managedEnvironment, "subagent") ||
    (runtime.frameworkVersion !== undefined && typeof runtime.frameworkVersion !== "string")
  ) {
    throw new TypeError("Subagent runtime registry has an invalid shape.");
  }
  return runtime as unknown as SubagentRuntimeStatus;
}

function invocation(value: unknown): SubagentInvocation {
  if (
    !isRecord(value) ||
    value.apiVersion !== SUBAGENT_RUNTIME_API_VERSION ||
    !isRecord(value.invocation)
  ) {
    throw new TypeError("Subagent invocation does not match API version 1.0.0.");
  }
  const item = value.invocation;
  if (
    typeof item.id !== "string" ||
    typeof item.traceId !== "string" ||
    item.runtimeId !== "agent-core-task-tool-subagent" ||
    item.providerId !== "openrouter" ||
    typeof item.modelId !== "string" ||
    typeof item.parentSessionId !== "string" ||
    item.childType !== "analysis_subagent" ||
    typeof item.childSubjectId !== "string" ||
    !["accepted", "cancelling"].includes(String(item.status)) ||
    (item.cancellationEndpoint !== undefined && typeof item.cancellationEndpoint !== "string")
  ) {
    throw new TypeError("Subagent invocation response has an invalid shape.");
  }
  return item as unknown as SubagentInvocation;
}

export class SubagentRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SubagentRuntimeClientError";
  }
}

export class SubagentRuntimeClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_SUBAGENT_RUNTIME_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getStatus(signal?: AbortSignal, refresh = false): Promise<SubagentRuntimeStatus> {
    return runtimeStatus(await this.request(
      `/api/v1/subagents${refresh ? "?refresh=1" : ""}`,
      { signal },
    ));
  }

  async startInvocation(
    options: StartSubagentInvocation,
    signal?: AbortSignal,
  ): Promise<SubagentInvocation> {
    if (!options.traceId || !options.writeToken || !options.input.trim()) {
      throw new TypeError("Trace authority and a non-empty Subagent input are required.");
    }
    return invocation(await this.request(
      "/api/v1/subagents/invocations",
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
  ): Promise<SubagentInvocation> {
    if (!invocationId || !writeToken) {
      throw new TypeError("Invocation id and Trace authority are required.");
    }
    return invocation(await this.request(
      `/api/v1/subagents/invocations/${encodeURIComponent(invocationId)}/cancel`,
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
      throw new SubagentRuntimeClientError(
        "本地服务返回了无效的 Subagent JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new SubagentRuntimeClientError(
        typeof error.message === "string" ? error.message : "Subagent 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
