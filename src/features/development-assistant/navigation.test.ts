import { describe, expect, it } from "vitest";
import type {
  GitChangedFile,
  GitChangeComparison,
  NodeChangeImpact,
  RegisteredGraphNode,
  RuntimeTraceEvent,
} from "../../kernel";
import {
  createChangeDevelopmentNavigation,
  createDefinitionDevelopmentNavigation,
  createRuntimeDevelopmentNavigation,
} from "./navigation";

const source = {
  repository: "agent-core",
  revision: "a".repeat(40),
  path: "openjiuwen/core/deep_agent.py",
  symbol: "DeepAgent",
  startLine: 10,
  endLine: 40,
};

const node: RegisteredGraphNode = {
  id: "deep",
  kind: "agent",
  plane: "definition",
  level: 3,
  owner: "agent-core",
  label: "DeepAgent",
  summary: "Deep agent boundary",
  evidence: [{ provenance: "static", confidence: "exact", source }],
  contributedBy: "openjiuwen.local-repository",
};

const runtimeEvent: RuntimeTraceEvent = {
  traceId: "trace-1",
  eventId: "event-7",
  sequence: 7,
  receivedAt: "2026-08-20T00:00:00Z",
  kind: "model.stream",
  phase: "end",
  timestampMs: 120,
  spanId: "span-1",
  subject: { id: "agent-1", kind: "agent", label: "DeepAgent" },
  definition: source,
  context: {
    operation: "append",
    messages: [{
      id: "secret-message",
      role: "user",
      label: "User",
      raw: "SECRET USER PROMPT",
      tokens: 4,
      source: "user",
    }],
  },
  model: {
    invocationId: "invocation-1",
    providerId: "openrouter",
    modelId: "test-model",
    source: "live",
    responseText: "SECRET MODEL RESPONSE",
    usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
  },
};

describe("development cross-plane navigation", () => {
  it("keeps structured Runtime evidence without copying Context or model text", () => {
    const navigation = createRuntimeDevelopmentNavigation(runtimeEvent);

    expect(navigation).toMatchObject({
      source,
      origin: {
        plane: "runtime",
        traceId: "trace-1",
        sequence: 7,
        eventKind: "model.stream",
        phase: "end",
        tokenCount: 13,
      },
    });
    expect(JSON.stringify(navigation)).not.toContain("SECRET USER PROMPT");
    expect(JSON.stringify(navigation)).not.toContain("SECRET MODEL RESPONSE");
  });

  it("returns no Runtime entry when the event has no source identity", () => {
    expect(createRuntimeDevelopmentNavigation({
      ...runtimeEvent,
      definition: undefined,
    })).toBeNull();
  });

  it("preserves Definition Runtime metrics without copying observations", () => {
    const navigation = createDefinitionDevelopmentNavigation({
      node,
      source,
      runtimeSummary: {
        nodeId: node.id,
        observations: [],
        eventCount: 4,
        spanCount: 2,
        tokenCount: 91,
        lastEvent: runtimeEvent,
        strongestStatus: "exact",
      },
    });

    expect(navigation.origin).toMatchObject({
      plane: "definition",
      nodeId: "deep",
      runtime: {
        traceId: "trace-1",
        lastSequence: 7,
        spanCount: 2,
        eventCount: 4,
        tokenCount: 91,
        strongestStatus: "exact",
      },
    });
    expect(JSON.stringify(navigation)).not.toContain("observations");
  });

  it("preserves Change comparison, hunk and impact evidence", () => {
    const file: GitChangedFile = {
      id: "file:deep",
      path: source.path,
      status: "modified",
      statusCode: " M",
      staged: false,
      unstaged: true,
      untracked: false,
      binary: false,
      additions: 3,
      deletions: 1,
      hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 3 }],
    };
    const impact: NodeChangeImpact = {
      id: "impact:deep",
      nodeId: node.id,
      fileId: file.id,
      kind: "direct",
      confidence: "exact",
      hunkIndexes: [0],
      reason: "变更行与 DeepAgent 定义相交。",
    };
    const comparison: GitChangeComparison = {
      mode: "compare",
      base: { requested: "develop", resolved: "a".repeat(40) },
      head: { requested: "feature", resolved: "b".repeat(40) },
      mergeBase: "a".repeat(40),
    };
    const navigation = createChangeDevelopmentNavigation({
      node,
      source,
      impact,
      file,
      comparison,
    });

    expect(navigation.origin).toMatchObject({
      plane: "change",
      comparison: { mode: "compare", base: "develop", head: "feature" },
      file: { path: source.path, status: "modified" },
      impact: { kind: "direct", confidence: "exact", hunkIndexes: [0] },
    });
  });
});
