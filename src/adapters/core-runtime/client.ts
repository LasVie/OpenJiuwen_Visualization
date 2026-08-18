import {
  CORE_RUNTIME_API_VERSION,
  isCoreRuntimeEventKind,
  type CoreRuntimeEvent,
  type CoreRuntimeEventInput,
  type CreatedRuntimeTrace,
  type RuntimeOwner,
  type RuntimeTraceSession,
  type RuntimeTraceSnapshot,
} from "../../kernel";
import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEFAULT_CORE_RUNTIME_SERVER = "http://127.0.0.1:8765";

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
}

interface CreateTraceOptions {
  owner?: RuntimeOwner;
  label: string;
  maxTokens?: number;
}

export interface RuntimeSubscriptionHandlers {
  onEvent: (event: CoreRuntimeEvent) => void;
  onOpen?: () => void;
  onReconnect?: () => void;
  onEnd?: (trace: RuntimeTraceSession) => void;
  onProtocolError?: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, minimum?: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (minimum === undefined || value >= minimum)
  );
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validToken(value: unknown) {
  return (
    isRecord(value) &&
    finiteNumber(value.used, 0) &&
    (value.delta === undefined || finiteNumber(value.delta)) &&
    (value.tool === undefined || finiteNumber(value.tool, 0)) &&
    (value.budget === undefined || finiteNumber(value.budget, 0))
  );
}

function validContextMessage(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["system", "user", "assistant", "tool", "summary"].includes(String(value.role)) &&
    typeof value.label === "string" &&
    typeof value.raw === "string" &&
    (value.preview === undefined || typeof value.preview === "string") &&
    finiteNumber(value.tokens, 0) &&
    typeof value.source === "string"
  );
}

function validContext(value: unknown) {
  return (
    isRecord(value) &&
    ["append", "replace", "remove"].includes(String(value.operation)) &&
    (value.messages === undefined ||
      (Array.isArray(value.messages) && value.messages.every(validContextMessage))) &&
    (value.removeMessageIds === undefined || stringArray(value.removeMessageIds))
  );
}

function validHook(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.rail === "string" &&
    (value.railNodeId === undefined || typeof value.railNodeId === "string") &&
    typeof value.callback === "string" &&
    Number.isInteger(value.priority) &&
    (value.namespace === "outer" || value.namespace === "inner") &&
    finiteNumber(value.durationMs, 0) &&
    typeof value.mutationDiff === "string" &&
    typeof value.controlSignal === "string" &&
    (value.noop === undefined || typeof value.noop === "boolean") &&
    typeof value.exact === "boolean" &&
    (value.examines === undefined || stringArray(value.examines))
  );
}

function validDetails(value: unknown) {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.label === "string" &&
        typeof item.value === "string",
    )
  );
}

function validDefinition(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.repository === "string" &&
    typeof value.path === "string" &&
    (value.revision === undefined || typeof value.revision === "string") &&
    (value.symbol === undefined || typeof value.symbol === "string") &&
    (value.startLine === undefined || Number.isInteger(value.startLine)) &&
    (value.endLine === undefined || Number.isInteger(value.endLine))
  );
}

function traceSession(value: unknown): RuntimeTraceSession {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.owner !== "agent-core" && value.owner !== "jiuwenswarm") ||
    typeof value.label !== "string" ||
    (value.status !== "open" && value.status !== "completed" && value.status !== "failed") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isInteger(value.eventCount) ||
    !Number.isInteger(value.lastSequence) ||
    !finiteNumber(value.maxTokens, 0) ||
    !Number.isInteger(value.byteCount) ||
    Number(value.eventCount) < 0 ||
    Number(value.lastSequence) < 0 ||
    Number(value.byteCount) < 0
  ) {
    throw new TypeError("Runtime trace session does not match API version 1.0.0.");
  }
  return value as unknown as RuntimeTraceSession;
}

function runtimeEvent(value: unknown): CoreRuntimeEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    !isCoreRuntimeEventKind(value.kind) ||
    !["start", "end", "error", "instant"].includes(String(value.phase)) ||
    !finiteNumber(value.timestampMs, 0) ||
    typeof value.spanId !== "string" ||
    typeof value.traceId !== "string" ||
    !Number.isInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.receivedAt !== "string" ||
    (value.durationMs !== undefined && !finiteNumber(value.durationMs, 0)) ||
    (value.iteration !== undefined && !Number.isInteger(value.iteration)) ||
    (value.activeNodeIds !== undefined && !stringArray(value.activeNodeIds)) ||
    (value.activeEdgeIds !== undefined && !stringArray(value.activeEdgeIds)) ||
    (value.details !== undefined && !validDetails(value.details)) ||
    (value.token !== undefined && !validToken(value.token)) ||
    (value.context !== undefined && !validContext(value.context)) ||
    (value.hook !== undefined && !validHook(value.hook)) ||
    (value.kind === "rail.hook" && !validHook(value.hook)) ||
    (value.definition !== undefined && !validDefinition(value.definition)) ||
    (value.payload !== undefined && !isRecord(value.payload))
  ) {
    throw new TypeError("Runtime event does not match Core Runtime V1.");
  }
  return value as unknown as CoreRuntimeEvent;
}

