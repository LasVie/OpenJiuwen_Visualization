import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEFAULT_DEVELOPMENT_SESSION_SERVER = "http://127.0.0.1:8765";

export interface DevelopmentSessionStorageDescriptor {
  engine: "sqlite";
  journalMode: "wal";
  schemaVersion: number;
  databaseFile: string;
  retentionDays: number;
  maxBytes: number;
  storedBytes: number;
  sessionCount: number;
  oldestAt: string | null;
  newestAt: string | null;
  fullAnalysisStored: true;
  fullReadPolicy: "restore-or-export";
  localOnly: true;
}

export interface DevelopmentSessionSummary {
  id: string;
  label: string;
  intentPreview: string;
  repository: {
    name: string;
    owner: string;
    path: string;
    branch: string;
    revision: string;
    dirty: boolean;
  };
  engine: "deterministic-static";
  entryPlane: "runtime" | "definition" | "change" | null;
  counts: {
    evidence: number;
    impacts: number;
    changes: number;
    tests: number;
    patches: number;
  };
  createdAt: string;
  updatedAt: string;
  byteCount: number;
  contentSha256: string;
  schemaVersion: number;
  fullAnalysisStored: true;
}

export interface DevelopmentSessionList {
  apiVersion: "1.0.0";
  storage: DevelopmentSessionStorageDescriptor;
  sessions: DevelopmentSessionSummary[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
  fullAnalysisIncluded: false;
}

export interface DevelopmentSessionDetail {
  apiVersion: "1.0.0";
  session: DevelopmentSessionSummary;
  analysis: Record<string, unknown>;
  fullAnalysisIncluded: true;
  localOnly: true;
}

export interface DevelopmentSessionExport {
  apiVersion: "1.0.0";
  exportedAt: string;
  session: DevelopmentSessionSummary;
  analysis: Record<string, unknown>;
  containsFullAnalysis: true;
  localSource: true;
}

interface DevelopmentSessionClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function storageDescriptor(value: unknown): value is DevelopmentSessionStorageDescriptor {
  return (
    isRecord(value) &&
    value.engine === "sqlite" &&
    value.journalMode === "wal" &&
    nonNegativeInteger(value.schemaVersion) &&
    typeof value.databaseFile === "string" &&
    nonNegativeInteger(value.retentionDays) &&
    nonNegativeInteger(value.maxBytes) &&
    nonNegativeInteger(value.storedBytes) &&
    nonNegativeInteger(value.sessionCount) &&
    nullableTimestamp(value.oldestAt) &&
    nullableTimestamp(value.newestAt) &&
    value.fullAnalysisStored === true &&
    value.fullReadPolicy === "restore-or-export" &&
    value.localOnly === true
  );
}

function repositorySummary(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.owner === "string" &&
    typeof value.path === "string" &&
    typeof value.branch === "string" &&
    typeof value.revision === "string" &&
    typeof value.dirty === "boolean"
  );
}

function sessionCounts(value: unknown) {
  return (
    isRecord(value) &&
    nonNegativeInteger(value.evidence) &&
    nonNegativeInteger(value.impacts) &&
    nonNegativeInteger(value.changes) &&
    nonNegativeInteger(value.tests) &&
    nonNegativeInteger(value.patches)
  );
}

function sessionSummary(value: unknown): value is DevelopmentSessionSummary {
  return (
    isRecord(value) &&
    /^dev_[0-9a-f]{32}$/.test(String(value.id)) &&
    typeof value.label === "string" &&
    typeof value.intentPreview === "string" &&
    repositorySummary(value.repository) &&
    value.engine === "deterministic-static" &&
    (value.entryPlane === null || ["runtime", "definition", "change"].includes(String(value.entryPlane))) &&
    sessionCounts(value.counts) &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt) &&
    nonNegativeInteger(value.byteCount) &&
    /^[0-9a-f]{64}$/.test(String(value.contentSha256)) &&
    nonNegativeInteger(value.schemaVersion) &&
    value.fullAnalysisStored === true
  );
}

