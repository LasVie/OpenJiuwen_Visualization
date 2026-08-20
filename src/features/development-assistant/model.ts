import type {
  GraphSourceReference,
  RegisteredGraphEdge,
  RegisteredGraphNode,
} from "../../kernel";
import {
  canonicalSourceIdentity,
  sameSourceLocation,
} from "../../kernel";
import type {
  LocalRepositoryIdentity,
  LocalRepositoryScanResult,
} from "../../adapters/local-repository";
import {
  matchSourceToDefinition,
  type RuntimeSourceMatchStatus,
} from "../source-convergence";
import type { DevelopmentNavigationRequest } from "./navigation";

export type DevelopmentStageKind =
  | "intent"
  | "scope"
  | "evidence"
  | "diagnosis"
  | "impact"
  | "change-plan"
  | "test-plan"
  | "patch-outline"
  | "boundary";

export type DevelopmentEvidenceConfidence = "exact" | "strong" | "inferred";

export interface DevelopmentEvidenceTarget {
  id: string;
  node: RegisteredGraphNode;
  source: GraphSourceReference;
  score: number;
  matchedTerms: readonly string[];
  confidence: DevelopmentEvidenceConfidence;
  reason: string;
}

export interface DevelopmentImpactTarget {
  id: string;
  node: RegisteredGraphNode;
  source?: GraphSourceReference;
  relationship: string;
  direction: "incoming" | "outgoing" | "structural";
  evidenceNodeId: string;
  confidence: "exact" | "inferred";
  reason: string;
}

export interface DevelopmentChangeSuggestion {
  id: string;
  title: string;
  detail: string;
  target: DevelopmentEvidenceTarget;
  risk: "low" | "medium" | "high";
  guardrails: readonly string[];
}

export interface DevelopmentTestSuggestion {
  id: string;
  title: string;
  detail: string;
  kind: "focused" | "contract" | "regression";
  source?: GraphSourceReference;
  evidenceLabel: string;
}

export interface DevelopmentPatchOutline {
  id: string;
  path: string;
  symbol?: string;
  title: string;
  preview: string;
  applicable: false;
  basis: "structural-outline";
}

export interface DevelopmentStage {
  id: string;
  kind: DevelopmentStageKind;
  ordinal: number;
  label: string;
  summary: string;
  count?: number;
}

export interface DevelopmentEntryEvidence {
  navigation: DevelopmentNavigationRequest;
  status: RuntimeSourceMatchStatus;
  matchedNodeId?: string;
  reason: string;
}

export interface DevelopmentAnalysisProjection {
  repository: LocalRepositoryIdentity;
  intent: string;
  terms: readonly string[];
  evidence: readonly DevelopmentEvidenceTarget[];
  impacts: readonly DevelopmentImpactTarget[];
  changes: readonly DevelopmentChangeSuggestion[];
  tests: readonly DevelopmentTestSuggestion[];
  patchOutlines: readonly DevelopmentPatchOutline[];
  stages: readonly DevelopmentStage[];
  diagnosis: string;
  warnings: readonly string[];
  entry?: DevelopmentEntryEvidence;
  readOnly: true;
  repositoryWrite: false;
}

export type DevelopmentSelection =
  | { kind: "stage"; id: string }
  | { kind: "evidence"; id: string }
  | { kind: "impact"; id: string }
  | { kind: "change"; id: string }
  | { kind: "test"; id: string }
  | { kind: "patch"; id: string };

const STOP_TERMS = new Set([
  "this", "that", "with", "from", "into", "then", "the", "and",
  "需要", "一个", "这个", "进行", "功能", "修改", "增加", "添加", "支持",
  "以及", "然后", "相关", "代码", "项目", "方案", "流程",
]);

const INTERESTING_KIND_SCORE: Readonly<Record<string, number>> = {
  agent: 22,
  team: 21,
  workflow: 20,
  rail: 19,
  tool: 18,
  class: 13,
  function: 11,
  module: 7,
};

const SECONDARY_TARGET_TERMS = new Set([
  "agent", "api", "base", "class", "context", "deep", "function", "model",
  "module", "re", "act", "test", "tests", "tool", "tools",
]);

