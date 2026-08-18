import type {
  GitChangeComparison,
  GitChangedFile,
  GitChangeSet,
  GitChangeStatistics,
} from "../../kernel";
import type { LocalRepositoryIdentity } from "../local-repository";
import { loopbackHttpOrigin } from "../local-service/base-url";

export const DEFAULT_GITHUB_PULL_REQUEST_SERVER = "http://127.0.0.1:8765";

export interface GitHubPullRequestReference {
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
}

export interface GitHubPullRequestBranch {
  ref: string;
  sha: string;
  label: string;
  repository: string | null;
}

export interface GitHubRateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  resetEpoch: number | null;
}

export interface GitHubPullRequestSummary {
  provider: "github";
  owner: string;
  repository: string;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  author: string;
  htmlUrl: string;
  head: GitHubPullRequestBranch;
  base: GitHubPullRequestBranch;
  changedFiles: number;
  additions: number;
  deletions: number;
  rateLimit: GitHubRateLimitSnapshot;
}

export interface GitHubPullRequestResult extends GitChangeSet {
  apiVersion: "1.0.0";
  repository: LocalRepositoryIdentity;
  comparison: GitChangeComparison & { mode: "github-pr"; mergeBase: null };
  pullRequest: GitHubPullRequestSummary;
  files: GitChangedFile[];
  statistics: GitChangeStatistics;
  warnings: string[];
  remoteOperations: {
    networkRead: true;
    mutation: false;
    authenticated: boolean;
  };
  writeOperations: false;
}

interface GitHubPullRequestClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function validateReference(owner: string, repository: string, number: number) {
  if (!OWNER_PATTERN.test(owner)) {
    throw new TypeError("GitHub owner 格式无效。");
  }
  if (
    !REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".." ||
    repository.toLowerCase().endsWith(".git")
  ) {
    throw new TypeError("GitHub repository 格式无效。");
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError("PR 编号必须是正整数。");
  }
  return {
    owner,
    repository,
    number,
    canonicalUrl: `https://github.com/${owner}/${repository}/pull/${number}`,
  } satisfies GitHubPullRequestReference;
}

export function parseGitHubPullRequestReference(
  input: string,
): GitHubPullRequestReference {
  const value = input.trim();
  const shorthand = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(value);
  if (shorthand) {
    return validateReference(shorthand[1], shorthand[2], Number(shorthand[3]));
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("请输入 GitHub PR URL 或 owner/repo#编号。");
  }
  if (
    url.protocol !== "https:" ||
    !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new TypeError("只接受不含凭据的 github.com HTTPS PR 地址。");
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match) throw new TypeError("GitHub 地址必须指向具体 Pull Request。");
  return validateReference(match[1], match[2], Number(match[3]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nullableNonNegativeInteger(value: unknown) {
  return value === null || nonNegativeInteger(value);
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

function revisionReference(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.requested === "string" &&
    typeof value.resolved === "string"
  );
}

function changedFile(value: unknown): value is GitChangedFile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    (value.previousPath === undefined || typeof value.previousPath === "string") &&
    ["added", "modified", "deleted", "renamed", "copied"].includes(String(value.status)) &&
    typeof value.statusCode === "string" &&
    value.staged === false &&
    value.unstaged === false &&
    value.untracked === false &&
    typeof value.binary === "boolean" &&
    typeof value.patchAvailable === "boolean" &&
    nonNegativeInteger(value.additions) &&
    nonNegativeInteger(value.deletions) &&
    Array.isArray(value.hunks) &&
    value.hunks.every((hunk) =>
      isRecord(hunk) &&
      nonNegativeInteger(hunk.oldStart) &&
      nonNegativeInteger(hunk.oldLines) &&
      nonNegativeInteger(hunk.newStart) &&
      nonNegativeInteger(hunk.newLines))
  );
}

function branch(value: unknown): value is GitHubPullRequestBranch {
  return (
    isRecord(value) &&
    typeof value.ref === "string" &&
    typeof value.sha === "string" &&
    typeof value.label === "string" &&
    (value.repository === null || typeof value.repository === "string")
  );
}

function rateLimit(value: unknown): value is GitHubRateLimitSnapshot {
  return (
    isRecord(value) &&
    nullableNonNegativeInteger(value.limit) &&
    nullableNonNegativeInteger(value.remaining) &&
    nullableNonNegativeInteger(value.resetEpoch)
  );
}

function pullRequest(value: unknown): value is GitHubPullRequestSummary {
  return (
    isRecord(value) &&
    value.provider === "github" &&
    typeof value.owner === "string" &&
    typeof value.repository === "string" &&
    nonNegativeInteger(value.number) && value.number > 0 &&
    typeof value.title === "string" &&
    (value.state === "open" || value.state === "closed") &&
    typeof value.draft === "boolean" &&
    typeof value.merged === "boolean" &&
    typeof value.author === "string" &&
    typeof value.htmlUrl === "string" &&
    branch(value.head) &&
    branch(value.base) &&
    nonNegativeInteger(value.changedFiles) &&
    nonNegativeInteger(value.additions) &&
    nonNegativeInteger(value.deletions) &&
    rateLimit(value.rateLimit)
  );
}

function parseResult(value: unknown): GitHubPullRequestResult {
  if (!isRecord(value)) throw new TypeError("GitHub PR response is not an object.");
  const comparison = value.comparison;
  const statistics = value.statistics;
  const remoteOperations = value.remoteOperations;
  if (
    value.apiVersion !== "1.0.0" ||
    !repositoryIdentity(value.repository) ||
    !isRecord(comparison) ||
    comparison.mode !== "github-pr" ||
    !revisionReference(comparison.base) ||
    !revisionReference(comparison.head) ||
    comparison.mergeBase !== null ||
    !pullRequest(value.pullRequest) ||
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
    !isRecord(remoteOperations) ||
    remoteOperations.networkRead !== true ||
    remoteOperations.mutation !== false ||
    typeof remoteOperations.authenticated !== "boolean" ||
    value.writeOperations !== false
  ) {
    throw new TypeError("GitHub PR response does not match API version 1.0.0.");
  }
  return value as unknown as GitHubPullRequestResult;
}

export class GitHubPullRequestClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GitHubPullRequestClientError";
  }
}

export class GitHubPullRequestClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: GitHubPullRequestClientOptions = {}) {
    this.baseUrl = loopbackHttpOrigin(
      options.baseUrl ?? DEFAULT_GITHUB_PULL_REQUEST_SERVER,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async inspect(
    path: string,
    reference: GitHubPullRequestReference,
    options: { maxFiles?: number } = {},
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestResult> {
    if (!path.trim()) throw new TypeError("Repository path is required.");
    const validated = validateReference(
      reference.owner,
      reference.repository,
      reference.number,
    );
    const response = await this.fetcher(
      `${this.baseUrl}/api/v1/repositories/github/pull-request`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          owner: validated.owner,
          repository: validated.repository,
          pullNumber: validated.number,
          options,
        }),
        signal,
      },
    );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GitHubPullRequestClientError(
        "Local service returned invalid JSON.",
        response.status,
        "invalid_json",
      );
    }
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new GitHubPullRequestClientError(
        typeof error.message === "string" ? error.message : "GitHub PR request failed.",
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return parseResult(value);
  }
}
