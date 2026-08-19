import { loopbackHttpOrigin } from "../local-service/base-url";

export const PLUGIN_HOST_API_VERSION = "1.0.0" as const;
export const DEFAULT_PLUGIN_HOST_SERVER = "http://127.0.0.1:8765";
export const OPENROUTER_HOST_PLUGIN_ID = "openjiuwen.host.openrouter";
export const TOOL_CATALOG_HOST_PLUGIN_ID = "openjiuwen.host.tool-catalog";

export type PluginHostPluginStatus = "active" | "blocked" | "disabled";
export type PluginHostPermissionKind = "read" | "network" | "secret" | "write";
export type PluginHostGrantMode = "install" | "interactive" | "per-operation";

export interface PluginHostPermission {
  id: string;
  label: string;
  description: string;
  kind: PluginHostPermissionKind;
  grantMode: PluginHostGrantMode;
  granted: boolean;
  revocable: boolean;
  required: boolean;
  secretHandleId?: string;
}

export interface PluginHostSecretHandle {
  id: string;
  resolved: boolean;
  exposure: "opaque-handle-only";
  storage: "host-environment";
}

export interface PluginHostPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  group: "provider" | "tool" | "integration" | "workspace";
  capabilities: string[];
  defaultEnabled: boolean;
  requestedEnabled: boolean;
  status: PluginHostPluginStatus;
  diagnostic: { code: string; message: string };
  permissions: PluginHostPermission[];
  secretHandles: PluginHostSecretHandle[];
  trust: {
    level: "bundled-trusted" | "unsigned-local";
    automatic: boolean;
    executable: boolean;
  };
  source: {
    kind: "bundled" | "developer-path";
    identity: string;
    integrity: string;
    manifestPath?: string;
  };
  runtime: {
    mode: "builtin-adapter" | "declarative-only";
    processIsolation: "host-builtin-boundary" | "no-code-execution";
  };
}

export interface PluginHostSnapshot {
  mode: "local-loopback";
  storage: {
    engine: "sqlite";
    journalMode: "wal";
    schemaVersion: number;
  };
  policies: {
    bundledTrust: "automatic";
    unsignedLocal: "developer-mode-path-scoped";
    secretExposure: "opaque-handle-only";
    readPermission: "install-time";
    networkPermission: "revocable";
    writePermission: "per-operation-approval";
    arbitraryPluginCode: "disabled-in-v1";
  };
  developerMode: {
    enabled: boolean;
    authorizedRoots: string[];
    discoveryErrors: Array<{ code: string; source: string; message: string }>;
  };
  plugins: PluginHostPlugin[];
  audit: { count: number; lastEventId: number };
}

export interface PluginHostAuditEvent {
  id: number;
  timestampMs: number;
  pluginId: string | null;
  action: string;
  target: string;
  outcome: string;
  detailCode: string;
}

export interface PluginHostAuditPage {
  events: PluginHostAuditEvent[];
  nextCursor: number;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function permission(value: unknown): value is PluginHostPermission {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.description === "string" &&
    ["read", "network", "secret", "write"].includes(String(value.kind)) &&
    ["install", "interactive", "per-operation"].includes(String(value.grantMode)) &&
    typeof value.granted === "boolean" &&
    typeof value.revocable === "boolean" &&
    typeof value.required === "boolean" &&
    (value.secretHandleId === undefined || typeof value.secretHandleId === "string")
  );
}

function secretHandle(value: unknown): value is PluginHostSecretHandle {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.resolved === "boolean" &&
    value.exposure === "opaque-handle-only" &&
    value.storage === "host-environment"
  );
}

function plugin(value: unknown): value is PluginHostPlugin {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.description !== "string" ||
    !["provider", "tool", "integration", "workspace"].includes(String(value.group)) ||
    !isStringArray(value.capabilities) ||
    typeof value.defaultEnabled !== "boolean" ||
    typeof value.requestedEnabled !== "boolean" ||
    !["active", "blocked", "disabled"].includes(String(value.status)) ||
    !isRecord(value.diagnostic) ||
    typeof value.diagnostic.code !== "string" ||
    typeof value.diagnostic.message !== "string" ||
    !Array.isArray(value.permissions) ||
    !value.permissions.every(permission) ||
    !Array.isArray(value.secretHandles) ||
    !value.secretHandles.every(secretHandle) ||
    !isRecord(value.trust) ||
    !["bundled-trusted", "unsigned-local"].includes(String(value.trust.level)) ||
    typeof value.trust.automatic !== "boolean" ||
    typeof value.trust.executable !== "boolean" ||
    !isRecord(value.source) ||
    !["bundled", "developer-path"].includes(String(value.source.kind)) ||
    typeof value.source.identity !== "string" ||
    typeof value.source.integrity !== "string" ||
    (value.source.manifestPath !== undefined &&
      typeof value.source.manifestPath !== "string") ||
    !isRecord(value.runtime) ||
    !["builtin-adapter", "declarative-only"].includes(String(value.runtime.mode)) ||
    !["host-builtin-boundary", "no-code-execution"].includes(
      String(value.runtime.processIsolation),
    )
  ) {
    return false;
  }
  return true;
}

