import type {
  GitChangeComparison,
  GitChangedFile,
  GitChangeMode,
  GitChangeStatistics,
  GraphSnapshot,
} from "../../kernel";
import { loopbackHttpOrigin } from "../local-service/base-url";

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

export interface LocalRepositoryCatalog {
  allowedRoots: string[];
  repositories: LocalRepositoryIdentity[];
  writeOperations: false;
}

export interface GitChangeRequest {
  mode: GitChangeMode;
  base?: string;
  head?: string;
  options?: {
    includeUntracked?: boolean;
    maxFiles?: number;
  };
}

export interface LocalGitChangeResult {
  apiVersion: "1.0.0";
  repository: LocalRepositoryIdentity;
  comparison: GitChangeComparison;
  files: GitChangedFile[];
  statistics: GitChangeStatistics;
  warnings: string[];
  writeOperations: false;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function repositoryIdentity(value: unknown): value is LocalRepositoryIdentity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.owner === "string" &&
    typeof value.path === "string" &&
    typeof value.scanScope === "string" &&
    typeof value.revision === "string" &&
    typeof value.branch === "string" &&
    typeof value.dirty === "boolean"
  );
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function revisionReference(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.requested === "string" &&
    (value.resolved === null || typeof value.resolved === "string")
  );
}

function changedFile(value: unknown): value is GitChangedFile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    (value.previousPath === undefined || typeof value.previousPath === "string") &&
    ["added", "modified", "deleted", "renamed", "copied", "conflicted", "untracked"]
      .includes(String(value.status)) &&
    typeof value.statusCode === "string" &&
    typeof value.staged === "boolean" &&
    typeof value.unstaged === "boolean" &&
    typeof value.untracked === "boolean" &&
    typeof value.binary === "boolean" &&
    (value.additions === null || nonNegativeInteger(value.additions)) &&
    (value.deletions === null || nonNegativeInteger(value.deletions)) &&
    Array.isArray(value.hunks) &&
    value.hunks.every((hunk) =>
      isRecord(hunk) &&
      nonNegativeInteger(hunk.oldStart) &&
      nonNegativeInteger(hunk.oldLines) &&
      nonNegativeInteger(hunk.newStart) &&
      nonNegativeInteger(hunk.newLines))
  );
}

function changeResult(value: unknown): LocalGitChangeResult {
  if (!isRecord(value)) throw new TypeError("Git change response is not an object.");
  const comparison = value.comparison;
  const statistics = value.statistics;
  if (
    value.apiVersion !== "1.0.0" ||
    !repositoryIdentity(value.repository) ||
    !isRecord(comparison) ||
    (comparison.mode !== "working-tree" && comparison.mode !== "compare") ||
    !revisionReference(comparison.base) ||
    !revisionReference(comparison.head) ||
    typeof comparison.mergeBase !== "string" ||
    !Array.isArray(value.files) ||
    !value.files.every(changedFile) ||
    !isRecord(statistics) ||
    !nonNegativeInteger(statistics.files) ||
    !nonNegativeInteger(statistics.additions) ||
    !nonNegativeInteger(statistics.deletions) ||
    !nonNegativeInteger(statistics.binaryFiles) ||
    typeof statistics.truncated !== "boolean" ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string") ||
    value.writeOperations !== false
  ) {
    throw new TypeError("Git change response does not match API version 1.0.0.");
  }
  return value as unknown as LocalGitChangeResult;
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
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_LOCAL_REPOSITORY_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
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

  async listRepositories(signal?: AbortSignal): Promise<LocalRepositoryCatalog> {
    const value = await this.request("/api/v1/repositories", { signal });
    if (
      !isRecord(value) ||
      !Array.isArray(value.allowedRoots) ||
      !value.allowedRoots.every((root) => typeof root === "string") ||
      !Array.isArray(value.repositories) ||
      !value.repositories.every(repositoryIdentity) ||
      value.writeOperations !== false
    ) {
      throw new TypeError("Local repository catalog response is invalid.");
    }
    return value as unknown as LocalRepositoryCatalog;
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

  async changes(
    path: string,
    request: GitChangeRequest,
    signal?: AbortSignal,
  ): Promise<LocalGitChangeResult> {
    if (!path.trim()) throw new TypeError("Repository path is required.");
    const value = await this.request("/api/v1/repositories/changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...request }),
      signal,
    });
    return changeResult(value);
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
