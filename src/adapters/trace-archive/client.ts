import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEFAULT_TRACE_ARCHIVE_SERVER = "http://127.0.0.1:8765";

export type ArchivedTraceOwner = "agent-core" | "jiuwenswarm";
export type ArchivedTraceStatus = "open" | "completed" | "failed";

export interface ArchiveStorageDescriptor {
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
  rawTextStored: true;
  rawReadPolicy: "explicit-only";
  localOnly: true;
}

export interface ArchivedTraceSession {
  id: string;
  owner: ArchivedTraceOwner;
  label: string;
  status: ArchivedTraceStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  eventCount: number;
  lastSequence: number;
  maxTokens: number;
  byteCount: number;
  storedRawBytes: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  contextMessageCount: number;
  schemaVersion: number;
  rawTextStored: true;
}

export interface ArchivedEventPreview extends Record<string, unknown> {
  eventId: string;
  traceId: string;
  sequence: number;
  receivedAt: string;
  kind: string;
  phase: string;
  timestampMs: number;
  title?: string;
  summary?: string;
  rawAvailable: true;
}

export interface ArchivedSessionDetail {
  apiVersion: "1.0.0";
  session: ArchivedTraceSession;
  events: ArchivedEventPreview[];
  page: {
    after: number;
    lastSequence: number;
    hasMore: boolean;
  };
  rawIncluded: false;
}

export interface ArchiveSessionList {
  apiVersion: "1.0.0";
  storage: ArchiveStorageDescriptor;
  sessions: ArchivedTraceSession[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

export interface ArchivedRawEvent extends Record<string, unknown> {
  eventId: string;
  traceId: string;
  sequence: number;
  kind: string;
  phase: string;
}

export interface RawEventResponse {
  apiVersion: "1.0.0";
  traceId: string;
  events: ArchivedRawEvent[];
  rawIncluded: true;
  localOnly: true;
}

export interface RawContextMessage {
  id: string;
  role: string;
  label: string;
  raw: string;
  preview?: string;
  tokens: number;
  source: string;
}

export interface RawContextFrame {
  sequence: number;
  operation: string;
  ownerId?: string;
  messages: RawContextMessage[];
  removeMessageIds: string[];
}

export interface RawContextResponse {
  apiVersion: "1.0.0";
  traceId: string;
  frames: RawContextFrame[];
  rawIncluded: true;
  localOnly: true;
}

export interface FullArchiveExport {
  apiVersion: "1.0.0";
  exportedAt: string;
  session: ArchivedTraceSession;
  events: ArchivedRawEvent[];
  containsFullText: true;
  localSource: true;
}

interface TraceArchiveClientOptions {
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

function storageDescriptor(value: unknown): value is ArchiveStorageDescriptor {
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
    value.rawTextStored === true &&
    value.rawReadPolicy === "explicit-only" &&
    value.localOnly === true
  );
}

function archivedSession(value: unknown): value is ArchivedTraceSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.owner === "agent-core" || value.owner === "jiuwenswarm") &&
    typeof value.label === "string" &&
    ["open", "completed", "failed"].includes(String(value.status)) &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt) &&
    timestamp(value.archivedAt) &&
    nonNegativeInteger(value.eventCount) &&
    nonNegativeInteger(value.lastSequence) &&
    nonNegativeInteger(value.maxTokens) &&
    nonNegativeInteger(value.byteCount) &&
    nonNegativeInteger(value.storedRawBytes) &&
    nonNegativeInteger(value.totalTokens) &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.outputTokens) &&
    nonNegativeInteger(value.costMicros) &&
    nonNegativeInteger(value.contextMessageCount) &&
    nonNegativeInteger(value.schemaVersion) &&
    value.rawTextStored === true
  );
}

function eventPreview(value: unknown): value is ArchivedEventPreview {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.traceId === "string" &&
    nonNegativeInteger(value.sequence) &&
    timestamp(value.receivedAt) &&
    typeof value.kind === "string" &&
    typeof value.phase === "string" &&
    typeof value.timestampMs === "number" &&
    value.rawAvailable === true
  );
}

function rawEvent(value: unknown): value is ArchivedRawEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.traceId === "string" &&
    nonNegativeInteger(value.sequence) &&
    typeof value.kind === "string" &&
    typeof value.phase === "string"
  );
}

function rawContextMessage(value: unknown): value is RawContextMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    typeof value.label === "string" &&
    typeof value.raw === "string" &&
    (value.preview === undefined || typeof value.preview === "string") &&
    typeof value.tokens === "number" &&
    typeof value.source === "string"
  );
}

function parseSessionList(value: unknown): ArchiveSessionList {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !storageDescriptor(value.storage) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(archivedSession) ||
    !isRecord(value.pagination) ||
    !nonNegativeInteger(value.pagination.limit) ||
    !nonNegativeInteger(value.pagination.offset) ||
    !nonNegativeInteger(value.pagination.total) ||
    typeof value.pagination.hasMore !== "boolean"
  ) {
    throw new TypeError("Trace archive list does not match API version 1.0.0.");
  }
  return value as unknown as ArchiveSessionList;
}

