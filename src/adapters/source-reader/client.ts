import type { LocalRepositoryIdentity } from "../local-repository";
import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEFAULT_SOURCE_READER_SERVER = "http://127.0.0.1:8765";

export interface SourceReadOptions {
  contextLines?: number;
  maxLines?: number;
  maxFileBytes?: number;
}

export interface SourceReadReference {
  path: string;
  revision?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export interface SourceExcerptLine {
  number: number;
  text: string;
  focus: boolean;
}

export interface SourceExcerptResult {
  apiVersion: "1.0.0";
  repository: LocalRepositoryIdentity;
  source: {
    path: string;
    language: string;
    encoding: string;
    contentSha256: string;
    requestedRevision: string | null;
    currentRevision: string;
    revisionMatches: boolean | null;
    contentBasis: "working-tree";
  };
  range: {
    requestedStartLine: number | null;
    requestedEndLine: number | null;
    focusStartLine: number;
    focusEndLine: number;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    focusTruncated: boolean;
  };
  lines: SourceExcerptLine[];
  readOnly: true;
  writeOperations: false;
}

interface SourceReaderClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nullablePositiveInteger(value: unknown) {
  return value === null || (nonNegativeInteger(value) && value > 0);
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

function parseResult(value: unknown): SourceExcerptResult {
  if (!isRecord(value)) throw new TypeError("Source response is not an object.");
  const source = value.source;
  const range = value.range;
  if (
    value.apiVersion !== "1.0.0" ||
    !repositoryIdentity(value.repository) ||
    !isRecord(source) ||
    typeof source.path !== "string" ||
    typeof source.language !== "string" ||
    typeof source.encoding !== "string" ||
    typeof source.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(source.contentSha256) ||
    (source.requestedRevision !== null && typeof source.requestedRevision !== "string") ||
    typeof source.currentRevision !== "string" ||
    (source.revisionMatches !== null && typeof source.revisionMatches !== "boolean") ||
    source.contentBasis !== "working-tree" ||
    !isRecord(range) ||
    !nullablePositiveInteger(range.requestedStartLine) ||
    !nullablePositiveInteger(range.requestedEndLine) ||
    !nonNegativeInteger(range.focusStartLine) ||
    !nonNegativeInteger(range.focusEndLine) ||
    !nonNegativeInteger(range.startLine) ||
    !nonNegativeInteger(range.endLine) ||
    !nonNegativeInteger(range.totalLines) ||
    typeof range.truncated !== "boolean" ||
    typeof range.focusTruncated !== "boolean" ||
    !Array.isArray(value.lines) ||
    !value.lines.every((line) =>
      isRecord(line) &&
      nonNegativeInteger(line.number) && line.number > 0 &&
      typeof line.text === "string" &&
      typeof line.focus === "boolean") ||
    value.readOnly !== true ||
    value.writeOperations !== false
  ) {
    throw new TypeError("Source response does not match API version 1.0.0.");
  }
  return value as unknown as SourceExcerptResult;
}

export class SourceReaderClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SourceReaderClientError";
  }
}

export class SourceReaderClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SourceReaderClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_SOURCE_READER_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async read(
    path: string,
    source: SourceReadReference,
    options: SourceReadOptions = {},
    signal?: AbortSignal,
  ): Promise<SourceExcerptResult> {
    if (!path.trim()) throw new TypeError("Repository path is required.");
    if (!source.path.trim()) throw new TypeError("Source relative path is required.");
    const response = await this.fetcher(
      `${this.baseUrl}/api/v1/repositories/source`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          relativePath: source.path,
          ...(source.startLine ? { startLine: source.startLine } : {}),
          ...(source.endLine ? { endLine: source.endLine } : {}),
          ...(source.revision ? { revision: source.revision } : {}),
          options,
        }),
        signal,
      },
    );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new SourceReaderClientError(
        "Local service returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new SourceReaderClientError(
        typeof error.message === "string" ? error.message : "Source read failed.",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return parseResult(value);
  }
}
