import type { GraphSourceReference, RegisteredGraphNode } from "../../kernel";
import type { LocalRepositoryIdentity } from "../../adapters/local-repository";
import type {
  DevelopmentAnalysisProjection,
  DevelopmentEvidenceTarget,
} from "./model";

const STAGE_KINDS = [
  "intent",
  "scope",
  "evidence",
  "diagnosis",
  "impact",
  "change-plan",
  "test-plan",
  "patch-outline",
  "boundary",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function source(value: unknown): value is GraphSourceReference {
  return (
    record(value) &&
    typeof value.repository === "string" &&
    typeof value.path === "string" &&
    (value.revision === undefined || typeof value.revision === "string") &&
    (value.symbol === undefined || typeof value.symbol === "string") &&
    (value.startLine === undefined || Number.isInteger(value.startLine)) &&
    (value.endLine === undefined || Number.isInteger(value.endLine))
  );
}

function graphEvidence(value: unknown) {
  return (
    record(value) &&
    ["static", "config", "runtime", "git", "fixture"].includes(String(value.provenance)) &&
    ["exact", "inferred", "runtime-confirmed"].includes(String(value.confidence)) &&
    (value.source === undefined || source(value.source))
  );
}

function graphNode(value: unknown): value is RegisteredGraphNode {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    value.plane === "definition" &&
    Number.isInteger(value.level) &&
    typeof value.owner === "string" &&
    typeof value.label === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(graphEvidence) &&
    typeof value.contributedBy === "string"
  );
}

function repository(value: unknown): value is LocalRepositoryIdentity {
  return (
    record(value) &&
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

function evidenceTarget(value: unknown): value is DevelopmentEvidenceTarget {
  return (
    record(value) &&
    typeof value.id === "string" &&
    graphNode(value.node) &&
    source(value.source) &&
    typeof value.score === "number" &&
    stringArray(value.matchedTerms) &&
    ["exact", "strong", "inferred"].includes(String(value.confidence)) &&
    typeof value.reason === "string"
  );
}

function impactTarget(value: unknown) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    graphNode(value.node) &&
    (value.source === undefined || source(value.source)) &&
    typeof value.relationship === "string" &&
    ["incoming", "outgoing", "structural"].includes(String(value.direction)) &&
    typeof value.evidenceNodeId === "string" &&
    ["exact", "inferred"].includes(String(value.confidence)) &&
    typeof value.reason === "string"
  );
}

function changeSuggestion(value: unknown) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.detail === "string" &&
    evidenceTarget(value.target) &&
    ["low", "medium", "high"].includes(String(value.risk)) &&
    stringArray(value.guardrails)
  );
}

function testSuggestion(value: unknown) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.detail === "string" &&
    ["focused", "contract", "regression"].includes(String(value.kind)) &&
    (value.source === undefined || source(value.source)) &&
    typeof value.evidenceLabel === "string"
  );
}

function patchOutline(value: unknown) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    (value.symbol === undefined || typeof value.symbol === "string") &&
    typeof value.title === "string" &&
    typeof value.preview === "string" &&
    value.preview.startsWith("*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***") &&
    value.applicable === false &&
    value.basis === "structural-outline"
  );
}

function stage(value: unknown, index: number) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.kind === STAGE_KINDS[index] &&
    value.ordinal === index + 1 &&
    typeof value.label === "string" &&
    typeof value.summary === "string" &&
    (value.count === undefined || Number.isInteger(value.count))
  );
}

function entryEvidence(value: unknown) {
  if (value === undefined) return true;
  if (!record(value) || !record(value.navigation)) return false;
  const navigation = value.navigation;
  if (
    !Number.isInteger(navigation.id) ||
    !source(navigation.source) ||
    typeof navigation.intent !== "string" ||
    !record(navigation.origin) ||
    !["runtime", "definition", "change"].includes(String(navigation.origin.plane))
  ) return false;
  return (
    [
      "exact",
      "worktree-dirty",
      "revision-unverified",
      "revision-mismatch",
      "ambiguous",
      "unmatched",
    ].includes(String(value.status)) &&
    (value.matchedNodeId === undefined || typeof value.matchedNodeId === "string") &&
    typeof value.reason === "string"
  );
}

export function restoreDevelopmentAnalysis(value: unknown): DevelopmentAnalysisProjection {
  if (
    !record(value) ||
    !repository(value.repository) ||
    typeof value.intent !== "string" ||
    !stringArray(value.terms) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(evidenceTarget) ||
    !Array.isArray(value.impacts) ||
    !value.impacts.every(impactTarget) ||
    !Array.isArray(value.changes) ||
    !value.changes.every(changeSuggestion) ||
    !Array.isArray(value.tests) ||
    !value.tests.every(testSuggestion) ||
    !Array.isArray(value.patchOutlines) ||
    !value.patchOutlines.every(patchOutline) ||
    !Array.isArray(value.stages) ||
    value.stages.length !== STAGE_KINDS.length ||
    !value.stages.every(stage) ||
    typeof value.diagnosis !== "string" ||
    !stringArray(value.warnings) ||
    !entryEvidence(value.entry) ||
    value.readOnly !== true ||
    value.repositoryWrite !== false
  ) {
    throw new TypeError("Stored Development Session does not match the read-only analysis contract.");
  }
  return value as unknown as DevelopmentAnalysisProjection;
}

export function serializeDevelopmentAnalysis(
  projection: DevelopmentAnalysisProjection,
): Record<string, unknown> {
  const serialized: unknown = JSON.parse(JSON.stringify(projection));
  restoreDevelopmentAnalysis(serialized);
  return serialized as Record<string, unknown>;
}
