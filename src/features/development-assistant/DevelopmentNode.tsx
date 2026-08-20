import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  GitBranch,
  ListChecks,
  Network,
  Search,
  ShieldCheck,
  Target,
  Wrench,
} from "lucide-react";
import type {
  DevelopmentChangeSuggestion,
  DevelopmentEvidenceTarget,
  DevelopmentImpactTarget,
  DevelopmentPatchOutline,
  DevelopmentStage,
  DevelopmentTestSuggestion,
} from "./model";

export type DevelopmentNodeEntity =
  | DevelopmentEvidenceTarget
  | DevelopmentImpactTarget
  | DevelopmentChangeSuggestion
  | DevelopmentTestSuggestion
  | DevelopmentPatchOutline;

export type DevelopmentNodeData = {
  variant: "stage" | "evidence" | "impact" | "change" | "test" | "patch";
  label: string;
  summary: string;
  status: "future" | "active" | "visited";
  owner: string;
  stage?: DevelopmentStage;
  entity?: DevelopmentNodeEntity;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  meta?: readonly string[];
  groupKind?: DevelopmentStage["kind"];
} & Record<string, unknown>;

export type DevelopmentFlowNode = Node<DevelopmentNodeData, "development">;

function StageIcon({ stage }: { stage?: DevelopmentStage }) {
  if (!stage) return <Braces size={15} aria-hidden="true" />;
  if (stage.kind === "intent") return <Target size={15} aria-hidden="true" />;
  if (stage.kind === "scope") return <GitBranch size={15} aria-hidden="true" />;
  if (stage.kind === "evidence") return <Search size={15} aria-hidden="true" />;
  if (stage.kind === "diagnosis") return <Braces size={15} aria-hidden="true" />;
  if (stage.kind === "impact") return <Network size={15} aria-hidden="true" />;
  if (stage.kind === "change-plan") return <Wrench size={15} aria-hidden="true" />;
  if (stage.kind === "test-plan") return <ListChecks size={15} aria-hidden="true" />;
  if (stage.kind === "patch-outline") return <FileDiff size={15} aria-hidden="true" />;
  return <ShieldCheck size={15} aria-hidden="true" />;
}

function ChildIcon({ variant }: { variant: DevelopmentNodeData["variant"] }) {
  if (variant === "evidence") return <FileCode2 size={14} aria-hidden="true" />;
  if (variant === "impact") return <Network size={14} aria-hidden="true" />;
  if (variant === "change") return <Wrench size={14} aria-hidden="true" />;
  if (variant === "test") return <ListChecks size={14} aria-hidden="true" />;
  return <FileDiff size={14} aria-hidden="true" />;
}

function variantLabel(data: DevelopmentNodeData) {
  if (data.variant === "stage") {
    return `${String(data.stage?.ordinal ?? 0).padStart(2, "0")} · ${data.stage?.kind.toUpperCase() ?? "STAGE"}`;
  }
  if (data.variant === "evidence") return "SOURCE EVIDENCE";
  if (data.variant === "impact") return "RELATION IMPACT";
  if (data.variant === "change") return "CHANGE SUGGESTION";
  if (data.variant === "test") return "TEST SUGGESTION";
  return "PATCH OUTLINE";
}

export function DevelopmentNode({ data, selected }: NodeProps<DevelopmentFlowNode>) {
  const isStage = data.variant === "stage";
  return (
    <article
      className={[
        "development-node",
        `development-node--${data.variant}`,
        data.stage ? `development-node--stage-${data.stage.kind}` : "",
        `development-node--${data.status}`,
        `development-node--owner-${data.owner}`,
        selected ? "development-node--selected" : "",
      ].filter(Boolean).join(" ")}
    >
      <Handle type="target" position={Position.Left} id="target-left" />
      <Handle type="target" position={Position.Top} id="target-top" />
      <header>
        <span className="development-node__icon">
          {isStage ? <StageIcon stage={data.stage} /> : <ChildIcon variant={data.variant} />}
        </span>
        <span className="development-node__kind">{variantLabel(data)}</span>
        {data.expandable ? (
          <button
            type="button"
            className="development-node__expand nodrag nopan"
            onClick={(event) => {
              event.stopPropagation();
              data.onToggle?.();
            }}
            aria-label={`${data.expanded ? "收起" : "展开"}${data.label}分支`}
            aria-expanded={data.expanded}
          >
            {data.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : null}
      </header>
      <strong>{data.label}</strong>
      <p>{data.summary}</p>
      <footer>
        {(data.meta ?? []).slice(0, 3).map((item) => <span key={item}>{item}</span>)}
        {isStage && data.stage?.count !== undefined ? <em>{data.stage.count}</em> : null}
      </footer>
      <Handle type="source" position={Position.Right} id="source-right" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />
    </article>
  );
}
