import type { GraphSnapshot } from "../../kernel";

export const DEFAULT_LOCAL_REPOSITORY_SERVER = "http://127.0.0.1:8765";

export interface LocalRepositoryIdentity {
  id: string;
  name: string;
  owner: string;
  path: string;
  scanScope: string;
  revision: string;
  branch: string;
  dirty: boolean;
}

export interface RepositoryScanOptions {
  includeTests?: boolean;
  includeFunctions?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxEdges?: number;
}

export interface RepositoryScanStatistics {
  pythonFiles: number;
  symbols: number;
  nodes: number;
  edges: number;
  durationMs: number;
  truncated: boolean;
}

export interface LocalRepositoryScanResult {
  apiVersion: "1.0.0";
  repository: LocalRepositoryIdentity;
  graph: GraphSnapshot;
  statistics: RepositoryScanStatistics;
  warnings: string[];
}

export interface LocalRepositoryHealth {
  status: "ok";
  apiVersion: "1.0.0";
  mode: "read-only";
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loopbackBaseUrl(value: string) {
  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Local repository server must be a credential-free loopback HTTP origin.");
  }
  return url.origin;
}

function scanResult(value: unknown): LocalRepositoryScanResult {
  if (!isRecord(value)) throw new TypeError("Local repository response is not an object.");
  const repository = value.repository;
  const graph = value.graph;
  const statistics = value.statistics;
  const warnings = value.warnings;
  if (
    value.apiVersion !== "1.0.0" ||
    !isRecord(repository) ||
    typeof repository.id !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.owner !== "string" ||
    typeof repository.path !== "string" ||
    typeof repository.scanScope !== "string" ||
    typeof repository.revision !== "string" ||
    typeof repository.branch !== "string" ||
    typeof repository.dirty !== "boolean" ||
    !isRecord(graph) ||
    graph.schemaVersion !== "1.0.0" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !isRecord(statistics) ||
    typeof statistics.pythonFiles !== "number" ||
    typeof statistics.symbols !== "number" ||
    typeof statistics.nodes !== "number" ||
    typeof statistics.edges !== "number" ||
    typeof statistics.durationMs !== "number" ||
    typeof statistics.truncated !== "boolean" ||
    !Array.isArray(warnings) ||
    !warnings.every((warning) => typeof warning === "string")
  ) {
    throw new TypeError("Local repository response does not match API version 1.0.0.");
  }
  return value as unknown as LocalRepositoryScanResult;
}

export class LocalRepositoryClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "LocalRepositoryClientError";
  }
}

export class LocalRepositoryClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackBaseUrl(
      options.baseUrl ?? DEFAULT_LOCAL_REPOSITORY_SERVER,
    );
    this.fetcher = options.fetcher ?? fetch;
  }

  async health(signal?: AbortSignal): Promise<LocalRepositoryHealth> {
    const value = await this.request("/api/v1/health", { signal });
    if (
      !isRecord(value) ||
      value.status !== "ok" ||
      value.apiVersion !== "1.0.0" ||
      value.mode !== "read-only"
    ) {
      throw new TypeError("Local repository health response is invalid.");
    }
    return value as unknown as LocalRepositoryHealth;
  }

  async scan(
    path: string,
    options: RepositoryScanOptions = {},
    signal?: AbortSignal,
  ): Promise<LocalRepositoryScanResult> {
    if (!path.trim()) throw new TypeError("Repository path is required.");
    const value = await this.request("/api/v1/repositories/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, options }),
      signal,
    });
    return scanResult(value);
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
      throw new LocalRepositoryClientError(
        "Local repository server returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new LocalRepositoryClientError(
        typeof error.message === "string" ? error.message : "Local repository request failed.",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
