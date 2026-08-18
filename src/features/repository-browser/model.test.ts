import { describe, expect, it } from "vitest";
import type { GraphSnapshot, RegisteredGraphNode } from "../../kernel";
import {
  createDefinitionGraphIndex,
  definitionBreadcrumb,
  projectDefinitionViewport,
  searchDefinitionNodes,
} from "./model";

function node(
  id: string,
  kind: string,
  label: string,
  parentId?: string,
): RegisteredGraphNode {
  return {
    id,
    kind,
    plane: "definition",
    level: parentId ? 1 : 0,
    owner: "agent-core",
    label,
    summary: `${label} summary`,
    parentId,
    expandable: true,
    evidence: [
      {
        provenance: "static",
        confidence: "exact",
        source: {
          repository: "agent-core",
          revision: "abc",
          path: parentId === "module" ? "deep_agent.py" : `${label.toLowerCase()}.py`,
        },
      },
    ],
    contributedBy: "openjiuwen.local-repository",
  };
}

const graph: GraphSnapshot = {
  schemaVersion: "1.0.0",
  nodes: [
    node("root", "repository", "agent-core"),
    node("pkg", "package", "openjiuwen", "root"),
    node("module", "module", "deep_agent.py", "pkg"),
    node("deep", "agent", "DeepAgent", "module"),
    node("base", "class", "BaseAgent", "module"),
  ],
  edges: [
    {
      id: "contains-root-pkg",
      kind: "contains",
      plane: "definition",
      source: "root",
      target: "pkg",
      evidence: [],
      contributedBy: "openjiuwen.local-repository",
    },
    {
      id: "contains-pkg-module",
      kind: "contains",
      plane: "definition",
      source: "pkg",
      target: "module",
      evidence: [],
      contributedBy: "openjiuwen.local-repository",
    },
    {
      id: "inherits-deep-base",
      kind: "inherits",
      plane: "definition",
      source: "deep",
      target: "base",
      evidence: [],
      contributedBy: "openjiuwen.local-repository",
    },
  ],
};

describe("definition graph projection", () => {
  it("indexes hierarchy and builds breadcrumbs", () => {
    const index = createDefinitionGraphIndex(graph);

    expect(definitionBreadcrumb(index, "deep").map((item) => item.label)).toEqual([
      "agent-core",
      "openjiuwen",
      "deep_agent.py",
      "DeepAgent",
    ]);
    expect(projectDefinitionViewport(index, "module").members.map((item) => item.id))
      .toEqual(["deep", "base"]);
  });

  it("paginates child nodes and projects leaf relationships", () => {
    const index = createDefinitionGraphIndex(graph);
    const page = projectDefinitionViewport(index, "module", { pageSize: 1, page: 1 });
    const leaf = projectDefinitionViewport(index, "deep");

    expect(page.pageCount).toBe(2);
    expect(page.members).toHaveLength(1);
    expect(leaf.mode).toBe("relations");
    expect(leaf.members.map((item) => item.id)).toEqual(["base"]);
    expect(leaf.edges.map((edge) => edge.kind)).toEqual(["inherits"]);
  });

  it("ranks exact labels ahead of source-path matches", () => {
    const index = createDefinitionGraphIndex(graph);

    expect(searchDefinitionNodes(index, "deepagent")[0].id).toBe("deep");
    expect(searchDefinitionNodes(index, "deep_agent.py").map((item) => item.id))
      .toContain("deep");
  });
});
