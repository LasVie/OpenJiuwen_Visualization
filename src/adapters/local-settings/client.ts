import { loopbackHttpOrigin } from "../local-service/base-url";

export const LOCAL_SETTINGS_API_VERSION = "1.0.0" as const;
export const DEFAULT_LOCAL_SETTINGS_SERVER = "http://127.0.0.1:8765";

export type OpenRouterCredentialSource =
  | "system-credential"
  | "environment"
  | "injected"
  | "none";

export interface LocalSecretStorageStatus {
  id: string;
  available: boolean;
  writable: boolean;
  persistence: string;
}

export interface OpenRouterCredentialStatus {
  handleId: "openrouter.default";
  configured: boolean;
  source: OpenRouterCredentialSource;
  writable: boolean;
  canDelete: boolean;
  exposure: "write-only";
  environmentFallback: boolean;
  storage: LocalSecretStorageStatus;
  diagnostic?: { code: string };
}

export type RepositoryConnectionSlot = "agent-core" | "jiuwenswarm";
export type RepositoryConnectionMode = "local" | "github";

export interface ConnectedRepositoryIdentity {
  id: string;
  name: string;
  owner: string;
  path: string;
  scanScope: string;
  revision: string;
  branch: string;
  dirty: boolean;
}

export interface RepositoryConnectionStatus {
  slot: RepositoryConnectionSlot;
  label: string;
  configured: boolean;
  mode: RepositoryConnectionMode;
  origin: "default" | "configured";
  path: string;
  managed: boolean;
  canReset: boolean;
  canSync: boolean;
  github: {
    url: string;
    repository: string;
    ref: string | null;
    public: true;
  } | null;
  repository: ConnectedRepositoryIdentity | null;
  validation: {
    status: "ready" | "unavailable";
    code: string;
    message: string;
  };
  createdAt: string | null;
  updatedAt: string | null;
  lastSyncedAt: string | null;
}

export interface RepositoryConnectionsStatus {
  apiVersion: typeof LOCAL_SETTINGS_API_VERSION;
  storage: {
    id: "sqlite";
    journalMode: "wal";
    path: string;
  };
  policy: {
    allowedRoots: string[];
    githubPublicOnly: true;
    githubAuthentication: false;
    synchronization: "manual";
    managedCheckoutRoot: string;
  };
  slots: {
    agentCore: RepositoryConnectionStatus;
    jiuwenSwarm: RepositoryConnectionStatus;
  };
}

export interface LocalSettingsSnapshot {
  apiVersion: typeof LOCAL_SETTINGS_API_VERSION;
  settings: {
    openRouter: OpenRouterCredentialStatus;
    repositories: RepositoryConnectionsStatus;
    service: {
      transport: "loopback-http";
      remoteAccess: false;
    };
  };
}

interface CredentialMutationResponse {
  apiVersion: typeof LOCAL_SETTINGS_API_VERSION;
  credential: OpenRouterCredentialStatus;
}

interface RepositoryConnectionMutationResponse {
  apiVersion: typeof LOCAL_SETTINGS_API_VERSION;
  connection: RepositoryConnectionStatus;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function secretStorage(value: unknown): value is LocalSecretStorageStatus {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.available === "boolean" &&
    typeof value.writable === "boolean" &&
    typeof value.persistence === "string"
  );
}

function credential(value: unknown): OpenRouterCredentialStatus {
  if (
    !isRecord(value) ||
    value.handleId !== "openrouter.default" ||
    typeof value.configured !== "boolean" ||
    !["system-credential", "environment", "injected", "none"].includes(
      String(value.source),
    ) ||
    typeof value.writable !== "boolean" ||
    typeof value.canDelete !== "boolean" ||
    value.exposure !== "write-only" ||
    typeof value.environmentFallback !== "boolean" ||
    !secretStorage(value.storage) ||
    value.writable !== value.storage.writable ||
    (value.source === "none" && value.configured) ||
    (value.source !== "none" && !value.configured) ||
    (value.canDelete && value.source !== "system-credential") ||
    (value.diagnostic !== undefined && (
      !isRecord(value.diagnostic) ||
      typeof value.diagnostic.code !== "string"
    ))
  ) {
    throw new TypeError("本地 OpenRouter 凭据状态格式无效。");
  }
  return value as unknown as OpenRouterCredentialStatus;
}

