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

export interface LocalSettingsSnapshot {
  apiVersion: typeof LOCAL_SETTINGS_API_VERSION;
  settings: {
    openRouter: OpenRouterCredentialStatus;
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