function snapshot(value: unknown): PluginHostSnapshot {
  if (
    !isRecord(value) ||
    value.apiVersion !== PLUGIN_HOST_API_VERSION ||
    !isRecord(value.host)
  ) {
    throw new TypeError("Plugin Host response does not match API version 1.0.0.");
  }
  const host = value.host;
  if (
    host.mode !== "local-loopback" ||
    !isRecord(host.storage) ||
    host.storage.engine !== "sqlite" ||
    host.storage.journalMode !== "wal" ||
    !isInteger(host.storage.schemaVersion) ||
    !isRecord(host.policies) ||
    host.policies.bundledTrust !== "automatic" ||
    host.policies.unsignedLocal !== "developer-mode-path-scoped" ||
    host.policies.secretExposure !== "opaque-handle-only" ||
    host.policies.readPermission !== "install-time" ||
    host.policies.networkPermission !== "revocable" ||
    host.policies.writePermission !== "per-operation-approval" ||
    host.policies.arbitraryPluginCode !== "disabled-in-v1" ||
    !isRecord(host.developerMode) ||
    typeof host.developerMode.enabled !== "boolean" ||
    !isStringArray(host.developerMode.authorizedRoots) ||
    !Array.isArray(host.developerMode.discoveryErrors) ||
    !host.developerMode.discoveryErrors.every((item) =>
      isRecord(item) &&
      typeof item.code === "string" &&
      typeof item.source === "string" &&
      typeof item.message === "string") ||
    !Array.isArray(host.plugins) ||
    !host.plugins.every(plugin) ||
    !isRecord(host.audit) ||
    !isInteger(host.audit.count) ||
    !isInteger(host.audit.lastEventId)
  ) {
    throw new TypeError("Plugin Host registry has an invalid shape.");
  }
  return host as unknown as PluginHostSnapshot;
}

function auditPage(value: unknown): PluginHostAuditPage {
  if (
    !isRecord(value) ||
    value.apiVersion !== PLUGIN_HOST_API_VERSION ||
    !Array.isArray(value.events) ||
    !value.events.every((item) =>
      isRecord(item) &&
      isInteger(item.id) &&
      isInteger(item.timestampMs) &&
      (item.pluginId === null || typeof item.pluginId === "string") &&
      typeof item.action === "string" &&
      typeof item.target === "string" &&
      typeof item.outcome === "string" &&
      typeof item.detailCode === "string") ||
    !isInteger(value.nextCursor)
  ) {
    throw new TypeError("Plugin Host audit response has an invalid shape.");
  }
  return {
    events: value.events as PluginHostAuditEvent[],
    nextCursor: value.nextCursor as number,
  };
}

export class PluginHostClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PluginHostClientError";
  }
}

export class PluginHostClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_PLUGIN_HOST_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getSnapshot(signal?: AbortSignal) {
    return snapshot(await this.request("/api/v1/plugin-host", { signal }));
  }

  async getAudit(options: { after?: number; limit?: number } = {}, signal?: AbortSignal) {
    const query = new URLSearchParams({
      after: String(options.after ?? 0),
      limit: String(options.limit ?? 100),
    });
    return auditPage(await this.request(
      `/api/v1/plugin-host/audit?${query}`,
      { signal },
    ));
  }

  async setPluginEnabled(
    pluginId: string,
    enabled: boolean,
    options: { confirmed?: boolean } = {},
    signal?: AbortSignal,
  ) {
    if (!pluginId || typeof enabled !== "boolean") {
      throw new TypeError("A plugin id and boolean enabled state are required.");
    }
    return snapshot(await this.request(
      `/api/v1/plugin-host/plugins/${encodeURIComponent(pluginId)}/state`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          ...(options.confirmed ? { confirmed: true } : {}),
        }),
        signal,
      },
    ));
  }

  async setPermission(
    pluginId: string,
    permissionId: string,
    granted: boolean,
    signal?: AbortSignal,
  ) {
    if (!pluginId || !permissionId || typeof granted !== "boolean") {
      throw new TypeError("Plugin, permission, and boolean grant state are required.");
    }
    return snapshot(await this.request(
      `/api/v1/plugin-host/plugins/${encodeURIComponent(pluginId)}` +
        `/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted }),
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
      throw new PluginHostClientError(
        "本地服务返回了无效的 Plugin Host JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new PluginHostClientError(
        typeof error.message === "string" ? error.message : "Plugin Host 请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}

