import { describe, expect, it } from "vitest";
import type { GraphSnapshot, RegisteredGraphNode } from "../../kernel";
import type { LocalRepositoryScanResult } from "../../adapters/local-repository";
import { developmentIntentTerms, projectDevelopmentAnalysis } from "./model";
import type { DevelopmentNavigationRequest } from "./navigation";

function node(
  id: string,
  kind: string,
  label: string,
  path: string,
  symbol: string,
): RegisteredGraphNode {
  return {
    id,
    kind,
    plane: "definition",
    level: 3,
    owner: "agent-core",
    label,
    summary: `${label} runtime boundary`,
    evidence: [{
      provenance: "static",
      confidence: "exact",
      source: { repository: "agent-core", revision: "a".repeat(40), path, symbol, startLine: 10, endLine: 40 },
    }],
    contributedBy: "openjiuwen.local-repository",
  };
}

const nodes = [
  node("deep", "agent", "DeepAgent", "openjiuwen/core/deep_agent.py", "DeepAgent"),
  node("react", "agent", "ReActAgent", "openjiuwen/core/react_agent.py", "ReActAgent"),
  node("react-config", "agent", "ReActAgentConfig", "openjiuwen/core/react_agent.py", "ReActAgentConfig"),
  node("rail", "rail", "ContextAssembleRail", "openjiuwen/core/rails/context.py", "ContextAssembleRail"),
  node("base", "class", "BaseAgent", "openjiuwen/core/base.py", "BaseAgent"),
  node("test", "function", "test_deep_agent_rail", "tests/core/test_deep_agent.py", "test_deep_agent_rail"),
];

const graph: GraphSnapshot = {
  schemaVersion: "1.0.0",
  nodes,
  edges: [{
    id: "deep-rail",
    kind: "uses",
    plane: "definition",
    source: "deep",
    target: "rail",
    evidence: [{ provenance: "static", confidence: "exact" }],
    contributedBy: "openjiuwen.local-repository",
  }, {
    id: "deep-base",
    kind: "inherits",
    plane: "definition",
    source: "deep",
    target: "base",
    evidence: [{ provenance: "static", confidence: "exact" }],
    contributedBy: "openjiuwen.local-repository",
  }],
};

const scan: LocalRepositoryScanResult = {
  apiVersion: "1.0.0",
  repository: {
    id: "repo:agent-core",
    name: "agent-core",
    owner: "agent-core",
    path: "C:/workspace/agent-core",
    scanScope: ".",
    revision: "a".repeat(40),
    branch: "develop",
    dirty: false,
  },
  graph,
  statistics: {
    pythonFiles: 4,
    symbols: 6,
    nodes: 6,
    edges: 2,
    durationMs: 8,
    truncated: false,
  },
  warnings: [],
};

