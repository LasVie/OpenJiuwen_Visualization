import { describe, expect, it, vi } from "vitest";
import {
  GitHubPullRequestClient,
  GitHubPullRequestClientError,
  parseGitHubPullRequestReference,
} from "./client";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const repository = {
  id: "repo-1",
  name: "agent-core",
  owner: "agent-core",
  path: "C:\\workspace\\agent-core",
  scanScope: "C:\\workspace\\agent-core",
  revision: "b".repeat(40),
  branch: "feature/pr",
  dirty: false,
};

const branch = {
  ref: "feature/pr",
  sha: "b".repeat(40),
  label: "LasVie:feature/pr",
  repository: "LasVie/agent-core",
};

const payload = {
  apiVersion: "1.0.0",
  repository,
  comparison: {
    mode: "github-pr",
    base: { requested: "develop", resolved: "a".repeat(40) },
    head: { requested: "feature/pr", resolved: "b".repeat(40) },
    mergeBase: null,
  },
  pullRequest: {
    provider: "github",
    owner: "LasVie",
    repository: "agent-core",
    number: 42,
    title: "Add observable rails",
    state: "open",
    draft: false,
    merged: false,
    author: "octocat",
    htmlUrl: "https://github.com/LasVie/agent-core/pull/42",
    head: branch,
    base: { ...branch, ref: "develop", sha: "a".repeat(40), label: "LasVie:develop" },
    changedFiles: 1,
    additions: 4,
    deletions: 2,
    rateLimit: { limit: 60, remaining: 58, resetEpoch: 1_770_000_000 },
  },
  files: [
    {
      id: "git-file:one",
      path: "src/main.py",
      status: "modified",
      statusCode: "M",
      staged: false,
      unstaged: false,
      untracked: false,
      binary: false,
      patchAvailable: true,
      additions: 4,
      deletions: 2,
      hunks: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 4 }],
    },
  ],
  statistics: { files: 1, additions: 4, deletions: 2, binaryFiles: 0, truncated: false },
  warnings: [],
  remoteOperations: { networkRead: true, mutation: false, authenticated: false },
  writeOperations: false,
};

describe("GitHub pull-request adapter", () => {
  it("parses canonical URLs and compact references without retaining URL noise", () => {
    expect(parseGitHubPullRequestReference(
      "https://github.com/LasVie/agent-core/pull/42?diff=split#files_bucket",
    )).toEqual({
      owner: "LasVie",
      repository: "agent-core",
      number: 42,
      canonicalUrl: "https://github.com/LasVie/agent-core/pull/42",
    });
    expect(parseGitHubPullRequestReference("LasVie/jiuwenswarm#7"))
      .toMatchObject({ repository: "jiuwenswarm", number: 7 });
  });

  it("rejects non-GitHub URLs, embedded credentials and malformed references", () => {
    expect(() => parseGitHubPullRequestReference("https://example.com/a/b/pull/1"))
      .toThrowError(/github.com/);
    expect(() => parseGitHubPullRequestReference("https://token@github.com/a/b/pull/1"))
      .toThrowError(/凭据/);
    expect(() => parseGitHubPullRequestReference("LasVie/agent-core#0"))
      .toThrowError();
    expect(() => parseGitHubPullRequestReference("LasVie/agent-core.GIT#1"))
      .toThrowError(/repository/);
  });

  it("requests structured PR data through the loopback service and validates it", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => response(payload),
    );
    const client = new GitHubPullRequestClient({ fetcher: fetcher as typeof fetch });
    const reference = parseGitHubPullRequestReference("LasVie/agent-core#42");

    const result = await client.inspect(repository.path, reference, { maxFiles: 500 });

    expect(result.pullRequest).toMatchObject({ number: 42, state: "open" });
    expect(result.files[0]).toMatchObject({ path: "src/main.py", patchAvailable: true });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/repositories/github/pull-request",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      path: repository.path,
      owner: "LasVie",
      repository: "agent-core",
      pullNumber: 42,
      options: { maxFiles: 500 },
    });
  });

  it("preserves structured server errors", async () => {
    const client = new GitHubPullRequestClient({
      fetcher: vi.fn(async () => response({
        error: { code: "github_rate_limited", message: "Retry later." },
      }, 429)) as typeof fetch,
    });
    const error = await client.inspect(
      repository.path,
      parseGitHubPullRequestReference("LasVie/agent-core#42"),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GitHubPullRequestClientError);
    expect(error).toMatchObject({ status: 429, code: "github_rate_limited" });
  });
});
