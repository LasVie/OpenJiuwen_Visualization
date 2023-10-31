import { loopbackHttpOrigin } from "../local-service/base-url";

export const MANAGED_ENVIRONMENT_API_VERSION = "1.0.0" as const;
export const DEFAULT_MANAGED_ENVIRONMENT_SERVER = "http://127.0.0.1:8765";

export type ManagedEnvironmentId = "core-env" | "swarm-core-env";
export type ManagedEnvironmentState =
  | "blocked"
  | "planned"
  | "plan-drift"
  | "ready"
  | "drifted";
export type RuntimeEnvironmentConsumer =
  | "agent-core"
  | "subagent"
  | "jiuwenswarm"
  | "swarmflow";

export interface RuntimeManagedEnvironmentStatus {
  id: ManagedEnvironmentId;
  consumer: RuntimeEnvironmentConsumer;
  state: ManagedEnvironmentState | "unavailable";
  desiredFingerprint: string | null;
  activeFingerprint: string | null;
  pythonVersion: string | null;
  uvVersion: string | null;
  autoReconcile: "before-runtime-invocation";
  diagnostic: { code: string; message: string };
}

export interface ManagedEnvironmentActiveManifest {
  environmentId: ManagedEnvironmentId;
  fingerprint: string;
  activatedAt: string;
  generationPath: string;
  venvPath: string;
  pythonExecutable: string;
  pythonVersion: string;
  uvVersion: string;
  validation: {
    status: "passed";
    checks: string[];
  };
}

export interface ManagedEnvironmentStatus {
  id: ManagedEnvironmentId;
  label: string;
  consumers: string[];
  state: ManagedEnvironmentState;
  message: string;
  desired: {
    fingerprint: string;
    manager: "uv";
    python: {
      implementation: "cpython";
      requested: "3.11";
      requiresPython: string | null;
      projectPin: string | null;
      provisioning: "uv-managed";
    };
    project: {
      slot: "agent-core" | "jiuwenswarm";
      source: {
        kind: "local" | "github";
        path: string;
        revision: string | null;
        branch: string | null;
        dirty: boolean | null;
      };
      metadata: {
        status: "ready" | "unavailable";
        name?: string;
        version?: string;
      };
    };
    sync: {
      strategy: "project-lock";
      frozen: true;
      projectRoot: string;
      python: "3.11";
      extras: string[];
    };
    resolution: {
      status: "ready" | "blocked";
      code: string;
      message: string;
    };
  };
  generated: {
    path: string;
    fingerprint: string;
    generatedAt: string;
    matchesDesired: boolean;
  } | null;
  active: ManagedEnvironmentActiveManifest | null;
  paths: {
    spec: string;
    generations: string;
    activeManifest: string;
  };
}

export interface ManagedEnvironmentsSnapshot {
  apiVersion: typeof MANAGED_ENVIRONMENT_API_VERSION;
  storage: {
    root: string;
    specFormat: "json";
    localOnly: true;
  };
  policy: {
    manager: "uv";
    python: "3.11";
    lockAuthority: "uv.lock";
    autoReconcile: "before-runtime-invocation";
    upstreamWrites: false;
    activation: "atomic-generation";
  };
  environments: {
    coreEnv: ManagedEnvironmentStatus;
    swarmCoreEnv: ManagedEnvironmentStatus;
  };
}

export interface ManagedEnvironmentReconcileResult {
  apiVersion: typeof MANAGED_ENVIRONMENT_API_VERSION;
  environmentId: ManagedEnvironmentId;
  outcome: "activated" | "reused";
  fingerprint: string;
  pythonVersion: string;
  activatedAt: string;
  removedGenerations: string[];
}