function nullableText(value: unknown) {
  return value === null || typeof value === "string";
}

function repositoryIdentity(value: unknown): value is ConnectedRepositoryIdentity {
  return (
    isRecord(value) &&
    ["id", "name", "owner", "path", "scanScope", "revision", "branch"].every(
      (field) => typeof value[field] === "string",
    ) &&
    typeof value.dirty === "boolean"
  );
}

function repositoryConnection(value: unknown): RepositoryConnectionStatus {
  if (
    !isRecord(value) ||
    !["agent-core", "jiuwenswarm"].includes(String(value.slot)) ||
    typeof value.label !== "string" ||
    typeof value.configured !== "boolean" ||
    !["local", "github"].includes(String(value.mode)) ||
    !["default", "configured"].includes(String(value.origin)) ||
    typeof value.path !== "string" ||
    typeof value.managed !== "boolean" ||
    typeof value.canReset !== "boolean" ||
    typeof value.canSync !== "boolean" ||
    !(value.repository === null || repositoryIdentity(value.repository)) ||
    !isRecord(value.validation) ||
    !["ready", "unavailable"].includes(String(value.validation.status)) ||
    typeof value.validation.code !== "string" ||
    typeof value.validation.message !== "string" ||
    !nullableText(value.createdAt) ||
    !nullableText(value.updatedAt) ||
    !nullableText(value.lastSyncedAt)
  ) {
    throw new TypeError("本地代码来源状态格式无效。");
  }
  if (value.mode === "github") {
    if (
      !isRecord(value.github) ||
      typeof value.github.url !== "string" ||
      typeof value.github.repository !== "string" ||
      !nullableText(value.github.ref) ||
      value.github.public !== true ||
      value.managed !== true ||
      value.origin !== "configured"
    ) {
      throw new TypeError("GitHub 代码来源状态格式无效。");
    }
  } else if (value.github !== null || value.managed) {
    throw new TypeError("本地代码来源不能声明 GitHub 托管状态。");
  }
  if (
    value.configured !== (value.validation.status === "ready") ||
    value.canSync !== (value.mode === "github" && value.origin === "configured") ||
    value.canReset !== (value.origin === "configured")
  ) {
    throw new TypeError("代码来源能力与状态不一致。");
  }
  return value as unknown as RepositoryConnectionStatus;
}

function repositoryConnections(value: unknown): RepositoryConnectionsStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== LOCAL_SETTINGS_API_VERSION ||
    !isRecord(value.storage) ||
    value.storage.id !== "sqlite" ||
    value.storage.journalMode !== "wal" ||
    typeof value.storage.path !== "string" ||
    !isRecord(value.policy) ||
    !Array.isArray(value.policy.allowedRoots) ||
    !value.policy.allowedRoots.every((root) => typeof root === "string") ||
    value.policy.githubPublicOnly !== true ||
    value.policy.githubAuthentication !== false ||
    value.policy.synchronization !== "manual" ||
    typeof value.policy.managedCheckoutRoot !== "string" ||
    !isRecord(value.slots)
  ) {
    throw new TypeError("本地代码来源设置格式无效。");
  }
  repositoryConnection(value.slots.agentCore);
  repositoryConnection(value.slots.jiuwenSwarm);
  return value as unknown as RepositoryConnectionsStatus;
}

