import { describe, expect, it } from "vitest";
import type { GraphSnapshot, RegisteredGraphNode } from "../../kernel";
import type { LocalRepositoryScanResult } from "../../adapters/local-repository";
import { developmentIntentTerms, projectDevelopmentAnalysis } from "./model";

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

  it("rejects an empty development intent", () => {
    expect(() => projectDevelopmentAnalysis(scan, "   ")).toThrow(/required/i);
  });
});