describe("read-only development analysis", () => {
  it("extracts stable identifiers from mixed Chinese development intent", () => {
    expect(developmentIntentTerms("给 DeepAgent 的 rail_review 增加 Hook 测试"))
      .toEqual(expect.arrayContaining(["deepagent", "deep", "agent", "rail_review", "rail", "review", "hook"]));
  });

  it("projects evidence, impacts, test guidance and non-applicable patch outlines", () => {
    const result = projectDevelopmentAnalysis(
      scan,
      "调整 DeepAgent 的 Rail 审查边界并补充测试",
    );

    expect(result.evidence[0]).toMatchObject({
      node: { id: "deep" },
      confidence: "exact",
    });
    expect(result.impacts.map((item) => item.node.id)).toContain("base");
    expect(result.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "focused",
        source: expect.objectContaining({ path: "tests/core/test_deep_agent.py" }),
      }),
      expect.objectContaining({ kind: "contract" }),
      expect.objectContaining({ kind: "regression" }),
    ]));
    expect(result.patchOutlines[0]).toMatchObject({
      path: "openjiuwen/core/deep_agent.py",
      applicable: false,
      basis: "structural-outline",
    });
    expect(result.patchOutlines[0].preview).toContain("NOT AN APPLICABLE PATCH");
    expect(result).toMatchObject({ readOnly: true, repositoryWrite: false });
    expect(result.stages.map((stage) => stage.kind)).toEqual([
      "intent",
      "scope",
      "evidence",
      "diagnosis",
      "impact",
      "change-plan",
      "test-plan",
      "patch-outline",
      "boundary",
    ]);
  });

  it("keeps distinct explicit targets ahead of generic agent variants", () => {
    const result = projectDevelopmentAnalysis(
      scan,
      "在 DeepAgent 中增加 Rail 审查并保持 ReAct API 兼容",
    );

    expect(result.evidence.slice(0, 3).map((item) => item.node.id)).toEqual([
      "deep",
      "rail",
      "react",
    ]);
    expect(result.evidence.find((item) => item.node.id === "deep")?.confidence).toBe("exact");
  });

  it("uses explicit fallback evidence without claiming exact matches", () => {
    const result = projectDevelopmentAnalysis(scan, "提升整体可维护性");

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((item) => item.confidence === "inferred")).toBe(true);
    expect(result.warnings).toContain("意图中没有稳定代码标识符命中，证据按核心定义回退。");
  });

  it("pins a verified cross-plane source as the first Development evidence", () => {
    const navigation: DevelopmentNavigationRequest = {
      id: 1,
      source: nodes[0].evidence[0].source!,
      intent: "从 Runtime 检视 DeepAgent 的运行合同",
      origin: {
        plane: "runtime",
        traceId: "trace-1",
        sequence: 8,
        eventKind: "agent.react_iteration",
        phase: "end",
        tokenCount: 42,
      },
    };

    const result = projectDevelopmentAnalysis(scan, navigation.intent, navigation);

    expect(result.entry).toMatchObject({
      status: "exact",
      matchedNodeId: "deep",
      navigation: { id: 1, origin: { plane: "runtime" } },
    });
    expect(result.evidence[0]).toMatchObject({
      node: { id: "deep" },
      confidence: "exact",
    });
    expect(result.stages.find((stage) => stage.kind === "scope")?.summary)
      .toContain("FROM RUNTIME");
  });

  it("verifies a symbol-less Definition node by stable node ID and source location", () => {
    const repositoryNode: RegisteredGraphNode = {
      id: "repository:agent-core:.",
      kind: "repository",
      plane: "definition",
      level: 0,
      owner: "agent-core",
      label: "agent-core",
      summary: "Repository root",
      evidence: [{
        provenance: "static",
        confidence: "exact",
        source: {
          repository: "agent-core",
          revision: "a".repeat(40),
          path: ".",
        },
      }],
      contributedBy: "openjiuwen.local-repository",
    };
    const repositoryScan: LocalRepositoryScanResult = {
      ...scan,
      graph: {
        ...scan.graph,
        nodes: [repositoryNode, ...scan.graph.nodes],
      },
    };
    const navigation: DevelopmentNavigationRequest = {
      id: 4,
      source: repositoryNode.evidence[0].source!,
      intent: "检视 agent-core repository 边界",
      origin: {
        plane: "definition",
        nodeId: repositoryNode.id,
        nodeLabel: repositoryNode.label,
        nodeKind: repositoryNode.kind,
      },
    };

    const result = projectDevelopmentAnalysis(
      repositoryScan,
      navigation.intent,
      navigation,
    );

    expect(result.entry).toMatchObject({
      status: "exact",
      matchedNodeId: repositoryNode.id,
    });
    expect(result.evidence[0].node.id).toBe(repositoryNode.id);
  });

  it("keeps a revision mismatch visible and does not claim exact entry evidence", () => {
    const navigation: DevelopmentNavigationRequest = {
      id: 2,
      source: {
        ...nodes[0].evidence[0].source!,
        revision: "b".repeat(40),
      },
      intent: "从 Definition 检视 DeepAgent",
      origin: {
        plane: "definition",
        nodeId: "deep",
        nodeLabel: "DeepAgent",
        nodeKind: "agent",
      },
    };

    const result = projectDevelopmentAnalysis(scan, navigation.intent, navigation);

    expect(result.entry?.status).toBe("revision-mismatch");
    expect(result.evidence[0]).toMatchObject({
      node: { id: "deep" },
      confidence: "inferred",
    });
    expect(result.warnings.join(" ")).toContain("revision-mismatch");
  });

  it("does not fabricate a node for an unmatched cross-plane source", () => {
    const navigation: DevelopmentNavigationRequest = {
      id: 3,
      source: {
        repository: "agent-core",
        revision: "a".repeat(40),
        path: "openjiuwen/core/missing.py",
        symbol: "MissingAgent",
      },
      intent: "检视 MissingAgent 的边界",
      origin: {
        plane: "definition",
        nodeId: "missing",
        nodeLabel: "MissingAgent",
        nodeKind: "agent",
      },
    };

    const result = projectDevelopmentAnalysis(scan, navigation.intent, navigation);

    expect(result.entry).toMatchObject({ status: "unmatched" });
    expect(result.entry?.matchedNodeId).toBeUndefined();
    expect(result.evidence.some((item) => item.node.id === "missing")).toBe(false);
  });

  it("rejects an empty development intent", () => {
    expect(() => projectDevelopmentAnalysis(scan, "   ")).toThrow(/required/i);
  });
});