const TERM_SCORE_WEIGHT: Readonly<Record<string, number>> = {
  agent: 0.22,
  api: 0.18,
  deep: 0.5,
  re: 0.12,
  act: 0.12,
  rail: 0.72,
  react: 0.82,
};

function normalized(value: string) {
  return value.toLocaleLowerCase().replaceAll("\\", "/");
}

function identifierParts(value: string) {
  const separated = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ");
  return separated.split(/\s+/).map(normalized).filter((part) => part.length >= 4);
}

export function developmentIntentTerms(intent: string) {
  const candidates = [
    ...(intent.match(/[A-Za-z_][A-Za-z0-9_.:-]*/g) ?? []),
    ...(intent.match(/[\p{Script=Han}]{2,}/gu) ?? []),
  ];
  const terms = new Set<string>();
  candidates.forEach((candidate) => {
    const canonical = normalized(candidate);
    if (canonical.length >= 2 && !STOP_TERMS.has(canonical)) terms.add(canonical);
    identifierParts(candidate).forEach((part) => {
      if (!STOP_TERMS.has(part)) terms.add(part);
    });
  });
  return [...terms].slice(0, 24);
}

function nodeSource(node: RegisteredGraphNode) {
  return node.evidence.find((item) => item.source)?.source;
}

function fieldScore(field: string, term: string, weights: [number, number, number]) {
  const value = normalized(field);
  if (value === term) return weights[0];
  if (value.startsWith(term)) return weights[1];
  if (value.includes(term)) return weights[2];
  return 0;
}

function scoreNode(node: RegisteredGraphNode, terms: readonly string[]) {
  const source = nodeSource(node);
  const sourceText = source
    ? `${source.path} ${source.symbol ?? ""}`
    : "";
  const matchedTerms = terms.filter((term) =>
    [node.label, node.kind, node.summary, sourceText]
      .some((field) => normalized(field).includes(term)));
  const score = matchedTerms.reduce((total, term) => {
    const weight = TERM_SCORE_WEIGHT[term] ?? (term.length >= 8 ? 1.35 : 1);
    return total + weight * (
      fieldScore(node.label, term, [130, 88, 62])
      + fieldScore(source?.symbol ?? "", term, [120, 78, 52])
      + fieldScore(source?.path ?? "", term, [82, 46, 34])
      + fieldScore(node.kind, term, [44, 28, 18])
      + fieldScore(node.summary, term, [28, 18, 10])
    );
  }, 0);
  return {
    score: score + (matchedTerms.length ? INTERESTING_KIND_SCORE[node.kind] ?? 0 : 0),
    matchedTerms,
  };
}

function evidenceConfidence(
  node: RegisteredGraphNode,
  matchedTerms: readonly string[],
  score: number,
): DevelopmentEvidenceConfidence {
  const source = nodeSource(node);
  if (matchedTerms.some((term) =>
    normalized(node.label) === term || normalized(source?.symbol ?? "") === term)) {
    return "exact";
  }
  if (score >= 62) return "strong";
  return "inferred";
}

function directTargetScore(node: RegisteredGraphNode, term: string) {
  const source = nodeSource(node);
  const fields = [node.label, source?.symbol ?? ""];
  const direct = fields.reduce((total, field) => {
    const value = normalized(field);
    if (value === term) return total + 10_000;
    if (value.startsWith(term)) return total + Math.max(3_000, 5_000 - (value.length - term.length) * 20);
    if (value.includes(term)) return total + Math.max(1_000, 2_000 - (value.length - term.length) * 10);
    return total;
  }, 0);
  const productionBonus = source && !/(^|\/)(tests?|test_[^/]+)(\/|$)/i.test(source.path)
    ? 600
    : 0;
  return direct + productionBonus + (INTERESTING_KIND_SCORE[node.kind] ?? 0);
}

