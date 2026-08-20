import {
  AlertTriangle,
  ArrowUpRight,
  Braces,
  CheckCircle2,
  FileDiff,
  ListChecks,
  Network,
  Route,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { GraphSourceReference } from "../../kernel";
import { SourceViewer } from "../source-viewer";
import type {
  DevelopmentAnalysisProjection,
  DevelopmentChangeSuggestion,
  DevelopmentEvidenceTarget,
  DevelopmentEntryEvidence,
  DevelopmentImpactTarget,
  DevelopmentPatchOutline,
  DevelopmentSelection,
  DevelopmentStage,
  DevelopmentTestSuggestion,
} from "./model";

function EntryDetails({ entry }: { entry: DevelopmentEntryEvidence }) {
  const origin = entry.navigation.origin;
  const facts = origin.plane === "runtime"
    ? [
        ["trace step", `#${origin.sequence}`],
        ["event", origin.eventKind],
        ["phase", origin.phase],
        ["tokens", String(origin.tokenCount)],
      ]
    : origin.plane === "definition"
      ? [
          ["node", origin.nodeKind],
          ["runtime events", String(origin.runtime?.eventCount ?? 0)],
          ["runtime spans", String(origin.runtime?.spanCount ?? 0)],
          ["tokens", String(origin.runtime?.tokenCount ?? 0)],
        ]
      : [
          ["change", `${origin.file.status} / ${origin.impact.kind}`],
          ["confidence", origin.impact.confidence],
          ["hunks", origin.impact.hunkIndexes.length
            ? origin.impact.hunkIndexes.map((index) => index + 1).join(", ")
            : "—"],
          ["comparison", `${origin.comparison.base} → ${origin.comparison.head}`],
        ];
  return (
    <section className={`development-entry-evidence development-entry-evidence--${origin.plane}`}>
      <header>
        <Route size={13} />
        <span>跨平面入口</span>
        <em>{entry.status}</em>
      </header>
      <code>{entry.navigation.source.repository}@{entry.navigation.source.revision?.slice(0, 12) ?? "?"}</code>
      <strong>{entry.navigation.source.path}{entry.navigation.source.symbol ? `:${entry.navigation.source.symbol}` : ""}</strong>
      <p>{entry.reason}</p>
      <dl>
        {facts.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </section>
  );
}

type ResolvedSelection =
  | { kind: "stage"; value: DevelopmentStage }
  | { kind: "evidence"; value: DevelopmentEvidenceTarget }
  | { kind: "impact"; value: DevelopmentImpactTarget }
  | { kind: "change"; value: DevelopmentChangeSuggestion }
  | { kind: "test"; value: DevelopmentTestSuggestion }
  | { kind: "patch"; value: DevelopmentPatchOutline };

function resolveSelection(
  projection: DevelopmentAnalysisProjection,
  selection: DevelopmentSelection | null,
): ResolvedSelection {
  if (selection?.kind === "evidence") {
    const value = projection.evidence.find((item) => item.id === selection.id);
    if (value) return { kind: "evidence", value };
  }
  if (selection?.kind === "impact") {
    const value = projection.impacts.find((item) => item.id === selection.id);
    if (value) return { kind: "impact", value };
  }
  if (selection?.kind === "change") {
    const value = projection.changes.find((item) => item.id === selection.id);
    if (value) return { kind: "change", value };
  }
  if (selection?.kind === "test") {
    const value = projection.tests.find((item) => item.id === selection.id);
    if (value) return { kind: "test", value };
  }
  if (selection?.kind === "patch") {
    const value = projection.patchOutlines.find((item) => item.id === selection.id);
    if (value) return { kind: "patch", value };
  }
  const stage = selection?.kind === "stage"
    ? projection.stages.find((item) => item.id === selection.id)
    : projection.stages[0];
  return { kind: "stage", value: stage ?? projection.stages[0] };
}

function selectionPresentation(selection: ResolvedSelection) {
  if (selection.kind === "stage") return { icon: Braces, eyebrow: "ANALYSIS STAGE", title: selection.value.label, summary: selection.value.summary };
  if (selection.kind === "evidence") return { icon: Search, eyebrow: "SOURCE EVIDENCE", title: selection.value.node.label, summary: selection.value.reason };
  if (selection.kind === "impact") return { icon: Network, eyebrow: "RELATION IMPACT", title: selection.value.node.label, summary: selection.value.reason };
  if (selection.kind === "change") return { icon: Wrench, eyebrow: "CHANGE SUGGESTION", title: selection.value.title, summary: selection.value.detail };
  if (selection.kind === "test") return { icon: ListChecks, eyebrow: "TEST SUGGESTION", title: selection.value.title, summary: selection.value.detail };
  return { icon: FileDiff, eyebrow: "PATCH OUTLINE", title: selection.value.title, summary: "不可应用的结构草案；不包含生成代码，也不会写入工作树。" };
}

function selectionSource(selection: ResolvedSelection): GraphSourceReference | undefined {
  if (selection.kind === "evidence") return selection.value.source;
  if (selection.kind === "impact") return selection.value.source;
  if (selection.kind === "change") return selection.value.target.source;
  if (selection.kind === "test") return selection.value.source;
  if (selection.kind === "patch") return {
    repository: "",
    path: selection.value.path,
    ...(selection.value.symbol ? { symbol: selection.value.symbol } : {}),
  };
  return undefined;
}

function EvidenceDetails({ value }: { value: DevelopmentEvidenceTarget }) {
  return (
    <dl className="development-inspector__facts">
      <div><dt>置信度</dt><dd>{value.confidence}</dd></div>
      <div><dt>节点类型</dt><dd>{value.node.kind}</dd></div>
      <div><dt>匹配分</dt><dd>{value.score.toFixed(1)}</dd></div>
      <div><dt>命中词</dt><dd>{value.matchedTerms.join(" · ") || "核心定义回退"}</dd></div>
    </dl>
  );
}

function StageDetails({
  stage,
  projection,
}: {
  stage: DevelopmentStage;
  projection: DevelopmentAnalysisProjection;
}) {
  const items = stage.kind === "evidence"
    ? projection.evidence.map((item) => ({ id: item.id, text: item.node.label }))
    : stage.kind === "impact"
      ? projection.impacts.map((item) => ({ id: item.id, text: `${item.node.label} · ${item.relationship}` }))
      : stage.kind === "change-plan"
        ? projection.changes.map((item) => ({ id: item.id, text: item.title }))
        : stage.kind === "test-plan"
          ? projection.tests.map((item) => ({ id: item.id, text: item.title }))
          : stage.kind === "patch-outline"
            ? projection.patchOutlines.map((item) => ({ id: item.id, text: item.title }))
            : [];
  return items.length ? (
    <section className="development-inspector__list">
      <h3>本阶段内容</h3>
      {items.map((item) => <p key={item.id}><CheckCircle2 size={12} />{item.text}</p>)}
    </section>
  ) : null;
}

interface DevelopmentInspectorProps {
  projection: DevelopmentAnalysisProjection;
  selection: DevelopmentSelection | null;
  onOpenDefinition?: (source: GraphSourceReference) => void;
}

export function DevelopmentInspector({
  projection,
  selection,
  onOpenDefinition,
}: DevelopmentInspectorProps) {
  const resolved = resolveSelection(projection, selection);
  const presentation = selectionPresentation(resolved);
  const Icon = presentation.icon;
  const source = selectionSource(resolved);
  const sourceWithRepository = source
    ? { ...source, repository: source.repository || projection.repository.name, revision: source.revision ?? projection.repository.revision }
    : undefined;
  return (
    <aside className="development-inspector">
      <header>
        <span className="development-inspector__icon"><Icon size={18} /></span>
        <span>
          <small>{presentation.eyebrow}</small>
          <strong>{presentation.title}</strong>
        </span>
      </header>
      <div className="development-inspector__scroll">
        <p className="development-inspector__summary">{presentation.summary}</p>

        {projection.entry ? <EntryDetails entry={projection.entry} /> : null}

        {resolved.kind === "stage" ? <StageDetails stage={resolved.value} projection={projection} /> : null}
        {resolved.kind === "evidence" ? <EvidenceDetails value={resolved.value} /> : null}
        {resolved.kind === "impact" ? (
          <dl className="development-inspector__facts">
            <div><dt>关系</dt><dd>{resolved.value.relationship}</dd></div>
            <div><dt>方向</dt><dd>{resolved.value.direction}</dd></div>
            <div><dt>证据</dt><dd>{resolved.value.confidence}</dd></div>
          </dl>
        ) : null}
        {resolved.kind === "change" ? (
          <>
            <span className={`development-risk development-risk--${resolved.value.risk}`}>{resolved.value.risk.toUpperCase()} RISK</span>
            <section className="development-inspector__list">
              <h3>约束</h3>
              {resolved.value.guardrails.map((item) => <p key={item}><ShieldCheck size={12} />{item}</p>)}
            </section>
          </>
        ) : null}
        {resolved.kind === "test" ? (
          <dl className="development-inspector__facts">
            <div><dt>验证层</dt><dd>{resolved.value.kind}</dd></div>
            <div><dt>证据对象</dt><dd>{resolved.value.evidenceLabel}</dd></div>
          </dl>
        ) : null}
        {resolved.kind === "patch" ? (
          <section className="development-patch-preview">
            <header><AlertTriangle size={13} /><span>NOT APPLICABLE</span></header>
            <pre>{resolved.value.preview}</pre>
          </section>
        ) : null}

        {sourceWithRepository ? (
          <section className="development-inspector__source">
            <h3>源码锚点</h3>
            <code>{sourceWithRepository.path}{sourceWithRepository.symbol ? `:${sourceWithRepository.symbol}` : ""}</code>
            <div>
              {sourceWithRepository.startLine ? (
                <SourceViewer
                  repositoryPath={projection.repository.path}
                  source={sourceWithRepository}
                  buttonLabel="查看源码证据"
                />
              ) : null}
              {onOpenDefinition ? (
                <button type="button" onClick={() => onOpenDefinition(sourceWithRepository)}>
                  <ArrowUpRight size={13} />定义图定位
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="development-inspector__boundary">
          <ShieldCheck size={15} />
          <span><strong>只读分析</strong><small>未请求 repository write、Shell 或模型权限</small></span>
        </section>
      </div>
    </aside>
  );
}
