import {
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  FolderTree,
  Network,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { RegisteredGraphNode } from "../../kernel";

export interface RelationNodeData extends Record<string, unknown> {
  record: RegisteredGraphNode;
  root: boolean;
  expanded: boolean;
  expandable: boolean;
  totalRelations: number;
  visibleRelations: number;
  hiddenRelations: number;
  onToggle: (nodeId: string) => void;
}

export type RelationFlowNode = Node<RelationNodeData, "relationExplorer">;

const kindIcons: Record<string, LucideIcon> = {
  repository: Database,
  package: FolderTree,
  module: FileCode2,
  agent: Bot,
  rail: ShieldCheck,
  tool: Wrench,
  class: Braces,
  function: Braces,
};

function ownerLabel(owner: string) {
  if (owner === "agent-core") return "AGENT CORE";
  if (owner === "jiuwenswarm") return "JIUWEN SWARM";
  return owner.toLocaleUpperCase();
}

export function RelationNode({ data, selected }: NodeProps<RelationFlowNode>) {
  const Icon = kindIcons[data.record.kind] ?? Network;
  const source = data.record.evidence.find((evidence) => evidence.source)?.source;
  return (
    <article
      className={[
        "relation-node",
        `relation-node--${data.record.owner}`,
        data.root ? "relation-node--root" : "",
        selected ? "relation-node--selected" : "",
      ].filter(Boolean).join(" ")}
    >
      <Handle type="target" position={Position.Left} className="relation-node__handle" />
      <div className="relation-node__eyebrow">
        <span>{ownerLabel(data.record.owner)}</span>
        <code>{data.record.kind}</code>
        {data.root ? <em>起点</em> : null}
      </div>
      <div className="relation-node__identity">
        <span><Icon size={18} strokeWidth={1.8} /></span>
        <div>
          <strong>{data.record.label}</strong>
          <small>{source?.symbol ?? source?.path ?? data.record.summary}</small>
        </div>
      </div>
      <footer>
        <span>{data.visibleRelations}/{data.totalRelations} 条关系</span>
        {data.root ? (
          <small>当前中心</small>
        ) : data.expandable ? (
          <button
            type="button"
            className="nodrag nopan"
            onClick={(event) => {
              event.stopPropagation();
              data.onToggle(data.record.id);
            }}
            aria-label={`${data.expanded ? "收起" : "展开"}${data.record.label}的关系`}
          >
            {data.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {data.expanded ? "收起" : `展开${data.hiddenRelations ? ` +${data.hiddenRelations}` : ""}`}
          </button>
        ) : (
          <small>无可见关系</small>
        )}
      </footer>
      <Handle type="source" position={Position.Right} className="relation-node__handle" />
    </article>
  );
}