function evidenceTargets(scan: LocalRepositoryScanResult, terms: readonly string[]) {
  const candidates = scan.graph.nodes
    .filter((node) => Boolean(nodeSource(node)))
    .map((node) => ({ node, ...scoreNode(node, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      (INTERESTING_KIND_SCORE[right.node.kind] ?? 0) -
        (INTERESTING_KIND_SCORE[left.node.kind] ?? 0) ||
      left.node.label.localeCompare(right.node.label, "zh-CN"));

  const directTargets = terms
    .filter((term) => term.length >= 4 && !SECONDARY_TARGET_TERMS.has(term))
    .map((term) => candidates
      .filter((candidate) => candidate.matchedTerms.includes(term))
      .sort((left, right) =>
        directTargetScore(right.node, term) - directTargetScore(left.node, term) ||
        right.score - left.score)[0])
    .filter((item): item is (typeof candidates)[number] => Boolean(item));
  const selected = candidates.length
    ? [...directTargets, ...candidates]
        .filter((item, index, all) =>
          all.findIndex((candidate) => candidate.node.id === item.node.id) === index)
        .filter((item, index) =>
          index < directTargets.length ||
          item.score >= Math.max(52, candidates[0].score * 0.2))
        .slice(0, 5)
    : scan.graph.nodes
        .filter((node) => Boolean(nodeSource(node)) && Boolean(INTERESTING_KIND_SCORE[node.kind]))
        .sort((left, right) =>
          (INTERESTING_KIND_SCORE[right.kind] ?? 0) -
            (INTERESTING_KIND_SCORE[left.kind] ?? 0) ||
          left.label.localeCompare(right.label, "zh-CN"))
        .slice(0, 5)
        .map((node) => ({ node, score: 1, matchedTerms: [] as string[] }));

  return selected.map<DevelopmentEvidenceTarget>(({ node, score, matchedTerms }) => {
    const source = nodeSource(node)!;
    const confidence = evidenceConfidence(node, matchedTerms, score);
    return {
      id: `evidence:${node.id}`,
      node,
      source,
      score,
      matchedTerms,
      confidence,
      reason: matchedTerms.length
        ? `命中 ${matchedTerms.join("、")}；${node.kind} 定义与源码位置可复核。`
        : "开发意图没有命中稳定标识符；按仓库中的核心可扩展定义回退。",
    };
  });
}

function entryEvidence(
  scan: LocalRepositoryScanResult,
  navigation: DevelopmentNavigationRequest | undefined,
) {
  if (!navigation) return null;
  const originNodeId = navigation.origin.plane === "runtime"
    ? undefined
    : navigation.origin.nodeId;
  const originNode = originNodeId
    ? scan.graph.nodes.find((node) => node.id === originNodeId)
    : undefined;
  const originSource = originNode ? nodeSource(originNode) : undefined;
  const explicitMatch = originNode && originSource && sameSourceLocation(
    navigation.source,
    originSource,
  )
    ? (() => {
        const requestedRevision = canonicalSourceIdentity(navigation.source).revision;
        const currentRevision = canonicalSourceIdentity(originSource).revision;
        const status: RuntimeSourceMatchStatus = requestedRevision && currentRevision && requestedRevision !== currentRevision
          ? "revision-mismatch"
          : scan.repository.dirty
            ? "worktree-dirty"
            : !requestedRevision || !currentRevision
              ? "revision-unverified"
              : "exact";
        const reason = status === "exact"
          ? "节点 ID、仓库、revision、路径与 symbol 完全一致。"
          : status === "worktree-dirty"
            ? "节点 ID 与源码位置一致，但当前扫描来自含未提交修改的工作树。"
            : status === "revision-unverified"
              ? "节点 ID 与源码位置一致，但入口或当前定义未声明 revision。"
              : `节点 ID 与源码位置一致，但入口 ${navigation.source.revision?.slice(0, 12) ?? "?"} 与当前定义 ${originSource.revision?.slice(0, 12) ?? "?"} 不一致。`;
        return { status, node: originNode, reason };
      })()
    : null;
  const match = explicitMatch ?? matchSourceToDefinition(scan.graph, navigation.source, {
    repositoryDirty: scan.repository.dirty,
  });
  if (!match) return null;
  const entry: DevelopmentEntryEvidence = {
    navigation,
    status: match.status,
    ...(match.node ? { matchedNodeId: match.node.id } : {}),
    reason: match.reason,
  };
  if (!match.node) return { entry, target: undefined };
  const source = nodeSource(match.node);
  if (!source) return { entry, target: undefined };
  const confidence: DevelopmentEvidenceConfidence = match.status === "exact"
    ? "exact"
    : ["worktree-dirty", "revision-unverified"].includes(match.status)
      ? "strong"
      : "inferred";
  const target: DevelopmentEvidenceTarget = {
    id: `evidence:${match.node.id}`,
    node: match.node,
    source,
    score: 1_000,
    matchedTerms: [navigation.source.symbol ?? navigation.source.path],
    confidence,
    reason: `跨平面 ${navigation.origin.plane.toUpperCase()} 结构化入口；${match.reason}`,
  };
  return { entry, target };
}

function pinEntryTarget(
  evidence: readonly DevelopmentEvidenceTarget[],
  target: DevelopmentEvidenceTarget | undefined,
) {
  if (!target) return evidence;
  return [target, ...evidence.filter((item) => item.node.id !== target.node.id)].slice(0, 5);
}

function relationDirection(edge: RegisteredGraphEdge, evidenceNodeId: string) {
  if (edge.kind === "contains") return "structural" as const;
  return edge.source === evidenceNodeId ? "outgoing" as const : "incoming" as const;
}

function impactTargets(
  scan: LocalRepositoryScanResult,
  evidence: readonly DevelopmentEvidenceTarget[],
) {
  const nodes = new Map(scan.graph.nodes.map((node) => [node.id, node]));
  const evidenceIds = new Set(evidence.map((item) => item.node.id));
  const impacts = new Map<string, DevelopmentImpactTarget>();

  evidence.forEach((target) => {
    scan.graph.edges
      .filter((edge) => edge.source === target.node.id || edge.target === target.node.id)
      .forEach((edge) => {
        const relatedId = edge.source === target.node.id ? edge.target : edge.source;
        if (evidenceIds.has(relatedId)) return;
        const node = nodes.get(relatedId);
        if (!node) return;
        const direction = relationDirection(edge, target.node.id);
        const key = `${node.id}:${edge.kind}:${direction}`;
        const exact = edge.evidence.some((item) => item.confidence === "exact");
        impacts.set(key, {
          id: `impact:${key}`,
          node,
          source: nodeSource(node),
          relationship: edge.kind,
          direction,
          evidenceNodeId: target.id,
          confidence: exact || edge.kind === "contains" ? "exact" : "inferred",
          reason: `${target.node.label} ${direction === "incoming" ? "被" : direction === "outgoing" ? "指向" : "结构关联"} ${node.label}（${edge.kind}）。`,
        });
      });
  });

  return [...impacts.values()]
    .sort((left, right) =>
      Number(right.confidence === "exact") - Number(left.confidence === "exact") ||
      Number(left.direction === "structural") - Number(right.direction === "structural") ||
      left.node.label.localeCompare(right.node.label, "zh-CN"))
    .slice(0, 10);
}

function riskForTarget(
  target: DevelopmentEvidenceTarget,
  impacts: readonly DevelopmentImpactTarget[],
): DevelopmentChangeSuggestion["risk"] {
  const count = impacts.filter((impact) => impact.evidenceNodeId === target.id).length;
  if (["agent", "team", "workflow"].includes(target.node.kind) || count >= 5) return "high";
  if (["rail", "tool", "class"].includes(target.node.kind) || count >= 2) return "medium";
  return "low";
}

function changeSuggestions(
  intent: string,
  evidence: readonly DevelopmentEvidenceTarget[],
  impacts: readonly DevelopmentImpactTarget[],
) {
  return evidence.slice(0, 3).map<DevelopmentChangeSuggestion>((target, index) => ({
    id: `change:${target.node.id}`,
    title: `${index + 1}. 在 ${target.node.label} 边界内收敛改动`,
    detail: `围绕“${intent}”调整 ${target.source.symbol ?? target.node.label}，先保持现有公开入口与 owner/context 语义，再处理直接关系节点。`,
    target,
    risk: riskForTarget(target, impacts),
    guardrails: [
      "不改变未被证据命中的公开合同",
      "不把推断关系标记为运行时事实",
      "修改后执行聚焦测试与全量回归",
    ],
  }));
}

function pathSegments(path: string) {
  return new Set(normalized(path).split(/[/.\\_-]+/).filter((part) => part.length >= 3));
}

function relatedTestNodes(
  scan: LocalRepositoryScanResult,
  evidence: readonly DevelopmentEvidenceTarget[],
) {
  const evidenceParts = new Set(
    evidence.flatMap((target) => [...pathSegments(target.source.path)]),
  );
  return scan.graph.nodes
    .map((node) => {
      const source = nodeSource(node);
      if (!source || !/(^|\/)(tests?|test_[^/]+)(\/|$)/i.test(source.path)) return null;
      const overlap = [...pathSegments(source.path)].filter((part) => evidenceParts.has(part)).length;
      return { node, source, score: overlap * 20 + (node.kind === "function" ? 3 : 0) };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path))
    .slice(0, 2);
}

function testSuggestions(
  scan: LocalRepositoryScanResult,
  evidence: readonly DevelopmentEvidenceTarget[],
) {
  const related = relatedTestNodes(scan, evidence);
  const primary = evidence[0];
  const focused = related.map<DevelopmentTestSuggestion>((item, index) => ({
    id: `test:focused:${item.node.id}:${index}`,
    title: `聚焦测试：${item.node.label}`,
    detail: `优先在 ${item.source.path} 增补与开发意图对应的成功、边界和失败断言。`,
    kind: "focused",
    source: item.source,
    evidenceLabel: item.node.label,
  }));
  const contractDetail = primary
    ? ["agent", "team", "workflow"].includes(primary.node.kind)
      ? "验证 lifecycle、Context owner、事件顺序和合法终态不变。"
      : primary.node.kind === "rail"
        ? "覆盖允许、拒绝、异常和审查输入原文边界。"
        : primary.node.kind === "tool"
          ? "覆盖注册、调用、错误、参数脱敏和 owner/session 隔离。"
          : "验证公开入口、返回结构和错误语义保持兼容。"
    : "验证公开入口与错误语义保持兼容。";
  return [
    ...focused,
    {
      id: "test:contract",
      title: "合同测试",
      detail: contractDetail,
      kind: "contract" as const,
      source: primary?.source,
      evidenceLabel: primary?.node.label ?? scan.repository.name,
    },
    {
      id: "test:regression",
      title: "仓库回归",
      detail: `执行 ${scan.repository.name} 已有测试、类型/静态检查与 Visualization 的 npm run check；本工具只提供建议，不运行目标仓命令。`,
      kind: "regression" as const,
      evidenceLabel: scan.repository.name,
    },
  ].slice(0, 4);
}

function patchOutlines(
  intent: string,
  changes: readonly DevelopmentChangeSuggestion[],
  tests: readonly DevelopmentTestSuggestion[],
) {
  return changes.slice(0, 2).map<DevelopmentPatchOutline>((change) => {
    const { source } = change.target;
    const symbol = source.symbol ?? change.target.node.label;
    const test = tests.find((item) => item.kind === "focused") ?? tests[0];
    return {
      id: `patch:${change.target.node.id}`,
      path: source.path,
      symbol: source.symbol,
      title: `${source.path} · ${symbol}`,
      applicable: false,
      basis: "structural-outline",
      preview: [
        "*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***",
        `*** Update File: ${source.path}`,
        `@@ ${symbol} @@`,
        "  [保留] 当前公开入口、owner/context 与错误语义",
        `+ [建议] ${intent}`,
        `+ [验证] ${test?.detail ?? "补充聚焦测试与全量回归"}`,
        "  [边界] 生成过程未读取写权限，也不会修改工作树",
      ].join("\n"),
    };
  });
}

function stages(projection: Omit<DevelopmentAnalysisProjection, "stages">) {
  const entryLabel = projection.entry
    ? ` · FROM ${projection.entry.navigation.origin.plane.toUpperCase()}`
    : "";
  const records: Array<[DevelopmentStageKind, string, string, number?]> = [
    ["intent", "开发意图", projection.intent],
    ["scope", "仓库范围", `${projection.repository.name}@${projection.repository.revision.slice(0, 12)}${entryLabel}`],
    ["evidence", "源码证据", `${projection.evidence.length} 个候选定义${projection.entry ? ` · ${projection.entry.status}` : ""}`, projection.evidence.length],
    ["diagnosis", "诊断", projection.diagnosis],
    ["impact", "影响范围", `${projection.impacts.length} 个关系节点`, projection.impacts.length],
    ["change-plan", "修改建议", `${projection.changes.length} 个有界改动`, projection.changes.length],
    ["test-plan", "测试建议", `${projection.tests.length} 个验证层`, projection.tests.length],
    ["patch-outline", "补丁草案", `${projection.patchOutlines.length} 份不可应用草案`, projection.patchOutlines.length],
    ["boundary", "只读边界", "repositoryWrite=false · modelAccess=false"],
  ];
  return records.map<DevelopmentStage>(([kind, label, summary, count], index) => ({
    id: `development-stage:${kind}`,
    kind,
    ordinal: index + 1,
    label,
    summary,
    ...(count === undefined ? {} : { count }),
  }));
}

export function projectDevelopmentAnalysis(
  scan: LocalRepositoryScanResult,
  rawIntent: string,
  navigation?: DevelopmentNavigationRequest,
): DevelopmentAnalysisProjection {
  const intent = rawIntent.trim();
  if (!intent) throw new TypeError("Development intent is required.");
  const terms = developmentIntentTerms(intent);
  const intentEvidence = evidenceTargets(scan, terms);
  const entryProjection = entryEvidence(scan, navigation);
  const evidence = pinEntryTarget(intentEvidence, entryProjection?.target);
  const impacts = impactTargets(scan, evidence);
  const changes = changeSuggestions(intent, evidence, impacts);
  const tests = testSuggestions(scan, evidence);
  const patchOutlines = patchOutlinesForProjection(intent, changes, tests);
  const hasDirectMatch = intentEvidence.some((item) => item.matchedTerms.length > 0);
  const entryDiagnosis = entryProjection
    ? `跨平面 ${entryProjection.entry.navigation.origin.plane.toUpperCase()} 入口为 ${entryProjection.entry.status}。`
    : "";
  const diagnosis = evidence.length
    ? `${entryDiagnosis}在 ${scan.repository.name} 当前 revision 中找到 ${evidence.length} 个可复核定义；${evidence.filter((item) => item.confidence === "exact").length} 个为精确标识符命中。`
    : `当前有界扫描没有找到可复核定义；不会生成无来源的修改建议。`;
  const base = {
    repository: scan.repository,
    intent,
    terms,
    evidence,
    impacts,
    changes,
    tests,
    patchOutlines,
    diagnosis,
    warnings: [
      ...scan.warnings,
      ...(scan.statistics.truncated ? ["仓库扫描达到上限，影响范围可能不完整。"] : []),
      ...(hasDirectMatch ? [] : ["意图中没有稳定代码标识符命中，证据按核心定义回退。"]),
      ...(entryProjection && entryProjection.entry.status !== "exact"
        ? [`跨平面源码身份为 ${entryProjection.entry.status}：${entryProjection.entry.reason}`]
        : []),
      "补丁内容是不可应用的结构草案，不包含模型生成代码。",
    ],
    ...(entryProjection ? { entry: entryProjection.entry } : {}),
    readOnly: true as const,
    repositoryWrite: false as const,
  };
  return { ...base, stages: stages(base) };
}

function patchOutlinesForProjection(
  intent: string,
  changes: readonly DevelopmentChangeSuggestion[],
  tests: readonly DevelopmentTestSuggestion[],
) {
  return patchOutlines(intent, changes, tests);
}