function parseList(value: unknown): DevelopmentSessionList {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !storageDescriptor(value.storage) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(sessionSummary) ||
    !isRecord(value.pagination) ||
    !nonNegativeInteger(value.pagination.limit) ||
    !nonNegativeInteger(value.pagination.offset) ||
    !nonNegativeInteger(value.pagination.total) ||
    typeof value.pagination.hasMore !== "boolean" ||
    value.fullAnalysisIncluded !== false
  ) {
    throw new TypeError("Development Session list does not match API version 1.0.0.");
  }
  return value as unknown as DevelopmentSessionList;
}

function parseCreated(value: unknown): DevelopmentSessionSummary {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !sessionSummary(value.session) ||
    value.analysisStored !== true ||
    value.localOnly !== true
  ) {
    throw new TypeError("Created Development Session does not match API version 1.0.0.");
  }
  return value.session;
}

function parseDetail(value: unknown): DevelopmentSessionDetail {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !sessionSummary(value.session) ||
    !isRecord(value.analysis) ||
    value.fullAnalysisIncluded !== true ||
    value.localOnly !== true
  ) {
    throw new TypeError("Development Session detail does not match API version 1.0.0.");
  }
  return value as unknown as DevelopmentSessionDetail;
}

function parseExport(value: unknown): DevelopmentSessionExport {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !timestamp(value.exportedAt) ||
    !sessionSummary(value.session) ||
    !isRecord(value.analysis) ||
    value.containsFullAnalysis !== true ||
    value.localSource !== true
  ) {
    throw new TypeError("Development Session export does not match API version 1.0.0.");
  }
  return value as unknown as DevelopmentSessionExport;
}

export class DevelopmentSessionClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "DevelopmentSessionClientError";
  }
}

export class DevelopmentSessionClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: DevelopmentSessionClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_DEVELOPMENT_SESSION_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listSessions(
    options: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return parseList(await this.request(
      `/api/v1/development/sessions?limit=${limit}&offset=${offset}`,
      { signal },
    ));
  }

  async createSession(
    analysis: Record<string, unknown>,
    options: { label?: string } = {},
    signal?: AbortSignal,
  ) {
    const value = await this.request("/api/v1/development/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysis,
        ...(options.label ? { label: options.label } : {}),
      }),
      signal,
    });
    return parseCreated(value);
  }

  async getSession(sessionId: string, signal?: AbortSignal) {
    const value = await this.request(
      `/api/v1/development/sessions/${encodeURIComponent(this.sessionId(sessionId))}`,
      { signal },
    );
    return parseDetail(value);
  }

  async exportSession(sessionId: string, signal?: AbortSignal) {
    const value = await this.request(
      `/api/v1/development/sessions/${encodeURIComponent(this.sessionId(sessionId))}/export`,
      { signal },
    );
    return parseExport(value);
  }

  async deleteSession(sessionId: string, signal?: AbortSignal) {
    const value = await this.request(
      `/api/v1/development/sessions/${encodeURIComponent(this.sessionId(sessionId))}`,
      { method: "DELETE", signal },
    );
    if (
      !isRecord(value) ||
      value.apiVersion !== "1.0.0" ||
      value.deleted !== true ||
      value.deletedFullAnalysis !== true
    ) {
      throw new TypeError("Development Session delete response is invalid.");
    }
  }

  private sessionId(value: string) {
    const sessionId = value.trim();
    if (!/^dev_[0-9a-f]{32}$/.test(sessionId)) {
      throw new TypeError("Development Session id is invalid.");
    }
    return sessionId;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      cache: "no-store",
      ...init,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DevelopmentSessionClientError(
        "Local Development Session service returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : null;
      throw new DevelopmentSessionClientError(
        error && typeof error.message === "string"
          ? error.message
          : "Local Development Session request failed.",
        response.status,
        error && typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