interface ReconcileResponse {
  apiVersion: typeof MANAGED_ENVIRONMENT_API_VERSION;
  result: ManagedEnvironmentReconcileResult;
  environments: ManagedEnvironmentsSnapshot;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function runtimeManagedEnvironmentStatus(
  value: unknown,
  expectedConsumer: RuntimeEnvironmentConsumer,
): RuntimeManagedEnvironmentStatus {
  const expectedId = ["agent-core", "subagent"].includes(expectedConsumer)
    ? "core-env"
    : "swarm-core-env";
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    value.consumer !== expectedConsumer ||
    !["blocked", "planned", "plan-drift", "ready", "drifted", "unavailable"].includes(
      String(value.state),
    ) ||
    !(value.desiredFingerprint === null || fingerprint(value.desiredFingerprint)) ||
    !(value.activeFingerprint === null || fingerprint(value.activeFingerprint)) ||
    !nullableText(value.pythonVersion) ||
    !nullableText(value.uvVersion) ||
    value.autoReconcile !== "before-runtime-invocation" ||
    !isRecord(value.diagnostic) ||
    typeof value.diagnostic.code !== "string" ||
    typeof value.diagnostic.message !== "string" ||
    (value.state === "ready" && (
      value.desiredFingerprint === null ||
      value.activeFingerprint !== value.desiredFingerprint ||
      value.pythonVersion === null ||
      value.uvVersion === null
    ))
  ) {
    throw new TypeError("运行时受管环境状态格式无效。");
  }
  return value as unknown as RuntimeManagedEnvironmentStatus;
}

function activeManifest(
  value: unknown,
  environmentId: ManagedEnvironmentId,
): ManagedEnvironmentActiveManifest | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.environmentId !== environmentId ||
    !fingerprint(value.fingerprint) ||
    !["activatedAt", "generationPath", "venvPath", "pythonExecutable", "pythonVersion", "uvVersion"].every(
      (field) => typeof value[field] === "string",
    ) ||
    !isRecord(value.validation) ||
    value.validation.status !== "passed" ||
    !Array.isArray(value.validation.checks) ||
    !value.validation.checks.every((item) => typeof item === "string")
  ) {
    throw new TypeError("受管环境 active manifest 格式无效。");
  }
  return value as unknown as ManagedEnvironmentActiveManifest;
}

function environmentStatus(
  value: unknown,
  expectedId: ManagedEnvironmentId,
): ManagedEnvironmentStatus {
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    typeof value.label !== "string" ||
    !Array.isArray(value.consumers) ||
    !value.consumers.every((item) => typeof item === "string") ||
    !["blocked", "planned", "plan-drift", "ready", "drifted"].includes(String(value.state)) ||
    typeof value.message !== "string" ||
    !isRecord(value.desired) ||
    !fingerprint(value.desired.fingerprint) ||
    value.desired.manager !== "uv" ||
    !isRecord(value.desired.python) ||
    value.desired.python.implementation !== "cpython" ||
    value.desired.python.requested !== "3.11" ||
    !nullableText(value.desired.python.requiresPython) ||
    !nullableText(value.desired.python.projectPin) ||
    value.desired.python.provisioning !== "uv-managed" ||
    !isRecord(value.desired.project) ||
    !["agent-core", "jiuwenswarm"].includes(String(value.desired.project.slot)) ||
    !isRecord(value.desired.project.source) ||
    !["local", "github"].includes(String(value.desired.project.source.kind)) ||
    typeof value.desired.project.source.path !== "string" ||
    !nullableText(value.desired.project.source.revision) ||
    !nullableText(value.desired.project.source.branch) ||
    !(value.desired.project.source.dirty === null || typeof value.desired.project.source.dirty === "boolean") ||
    !isRecord(value.desired.project.metadata) ||
    !["ready", "unavailable"].includes(String(value.desired.project.metadata.status)) ||
    !isRecord(value.desired.sync) ||
    value.desired.sync.strategy !== "project-lock" ||
    value.desired.sync.frozen !== true ||
    typeof value.desired.sync.projectRoot !== "string" ||
    value.desired.sync.python !== "3.11" ||
    !Array.isArray(value.desired.sync.extras) ||
    !value.desired.sync.extras.every((item) => typeof item === "string") ||
    !isRecord(value.desired.resolution) ||
    !["ready", "blocked"].includes(String(value.desired.resolution.status)) ||
    typeof value.desired.resolution.code !== "string" ||
    typeof value.desired.resolution.message !== "string" ||
    !isRecord(value.paths) ||
    typeof value.paths.spec !== "string" ||
    typeof value.paths.generations !== "string" ||
    typeof value.paths.activeManifest !== "string"
  ) {
    throw new TypeError("受管环境状态格式无效。");
  }
  if (value.generated !== null) {
    if (
      !isRecord(value.generated) ||
      typeof value.generated.path !== "string" ||
      !fingerprint(value.generated.fingerprint) ||
      typeof value.generated.generatedAt !== "string" ||
      typeof value.generated.matchesDesired !== "boolean"
    ) {
      throw new TypeError("受管环境 desired spec 证据格式无效。");
    }
  }
  activeManifest(value.active, expectedId);
  return value as unknown as ManagedEnvironmentStatus;
}

