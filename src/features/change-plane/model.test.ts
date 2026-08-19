import { describe, expect, it } from "vitest";
import type { LocalGitChangeResult, LocalRepositoryScanResult } from "../../adapters/local-repository";
import type { GitHubPullRequestResult } from "../../adapters/github-pull-request";
import type { RuntimeTraceEvent } from "../../kernel";
import { projectChangeImpacts } from "./model";

const repository = {
  id: "repo-1",
  name: "sample",
  owner: "local-repository",
  path: "C:\\sample",
  scanScope: "C:\\sample",
  revision: "a".repeat(40),
  branch: "main",
  dirty: false,
};

const scan: LocalRepositoryScanResult = {
  apiVersion: "1.0.0",
  repository,
  graph: {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", kind: "repository", plane: "definition", level: 0, owner: "sample", label: "sample", summary: "root", evidence: [], contributedBy: "scan" },
      { id: "module", kind: "module", plane: "definition", level: 2, owner: "sample", label: "main.py", summary: "module", parentId: "root", evidence: [{ provenance: "static", confidence: "exact", source: { repository: "sample", path: "src/main.py", revision: repository.revision, startLine: 1 } }], contributedBy: "scan" },
      { id: "agent", kind: "agent", plane: "definition", level: 3, owner: "sample", label: "Agent", summary: "agent", parentId: "module", evidence: [{ provenance: "static", confidence: "exact", source: { repository: "sample", path: "src/main.py", symbol: "Agent", revision: repository.revision, startLine: 10, endLine: 30 } }], contributedBy: "scan" },
      { id: "consumer", kind: "module", plane: "definition", level: 2, owner: "sample", label: "consumer.py", summary: "consumer", parentId: "root", evidence: [{ provenance: "static", confidence: "exact", source: { repository: "sample", path: "src/consumer.py", revision: repository.revision, startLine: 1 } }], contributedBy: "scan" },
    ],
    edges: [
      { id: "contains-root-module", kind: "contains", plane: "definition", source: "root", target: "module", evidence: [], contributedBy: "scan" },
      { id: "contains-module-agent", kind: "contains", plane: "definition", source: "module", target: "agent", evidence: [], contributedBy: "scan" },
      { id: "imports-agent", kind: "imports", plane: "definition", source: "consumer", target: "agent", evidence: [], contributedBy: "scan" },
    ],
  },
  statistics: { pythonFiles: 2, symbols: 1, nodes: 4, edges: 3, durationMs: 1, truncated: false },
  warnings: [],
};

function changes(head = repository.revision): LocalGitChangeResult {
  return {
    apiVersion: "1.0.0",
    repository,
    comparison: {
      mode: "compare",
      base: { requested: "main~1", resolved: "b".repeat(40) },
      head: { requested: "HEAD", resolved: head },
      mergeBase: "b".repeat(40),
    },
    files: [
      {
        id: "file-main",
        path: "src/main.py",
        status: "modified",
        statusCode: "M",
        staged: false,
        unstaged: false,
        untracked: false,
        binary: false,
        additions: 3,
        deletions: 1,
        hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 3 }],
      },
    ],
    statistics: { files: 1, additions: 3, deletions: 1, binaryFiles: 0, truncated: false },
    warnings: [],
    writeOperations: false,
  };
}

function githubChanges(head = repository.revision): GitHubPullRequestResult {
  const local = changes(head);
  const branch = {
    ref: "feature/pr",
    sha: head,
    label: "LasVie:feature/pr",
    repository: "LasVie/sample",
  };
  return {
    ...local,
    comparison: {
      mode: "github-pr",
      base: { requested: "main", resolved: "b".repeat(40) },
      head: { requested: branch.ref, resolved: head },
      mergeBase: null,
    },
    pullRequest: {
      provider: "github",
      owner: "LasVie",
      repository: "sample",
      number: 12,
      title: "Map remote change",
      state: "open",
      draft: false,
      merged: false,
      author: "octocat",
      htmlUrl: "https://github.com/LasVie/sample/pull/12",
      head: branch,
      base: { ...branch, ref: "main", sha: "b".repeat(40), label: "LasVie:main" },
      changedFiles: 1,
      additions: 3,
      deletions: 1,
      rateLimit: { limit: 60, remaining: 59, resetEpoch: null },
    },
    remoteOperations: { networkRead: true, mutation: false, authenticated: false },
    writeOperations: false,
  };
}

const runtimeEvent: RuntimeTraceEvent = {
  traceId: "trace-runtime",
  eventId: "runtime-agent",
  sequence: 4,
  receivedAt: "2026-08-19T00:00:00Z",
  kind: "agent.invoke",
  phase: "start",
  timestampMs: 15,
  spanId: "agent-span",
  definition: {
    repository: "sample",
    revision: repository.revision,
    path: "src/main.py",
    symbol: "Agent",
  },
};

describe("change impact projection", () => {
  it("maps line hunks to symbols, containers and relation dependants", () => {
    const projection = projectChangeImpacts(scan, changes());
    const file = projection.files[0];

    expect(projection.headAligned).toBe(true);
    expect(file.direct).toEqual([
      expect.objectContaining({ nodeId: "agent", kind: "direct", confidence: "exact" }),
    ]);
    expect(file.containers.map((impact) => impact.nodeId)).toEqual(["module", "root"]);
    expect(file.dependents).toEqual([
      expect.objectContaining({ nodeId: "consumer", kind: "dependent", confidence: "inferred" }),
    ]);
  });

  it("downgrades line evidence when the scanned checkout differs from compare head", () => {
    const projection = projectChangeImpacts(scan, changes("c".repeat(40)));
    expect(projection.headAligned).toBe(false);
    expect(projection.files[0].direct[0]).toMatchObject({ confidence: "inferred" });
  });

  it("uses the GitHub PR head SHA as the remote-to-local alignment boundary", () => {
    const exact = projectChangeImpacts(scan, githubChanges());
    const inferred = projectChangeImpacts(scan, githubChanges("c".repeat(40)));

    expect(exact.headAligned).toBe(true);
    expect(exact.files[0].direct[0].confidence).toBe("exact");
    expect(inferred.headAligned).toBe(false);
    expect(inferred.files[0].direct[0].reason).toMatch(/head/);
  });

  it("overlays runtime-observed evidence without replacing change impact kinds", () => {
    const projection = projectChangeImpacts(scan, changes(), [runtimeEvent]);

    expect(projection.files[0].direct[0].kind).toBe("direct");
    expect(projection.files[0].runtimeObserved).toEqual([
      expect.objectContaining({ nodeId: "agent", eventCount: 1, spanCount: 1 }),
    ]);
    expect(projection.runtime.exactCount).toBe(1);
  });
});
