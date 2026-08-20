import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEVELOPMENT_EXECUTION_API_VERSION = "1.0.0" as const;
export const DEFAULT_DEVELOPMENT_EXECUTION_SERVER = "http://127.0.0.1:8765";

export type DevelopmentExecutionStatus =
  | "previewed"
  | "applying"
  | "applied"
  | "testing"
  | "tested"
  | "test_failed"
  | "committing"
  | "committed"
  | "failed"
  | "rolled_back";

export interface DevelopmentExecutionFile {
  path: string;
  additions: number;
  deletions: number;
  added: boolean;
}

export interface DevelopmentTestProfile {
  id: string;
  label: string;
  command: string;
  workingDirectory: ".";
  timeoutSeconds: number;
  planSha256: string;
}

export interface DevelopmentTestResult {
  profileId: string;
  label: string;
  command: string;
  planSha256: string;
  status: "passed" | "failed" | "timed-out";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  trackedSideEffects: string[];
}

export interface DevelopmentExecutionEvent {
  id: number;
  timestampMs: number;
  action: string;
  outcome: string;
  detailCode: string;
}

export interface DevelopmentExecution {
  id: string;
  repository: {
    id: string;
    name: string;
    path: string;
    sourceBranch: string;
    baseRevision: string;
  };
  branchName: string;
  worktreePath: string;
  status: DevelopmentExecutionStatus;
  patchSha256: string;
  previewSha256: string;
  files: DevelopmentExecutionFile[];
  statistics: {
    files: number;
    additions: number;
    deletions: number;
    bytes: number;
  };
  testProfiles: DevelopmentTestProfile[];
  lastTest: DevelopmentTestResult | null;
  commitSha: string | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  policy: {
    sourceWorkingTreeWrite: false;
    isolatedWorktree: true;
    exactPathAllowlist: true;
    arbitraryCommands: false;
    perOperationConfirmation: true;
    automaticPush: false;
    rollbackAvailable: boolean;
  };
  approvals: {
    applySha256: string;
    rollbackSha256: string;
    commitPreviewRequired: true;
  };
  intent?: string;
  unifiedDiff?: string;
  appliedDiff?: string | null;
  appliedDiffSha256?: string | null;
  events?: DevelopmentExecutionEvent[];
}

export interface DevelopmentExecutionPage {
  apiVersion: typeof DEVELOPMENT_EXECUTION_API_VERSION;
  executions: DevelopmentExecution[];
  total: number;
  limit: number;
  offset: number;
}

export interface DevelopmentCommitPreview {
  executionId: string;
  branchName: string;
  message: string;
  stagedDiffSha256: string;
  approvalSha256: string;
  push: false;
}

interface ClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function sha256(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function executionFile(value: unknown): value is DevelopmentExecutionFile {
  return (
    record(value) &&
    typeof value.path === "string" &&
    nonNegativeInteger(value.additions) &&
    nonNegativeInteger(value.deletions) &&
    typeof value.added === "boolean"
  );
}

function testProfile(value: unknown): value is DevelopmentTestProfile {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.command === "string" &&
    value.workingDirectory === "." &&
    nonNegativeInteger(value.timeoutSeconds) &&
    sha256(value.planSha256)
  );
}

function testResult(value: unknown): value is DevelopmentTestResult {
  return (
    record(value) &&
    typeof value.profileId === "string" &&
    typeof value.label === "string" &&
    typeof value.command === "string" &&
    sha256(value.planSha256) &&
    ["passed", "failed", "timed-out"].includes(String(value.status)) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    nonNegativeInteger(value.durationMs) &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    Array.isArray(value.trackedSideEffects) &&
    value.trackedSideEffects.every((item) => typeof item === "string")
  );
}

function executionEvent(value: unknown): value is DevelopmentExecutionEvent {
  return (
    record(value) &&
    nonNegativeInteger(value.id) &&
    nonNegativeInteger(value.timestampMs) &&
    typeof value.action === "string" &&
    typeof value.outcome === "string" &&
    typeof value.detailCode === "string"
  );
}

function parseExecution(value: unknown): DevelopmentExecution {
  if (!record(value)) throw new TypeError("Controlled execution is not an object.");
  const repository = value.repository;
  const statistics = value.statistics;
  const policy = value.policy;
  const approvals = value.approvals;
  if (
    typeof value.id !== "string" ||
    !record(repository) ||
    typeof repository.id !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.path !== "string" ||
    typeof repository.sourceBranch !== "string" ||
    typeof repository.baseRevision !== "string" ||
    typeof value.branchName !== "string" ||
    typeof value.worktreePath !== "string" ||
    ![
      "previewed", "applying", "applied", "testing", "tested",
      "test_failed", "committing", "committed", "failed", "rolled_back",
    ].includes(String(value.status)) ||
    !sha256(value.patchSha256) ||
    !sha256(value.previewSha256) ||
    !Array.isArray(value.files) ||
    !value.files.every(executionFile) ||
    !record(statistics) ||
    !nonNegativeInteger(statistics.files) ||
    !nonNegativeInteger(statistics.additions) ||
    !nonNegativeInteger(statistics.deletions) ||
    !nonNegativeInteger(statistics.bytes) ||
    !Array.isArray(value.testProfiles) ||
    !value.testProfiles.every(testProfile) ||
    !(value.lastTest === null || testResult(value.lastTest)) ||
    !nullableString(value.commitSha) ||
    !nullableString(value.lastErrorCode) ||
    !nonNegativeInteger(value.createdAtMs) ||
    !nonNegativeInteger(value.updatedAtMs) ||
    !record(policy) ||
    policy.sourceWorkingTreeWrite !== false ||
    policy.isolatedWorktree !== true ||
    policy.exactPathAllowlist !== true ||
    policy.arbitraryCommands !== false ||
    policy.perOperationConfirmation !== true ||
    policy.automaticPush !== false ||
    typeof policy.rollbackAvailable !== "boolean" ||
    !record(approvals) ||
    !sha256(approvals.applySha256) ||
    !sha256(approvals.rollbackSha256) ||
    approvals.commitPreviewRequired !== true ||
    (value.intent !== undefined && typeof value.intent !== "string") ||
    (value.unifiedDiff !== undefined && typeof value.unifiedDiff !== "string") ||
    (value.appliedDiff !== undefined && !nullableString(value.appliedDiff)) ||
    (value.appliedDiffSha256 !== undefined && !nullableString(value.appliedDiffSha256)) ||
    (value.events !== undefined && (
      !Array.isArray(value.events) || !value.events.every(executionEvent)
    ))
  ) {
    throw new TypeError("Controlled execution does not match API version 1.0.0.");
  }
  return value as unknown as DevelopmentExecution;
}