function createdTrace(value: unknown): CreatedRuntimeTrace {
  if (
    !isRecord(value) ||
    value.apiVersion !== CORE_RUNTIME_API_VERSION ||
    value.storage !== "memory-only" ||
    typeof value.writeToken !== "string" ||
    !isRecord(value.endpoints)
  ) {
    throw new TypeError("Create trace response does not match Core Runtime V1.");
  }
  const trace = traceSession(value.trace);
  const endpoints = value.endpoints;
  if (
    typeof endpoints.events !== "string" ||
    typeof endpoints.snapshot !== "string" ||
    typeof endpoints.stream !== "string"
  ) {
    throw new TypeError("Create trace response endpoints are invalid.");
  }
  return { ...value, trace } as unknown as CreatedRuntimeTrace;
}

function snapshot(value: unknown): RuntimeTraceSnapshot {
  if (
    !isRecord(value) ||
    value.apiVersion !== CORE_RUNTIME_API_VERSION ||
    value.storage !== "memory-only" ||
    !Array.isArray(value.events)
  ) {
    throw new TypeError("Runtime trace snapshot does not match Core Runtime V1.");
  }
  return {
    apiVersion: CORE_RUNTIME_API_VERSION,
    trace: traceSession(value.trace),
    events: value.events.map(runtimeEvent),
    storage: "memory-only",
  };
}

export class CoreRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CoreRuntimeClientError";
  }
}

export class CoreRuntimeClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly eventSourceFactory: (url: string) => EventSource;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(options.baseUrl ?? DEFAULT_CORE_RUNTIME_SERVER);
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.eventSourceFactory =
      options.eventSourceFactory ?? ((url) => new EventSource(url));
  }

  async createTrace(
    options: CreateTraceOptions,
    signal?: AbortSignal,
  ): Promise<CreatedRuntimeTrace> {
    if (!options.label.trim()) throw new TypeError("Trace label is required.");
    const value = await this.request("/api/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: options.owner ?? "agent-core",
        label: options.label,
        maxTokens: options.maxTokens ?? 8192,
      }),
      signal,
    });
    return createdTrace(value);
  }

  async appendEvents(
    traceId: string,
    writeToken: string,
    events: readonly CoreRuntimeEventInput[],
    signal?: AbortSignal,
  ) {
    if (!events.length) throw new TypeError("At least one runtime event is required.");
    return this.request(`/api/v1/traces/${encodeURIComponent(traceId)}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Token": writeToken,
      },
      body: JSON.stringify({ events }),
      signal,
    });
  }

  async getSnapshot(
    traceId: string,
    after = 0,
    signal?: AbortSignal,
  ): Promise<RuntimeTraceSnapshot> {
    const value = await this.request(
      `/api/v1/traces/${encodeURIComponent(traceId)}?after=${Math.max(0, after)}`,
      { signal },
    );
    return snapshot(value);
  }

  subscribe(
    traceId: string,
    after: number,
    handlers: RuntimeSubscriptionHandlers,
  ) {
    const source = this.eventSourceFactory(
      `${this.baseUrl}/api/v1/traces/${encodeURIComponent(traceId)}/stream?after=${Math.max(0, after)}`,
    );
    source.onopen = () => handlers.onOpen?.();
    source.onerror = () => handlers.onReconnect?.();
    source.addEventListener("trace.event", (rawEvent) => {
      try {
        const message = rawEvent as MessageEvent<string>;
        handlers.onEvent(runtimeEvent(JSON.parse(message.data)));
      } catch (error) {
        handlers.onProtocolError?.(
          error instanceof Error ? error : new Error("Invalid runtime event frame."),
        );
      }
    });
    source.addEventListener("trace.end", (rawEvent) => {
      try {
        const message = rawEvent as MessageEvent<string>;
        handlers.onEnd?.(traceSession(JSON.parse(message.data)));
      } catch (error) {
        handlers.onProtocolError?.(
          error instanceof Error ? error : new Error("Invalid runtime end frame."),
        );
      } finally {
        source.close();
      }
    });
    return () => source.close();
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
      throw new CoreRuntimeClientError(
        "Local runtime server returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new CoreRuntimeClientError(
        typeof error.message === "string" ? error.message : "Runtime request failed.",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
