import { describe, expect, it } from "vitest";
import type { DevelopmentAnalysisProjection } from "./model";
import {
  restoreDevelopmentAnalysis,
  serializeDevelopmentAnalysis,
} from "./session";

const kinds = [
  "intent", "scope", "evidence", "diagnosis", "impact",
  "change-plan", "test-plan", "patch-outline", "boundary",
] as const;

function projection(): DevelopmentAnalysisProjection {
  const source = {
    repository: "agent-core",
    path: "openjiuwen/core/deep_agent.py",
    revision: "a".repeat(40),
    symbol: "DeepAgent",
  };
  const node = {
    id: "deep",
    kind: "agent",
    plane: "definition" as const,
    level: 3 as const,
    owner: "agent-core",
    label: "DeepAgent",
    summary: "DeepAgent boundary",
    evidence: [{ provenance: "static" as const, confidence: "exact" as const, source }],
    contributedBy: "openjiuwen.local-repository",
  };
  const target = {
    id: "evidence:deep",
    node,
    source,
    score: 100,
    matchedTerms: ["deepagent"],
    confidence: "exact" as const,
    reason: "Exact symbol.",
  };
  return {
    repository: {
      id: "repo:core",
      name: "agent-core",
      owner: "agent-core",
      path: "C:/workspace/agent-core",
      scanScope: ".",
      revision: "a".repeat(40),
      branch: "develop",
      dirty: false,
    },
    intent: "Inspect DeepAgent",
    terms: ["deepagent"],
    evidence: [target],
    impacts: [],
    changes: [{
      id: "change:deep",
      title: "Bound the change",
      detail: "Keep the API.",
      target,
      risk: "high",
      guardrails: ["read-only"],
    }],
    tests: [{
      id: "test:contract",
      title: "Contract",
      detail: "Preserve lifecycle.",
      kind: "contract",
      source,
      evidenceLabel: "DeepAgent",
    }],
    patchOutlines: [{
      id: "patch:deep",
      path: source.path,
      symbol: source.symbol,
      title: "Outline",
      preview: "*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***",
      applicable: false,
      basis: "structural-outline",
    }],
    stages: kinds.map((kind, index) => ({
      id: `development-stage:${kind}`,
      kind,
      ordinal: index + 1,
      label: kind,
      summary: "bounded",
    })),
    diagnosis: "One exact definition.",
    warnings: [],
    readOnly: true,
    repositoryWrite: false,
  };
}

describe("Development Session serialization", () => {
  it("round-trips a complete read-only projection", () => {
    const original = projection();
    const restored = restoreDevelopmentAnalysis(serializeDevelopmentAnalysis(original));

    expect(restored).toEqual(original);
    expect(restored.evidence[0].node.label).toBe("DeepAgent");
  });

  it("rejects writable or structurally incomplete persisted payloads", () => {
    const writable = { ...serializeDevelopmentAnalysis(projection()), repositoryWrite: true };
    expect(() => restoreDevelopmentAnalysis(writable)).toThrow(/read-only analysis contract/);

    const missingNode = serializeDevelopmentAnalysis(projection());
    missingNode.evidence = [{ id: "broken" }];
    expect(() => restoreDevelopmentAnalysis(missingNode)).toThrow(/read-only analysis contract/);
  });
});