function executionResponse(value: unknown) {
  if (
    !record(value) ||
    value.apiVersion !== DEVELOPMENT_EXECUTION_API_VERSION
  ) {
    throw new TypeError("Controlled execution response has an invalid version.");
  }
  return parseExecution(value.execution);
}

function executionPage(value: unknown): DevelopmentExecutionPage {
  if (
    !record(value) ||
    value.apiVersion !== DEVELOPMENT_EXECUTION_API_VERSION ||
    !Array.isArray(value.executions) ||
    !nonNegativeInteger(value.total) ||
    !nonNegativeInteger(value.limit) ||
    !nonNegativeInteger(value.offset)
  ) {
    throw new TypeError("Controlled execution list is invalid.");
  }
  return {
    apiVersion: DEVELOPMENT_EXECUTION_API_VERSION,
    executions: value.executions.map(parseExecution),
    total: value.total as number,
    limit: value.limit as number,
    offset: value.offset as number,
  };
}

function commitPreviewResponse(value: unknown): DevelopmentCommitPreview {
  if (
    !record(value) ||
    value.apiVersion !== DEVELOPMENT_EXECUTION_API_VERSION ||
    !record(value.commitPreview)
  ) {
    throw new TypeError("Commit preview response is invalid.");
  }
  const preview = value.commitPreview;
  if (
    typeof preview.executionId !== "string" ||
    typeof preview.branchName !== "string" ||
    typeof preview.message !== "string" ||
    !sha256(preview.stagedDiffSha256) ||
    !sha256(preview.approvalSha256) ||
    preview.push !== false
  ) {
    throw new TypeError("Commit preview does not match API version 1.0.0.");
  }
  return preview as unknown as DevelopmentCommitPreview;
}

export class DevelopmentExecutionClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "DevelopmentExecutionClientError";
  }
}

export class DevelopmentExecutionClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_DEVELOPMENT_EXECUTION_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async list(limit = 50, offset = 0, signal?: AbortSignal) {
    return executionPage(await this.request(
      `/api/v1/development/executions?limit=${limit}&offset=${offset}`,
      { signal },
    ));
  }

  async get(executionId: string, signal?: AbortSignal) {
    return executionResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(executionId)}`,
      { signal },
    ));
  }

  async preview(
    request: {
      repositoryPath: string;
      baseRevision: string;
      intent: string;
      unifiedDiff: string;
    },
    signal?: AbortSignal,
  ) {
    return executionResponse(await this.request(
      "/api/v1/development/executions",
      this.json("POST", request, signal),
    ));
  }

  async apply(execution: DevelopmentExecution, confirmed: boolean) {
    return executionResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(execution.id)}/apply`,
      this.json("POST", {
        previewSha256: execution.previewSha256,
        confirmed,
      }),
    ));
  }

  async runTest(
    execution: DevelopmentExecution,
    profile: DevelopmentTestProfile,
    confirmed: boolean,
  ) {
    return executionResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(execution.id)}/tests`,
      this.json("POST", {
        previewSha256: execution.previewSha256,
        profileId: profile.id,
        planSha256: profile.planSha256,
        confirmed,
      }),
    ));
  }

  async previewCommit(execution: DevelopmentExecution, message: string) {
    return commitPreviewResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(execution.id)}/commit-preview`,
      this.json("POST", {
        previewSha256: execution.previewSha256,
        message,
      }),
    ));
  }

  async commit(
    execution: DevelopmentExecution,
    preview: DevelopmentCommitPreview,
    confirmed: boolean,
  ) {
    return executionResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(execution.id)}/commit`,
      this.json("POST", {
        previewSha256: execution.previewSha256,
        approvalSha256: preview.approvalSha256,
        message: preview.message,
        confirmed,
      }),
    ));
  }

  async rollback(execution: DevelopmentExecution, confirmed: boolean) {
    return executionResponse(await this.request(
      `/api/v1/development/executions/${encodeURIComponent(execution.id)}/rollback`,
      this.json("POST", {
        previewSha256: execution.previewSha256,
        approvalSha256: execution.approvals.rollbackSha256,
        confirmed,
      }),
    ));
  }

  private json(method: string, body: object, signal?: AbortSignal): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    };
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
      throw new DevelopmentExecutionClientError(
        "本地服务返回了无效的受控执行 JSON。",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = record(value) && record(value.error) ? value.error : {};
      throw new DevelopmentExecutionClientError(
        typeof error.message === "string" ? error.message : "受控执行请求失败。",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return value;
  }
}