function settingsSnapshot(value: unknown): LocalSettingsSnapshot {
  if (
    !isRecord(value) ||
    value.apiVersion !== LOCAL_SETTINGS_API_VERSION ||
    !isRecord(value.settings) ||
    !isRecord(value.settings.service) ||
    value.settings.service.transport !== "loopback-http" ||
    value.settings.service.remoteAccess !== false
  ) {
    throw new TypeError("本地设置响应与 API 1.0.0 不匹配。");
  }
  credential(value.settings.openRouter);
  repositoryConnections(value.settings.repositories);
  return value as unknown as LocalSettingsSnapshot;
}

function credentialMutation(value: unknown): CredentialMutationResponse {
  if (
    !isRecord(value) ||
    value.apiVersion !== LOCAL_SETTINGS_API_VERSION
  ) {
    throw new TypeError("本地凭据响应与 API 1.0.0 不匹配。");
  }
  return {
    apiVersion: LOCAL_SETTINGS_API_VERSION,
    credential: credential(value.credential),
  };
}

function repositoryConnectionMutation(
  value: unknown,
): RepositoryConnectionMutationResponse {
  if (!isRecord(value) || value.apiVersion !== LOCAL_SETTINGS_API_VERSION) {
    throw new TypeError("本地代码来源响应与 API 1.0.0 不匹配。");
  }
  return {
    apiVersion: LOCAL_SETTINGS_API_VERSION,
    connection: repositoryConnection(value.connection),
  };
}

export class LocalSettingsClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "LocalSettingsClientError";
  }
}

export class LocalSettingsClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_LOCAL_SETTINGS_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getSettings(signal?: AbortSignal): Promise<LocalSettingsSnapshot> {
    return settingsSnapshot(await this.request("/api/v1/settings", { signal }));
  }

  async setOpenRouterCredential(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<OpenRouterCredentialStatus> {
    const normalized = apiKey.trim();
    if (!normalized) throw new TypeError("OpenRouter API key 不能为空。");
    return credentialMutation(await this.request(
      "/api/v1/settings/openrouter/credential",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: normalized }),
        signal,
      },
    )).credential;
  }

  async deleteOpenRouterCredential(
    signal?: AbortSignal,
  ): Promise<OpenRouterCredentialStatus> {
    return credentialMutation(await this.request(
      "/api/v1/settings/openrouter/credential",
      { method: "DELETE", signal },
    )).credential;
  }

  async setLocalRepository(
    slot: RepositoryConnectionSlot,
    path: string,
    signal?: AbortSignal,
  ): Promise<RepositoryConnectionStatus> {
    const normalized = path.trim();
    if (!normalized) throw new TypeError("本地仓库路径不能为空。");
    return repositoryConnectionMutation(await this.request(
      `/api/v1/settings/repositories/${slot}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "local", path: normalized }),
        signal,
      },
    )).connection;
  }

  async setGitHubRepository(
    slot: RepositoryConnectionSlot,
    url: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<RepositoryConnectionStatus> {
    const normalizedUrl = url.trim();
    const normalizedRef = ref?.trim();
    if (!normalizedUrl) throw new TypeError("GitHub 仓库 URL 不能为空。");
    return repositoryConnectionMutation(await this.request(
      `/api/v1/settings/repositories/${slot}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "github",
          url: normalizedUrl,
          ...(normalizedRef ? { ref: normalizedRef } : {}),
        }),
        signal,
      },
    )).connection;
  }

  async syncRepository(
    slot: RepositoryConnectionSlot,
    signal?: AbortSignal,
  ): Promise<RepositoryConnectionStatus> {
    return repositoryConnectionMutation(await this.request(
      `/api/v1/settings/repositories/${slot}/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      },
    )).connection;
  }

  async resetRepository(
    slot: RepositoryConnectionSlot,
    signal?: AbortSignal,
  ): Promise<RepositoryConnectionStatus> {
    return repositoryConnectionMutation(await this.request(
      `/api/v1/settings/repositories/${slot}`,
      { method: "DELETE", signal },
    )).connection;
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
      throw new LocalSettingsClientError(
        "本地 Companion 返回了无效 JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new LocalSettingsClientError(
        typeof error.message === "string" ? error.message : "本地设置请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
