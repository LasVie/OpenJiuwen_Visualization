import { describe, expect, it } from "vitest";
import type { GraphSnapshot, RegisteredGraphNode } from "../../kernel";
import { createDefinitionGraphIndex } from "../repository-browser";
import { projectRelationExplorer, relationKinds } from "./model";

function node(
  id: string,
  label: string,
  kind: string,
  parentId?: string,
): RegisteredGraphNode {
  return {
    id,
    label,
    kind,
    parentId,
    plane: "definition",
    level: parentId ? 2 : 0,
    owner: "agent-core",
    summary: `${label} summary`,
    evidence: [],
    contributedBy: "openjiuwen.local-repository",
  };
}

const graph: GraphSnapshot = {
  schemaVersion: "1.0.0",
  nodes: [
    node("pkg", "openjiuwen", "package"),
    node("module", "deep_agent.py", "module", "pkg"),
    node("deep", "DeepAgent", "agent", "module"),
    node("base", "BaseAgent", "class", "module"),
    node("context", "Context", "context", "module"),
  ],
  edges: [
    { id: "pkg-module", kind: "contains", plane: "definition", source: "pkg", target: "module", evidence: [], contributedBy: "openjiuwen.local-repository" },
    { id: "module-deep", kind: "contains", plane: "definition", source: "module", target: "deep", evidence: [], contributedBy: "openjiuwen.local-repository" },
    { id: "module-base", kind: "contains", plane: "definition", source: "module", target: "base", evidence: [], contributedBy: "openjiuwen.local-repository" },
    { id: "deep-base", kind: "inherits", plane: "definition", source: "deep", target: "base", evidence: [], contributedBy: "openjiuwen.local-repository" },
    { id: "deep-context", kind: "imports", plane: "definition", source: "deep", target: "context", evidence: [], contributedBy: "openjiuwen.local-repository" },
  ],
};

describe("relation explorer projection", () => {
  const index = createDefinitionGraphIndex(graph);

  it("projects an oriented first hop around the selected root", () => {
    const projection = projectRelationExplorer(index, "deep", new Set(["deep"]));

    expect(projection.nodes.map((item) => item.record.id).sort()).toEqual([
      "base",
      "context",
      "deep",
      "module",
    ]);
    expect(projection.edges.map((edge) => edge.kind).sort()).toEqual([
      "contains",
      "imports",
      "inherits",
    ]);
    expect(projection.nodes.find((item) => item.record.id === "module")?.column)
      .toBeLessThan(0);
    expect(projection.nodes.find((item) => item.record.id === "base")?.column)
      .toBeGreaterThan(0);
  });

  it("reveals another layer only after that visible node is expanded", () => {
    const firstHop = projectRelationExplorer(index, "deep", new Set(["deep"]));
    const secondHop = projectRelationExplorer(
      index,
      "deep",
      new Set(["deep", "module"]),
    );

    expect(firstHop.nodes.some((item) => item.record.id === "pkg")).toBe(false);
    expect(secondHop.nodes.some((item) => item.record.id === "pkg")).toBe(true);
    expect(secondHop.expandedNodeIds.has("module")).toBe(true);
  });

  it("filters by direction and relation kind without inventing peers", () => {
    const incoming = projectRelationExplorer(index, "deep", new Set(["deep"]), {
      direction: "incoming",
      edgeKinds: new Set(["contains"]),
    });

    expect(incoming.nodes.map((item) => item.record.id).sort()).toEqual([
      "deep",
      "module",
    ]);
    expect(incoming.edges.map((edge) => edge.id)).toEqual(["module-deep"]);
    expect(relationKinds(index)).toEqual(["contains", "inherits", "imports"]);
  });

  it("reports bounded expansion instead of presenting a partial graph as complete", () => {
    const bounded = projectRelationExplorer(index, "deep", new Set(["deep"]), {
      perNodeLimit: 1,
      maxNodes: 2,
    });

    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(bounded.hiddenRelations).toBeGreaterThan(0);
  });
});
