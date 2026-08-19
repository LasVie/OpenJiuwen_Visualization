import { describe, expect, it } from "vitest";
import type {
  GraphSnapshot,
  GraphSourceReference,
  RuntimeTraceEvent,
} from "../../kernel";
import {
  canonicalSourceIdentity,
  sourceIdentityKey,
} from "../../kernel";
import {
  matchRuntimeSource,
  projectRuntimeDefinitions,
  repositoryMatchesSource,
} from "./model";

const revision = "a".repeat(40);
const source: GraphSourceReference = {
  repository: "agent-core",
  revision,
  path: "openjiuwen/harness/deep_agent.py",
  symbol: "DeepAgent",
  startLine: 10,
  endLine: 80,
};
const graph: GraphSnapshot = {
  schemaVersion: "1.0.0",
  nodes: [
    {
      id: "deep-agent",
      kind: "agent",
      plane: "definition",
      level: 3,
      owner: "agent-core",
      label: "DeepAgent",
      summary: "Agent",
      evidence: [{ provenance: "static", confidence: "exact", source }],
      contributedBy: "scan",
    },
  ],
  edges: [],
};

function event(
  sequence: number,
  definition: GraphSourceReference = source,
): RuntimeTraceEvent {
  return {
    traceId: "trace-1",
    eventId: `event-${sequence}`,
    sequence,
    receivedAt: "2026-08-19T00:00:00Z",
    kind: "agent.invoke",
    phase: sequence === 1 ? "start" : "end",
    timestampMs: sequence,
    spanId: "invoke-1",
    definition,
    token: { used: sequence * 10, delta: 5 },
  };
}

describe("cross-plane source identity", () => {
  it("normalizes repository and path while retaining revision and symbol", () => {
    const canonical = canonicalSourceIdentity({
      ...source,
      repository: " Agent-Core ",
      path: ".\\openjiuwen\\harness\\deep_agent.py",
      revision: revision.toUpperCase(),
    });

    expect(canonical).toEqual({
      repository: "agent-core",
      revision,
      path: "openjiuwen/harness/deep_agent.py",
      symbol: "DeepAgent",
    });
    expect(sourceIdentityKey(source)).toContain(`agent-core@${revision}`);
  });

  it("matches only structured location fields and degrades revision uncertainty", () => {
    expect(matchRuntimeSource(graph, event(1))?.status).toBe("exact");
    expect(matchRuntimeSource(graph, event(1, { ...source, revision: undefined }))?.status)
      .toBe("revision-unverified");
    expect(matchRuntimeSource(graph, event(1, { ...source, revision: "b".repeat(40) }))?.status)
      .toBe("revision-mismatch");
    expect(matchRuntimeSource(graph, event(1), { repositoryDirty: true })?.status)
      .toBe("worktree-dirty");
    expect(matchRuntimeSource(graph, event(1, { ...source, symbol: "OtherAgent" }))?.status)
      .toBe("unmatched");
  });

  it("aggregates calls, status, tokens, and exact/degraded counts by definition node", () => {
    const projection = projectRuntimeDefinitions(graph, [
      event(1),
      event(2, { ...source, revision: undefined }),
    ]);
    const summary = projection.summariesByNode.get("deep-agent");

    expect(summary).toMatchObject({
      eventCount: 2,
      spanCount: 1,
      tokenCount: 10,
      strongestStatus: "exact",
    });
    expect(summary?.lastEvent.phase).toBe("end");
    expect(projection.exactCount).toBe(1);
    expect(projection.degradedCount).toBe(1);
  });

  it("selects repositories only by stable id, name, or owner", () => {
    expect(repositoryMatchesSource(
      { id: "repo:agent-core", name: "agent-core", owner: "agent-core" },
      source,
    )).toBe(true);
    expect(repositoryMatchesSource(
      { id: "repo:other", name: "Agent Core fork", owner: "local" },
      source,
    )).toBe(false);
  });
});