function environmentsSnapshot(value: unknown): ManagedEnvironmentsSnapshot {
  if (
    !isRecord(value) ||
    value.apiVersion !== MANAGED_ENVIRONMENT_API_VERSION ||
    !isRecord(value.storage) ||
    typeof value.storage.root !== "string" ||
    value.storage.specFormat !== "json" ||
    value.storage.localOnly !== true ||
    !isRecord(value.policy) ||
    value.policy.manager !== "uv" ||
    value.policy.python !== "3.11" ||
    value.policy.lockAuthority !== "uv.lock" ||
    value.policy.autoReconcile !== "before-runtime-invocation" ||
    value.policy.upstreamWrites !== false ||
    value.policy.activation !== "atomic-generation" ||
    !isRecord(value.environments)
  ) {
    throw new TypeError("受管环境响应与 API 1.0.0 不匹配。");
  }
  environmentStatus(value.environments.coreEnv, "core-env");
  environmentStatus(value.environments.swarmCoreEnv, "swarm-core-env");
  return value as unknown as ManagedEnvironmentsSnapshot;
}

function reconcileResponse(value: unknown): ReconcileResponse {
  if (
    !isRecord(value) ||
    value.apiVersion !== MANAGED_ENVIRONMENT_API_VERSION ||
    !isRecord(value.result) ||
    value.result.apiVersion !== MANAGED_ENVIRONMENT_API_VERSION ||
    !["core-env", "swarm-core-env"].includes(String(value.result.environmentId)) ||
    !["activated", "reused"].includes(String(value.result.outcome)) ||
    !fingerprint(value.result.fingerprint) ||
    typeof value.result.pythonVersion !== "string" ||
    typeof value.result.activatedAt !== "string" ||
    !Array.isArray(value.result.removedGenerations) ||
    !value.result.removedGenerations.every((item) => typeof item === "string")
  ) {
    throw new TypeError("受管环境对账响应格式无效。");
  }
  return {
    apiVersion: MANAGED_ENVIRONMENT_API_VERSION,
    result: value.result as unknown as ManagedEnvironmentReconcileResult,
    environments: environmentsSnapshot(value.environments),
  };
}

export class ManagedEnvironmentClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ManagedEnvironmentClientError";
  }
}

export class ManagedEnvironmentClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_MANAGED_ENVIRONMENT_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getEnvironments(signal?: AbortSignal): Promise<ManagedEnvironmentsSnapshot> {
    return environmentsSnapshot(await this.request("/api/v1/environments", { signal }));
  }

  async refreshDesiredState(signal?: AbortSignal): Promise<ManagedEnvironmentsSnapshot> {
    return environmentsSnapshot(await this.request("/api/v1/environments/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    }));
  }

  async reconcile(
    environmentId: ManagedEnvironmentId,
    signal?: AbortSignal,
  ): Promise<ReconcileResponse> {
    return reconcileResponse(await this.request(
      `/api/v1/environments/${environmentId}/reconcile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      throw new ManagedEnvironmentClientError(
        "本地 Companion 返回了无效 JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new ManagedEnvironmentClientError(
        typeof error.message === "string" ? error.message : "受管环境请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