function parseSessionDetail(value: unknown): ArchivedSessionDetail {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !archivedSession(value.session) ||
    !Array.isArray(value.events) ||
    !value.events.every(eventPreview) ||
    !isRecord(value.page) ||
    !nonNegativeInteger(value.page.after) ||
    !nonNegativeInteger(value.page.lastSequence) ||
    typeof value.page.hasMore !== "boolean" ||
    value.rawIncluded !== false
  ) {
    throw new TypeError("Archived trace does not match API version 1.0.0.");
  }
  return value as unknown as ArchivedSessionDetail;
}

function parseRawEvents(value: unknown): RawEventResponse {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    typeof value.traceId !== "string" ||
    !Array.isArray(value.events) ||
    !value.events.every(rawEvent) ||
    value.rawIncluded !== true ||
    value.localOnly !== true
  ) {
    throw new TypeError("Raw trace event response does not match API version 1.0.0.");
  }
  return value as unknown as RawEventResponse;
}

function parseRawContext(value: unknown): RawContextResponse {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    typeof value.traceId !== "string" ||
    !Array.isArray(value.frames) ||
    !value.frames.every((frame) =>
      isRecord(frame) &&
      nonNegativeInteger(frame.sequence) &&
      typeof frame.operation === "string" &&
      (frame.ownerId === undefined || typeof frame.ownerId === "string") &&
      Array.isArray(frame.messages) &&
      frame.messages.every(rawContextMessage) &&
      Array.isArray(frame.removeMessageIds) &&
      frame.removeMessageIds.every((id) => typeof id === "string")) ||
    value.rawIncluded !== true ||
    value.localOnly !== true
  ) {
    throw new TypeError("Raw Context response does not match API version 1.0.0.");
  }
  return value as unknown as RawContextResponse;
}

function parseExport(value: unknown): FullArchiveExport {
  if (
    !isRecord(value) ||
    value.apiVersion !== "1.0.0" ||
    !timestamp(value.exportedAt) ||
    !archivedSession(value.session) ||
    !Array.isArray(value.events) ||
    !value.events.every(rawEvent) ||
    value.containsFullText !== true ||
    value.localSource !== true
  ) {
    throw new TypeError("Trace archive export does not match API version 1.0.0.");
  }
  return value as unknown as FullArchiveExport;
}

export class TraceArchiveClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "TraceArchiveClientError";
  }
}

export class TraceArchiveClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: TraceArchiveClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_TRACE_ARCHIVE_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listSessions(
    options: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ArchiveSessionList> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const value = await this.request(
      `/api/v1/archive/sessions?limit=${limit}&offset=${offset}`,
      { signal },
    );
    return parseSessionList(value);
  }

  async getSession(traceId: string, signal?: AbortSignal): Promise<ArchivedSessionDetail> {
    const id = this.traceId(traceId);
    const events: ArchivedEventPreview[] = [];
    let after = 0;
    while (true) {
      const value = await this.request(
        `/api/v1/archive/sessions/${encodeURIComponent(id)}?after=${after}&limit=500`,
        { signal },
      );
      const page = parseSessionDetail(value);
      events.push(...page.events);
      if (!page.page.hasMore) {
        return { ...page, events, page: { ...page.page, after: 0 } };
      }
      if (page.page.lastSequence <= after) {
        throw new TypeError("Archived trace pagination did not advance.");
      }
      after = page.page.lastSequence;
    }
  }

  async revealEvents(
    traceId: string,
    sequences: readonly number[],
    signal?: AbortSignal,
  ): Promise<RawEventResponse> {
    if (
      sequences.length < 1 ||
      sequences.length > 100 ||
      sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)
    ) {
      throw new TypeError("Raw event sequences must contain 1..100 positive integers.");
    }
    const value = await this.request(
      `/api/v1/archive/sessions/${encodeURIComponent(this.traceId(traceId))}/raw`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "events", sequences }),
        signal,
      },
    );
    return parseRawEvents(value);
  }

  async revealContext(traceId: string, signal?: AbortSignal): Promise<RawContextResponse> {
    const value = await this.request(
      `/api/v1/archive/sessions/${encodeURIComponent(this.traceId(traceId))}/raw`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "context" }),
        signal,
      },
    );
    return parseRawContext(value);
  }

  async exportSession(traceId: string, signal?: AbortSignal): Promise<FullArchiveExport> {
    const value = await this.request(
      `/api/v1/archive/sessions/${encodeURIComponent(this.traceId(traceId))}/export`,
      { signal },
    );
    return parseExport(value);
  }

  async deleteSession(traceId: string, signal?: AbortSignal): Promise<void> {
    const value = await this.request(
      `/api/v1/archive/sessions/${encodeURIComponent(this.traceId(traceId))}`,
      { method: "DELETE", signal },
    );
    if (!isRecord(value) || value.deleted !== true || value.deletedFullText !== true) {
      throw new TypeError("Trace archive delete response is invalid.");
    }
  }

  private traceId(value: string) {
    const id = value.trim();
    if (!id || id.length > 200 || id.includes("/")) {
      throw new TypeError("Archive trace id is invalid.");
    }
    return id;
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
      throw new TraceArchiveClientError(
        "Local archive service returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : null;
      throw new TraceArchiveClientError(
        error && typeof error.message === "string"
          ? error.message
          : "Local archive request failed.",
        response.status,
        error && typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
