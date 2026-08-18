import {
  Bot,
  Boxes,
  Braces,
  BrainCircuit,
  Database,
  FileCode2,
  FolderTree,
  GitFork,
  Network,
  ShieldCheck,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { RegisteredGraphNode } from "../../kernel";

export interface DefinitionNodeData extends Record<string, unknown> {
  record: RegisteredGraphNode;
  childCount: number;
  relationCount: number;
  focus: boolean;
}

export type DefinitionFlowNode = Node<DefinitionNodeData, "definition">;

const kindIcons: Record<string, LucideIcon> = {
  repository: Database,
  package: FolderTree,
  module: FileCode2,
  class: Braces,
  function: Braces,
  agent: Bot,
  rail: ShieldCheck,
  context: BrainCircuit,
  tool: Wrench,
  workflow: Workflow,
  model: Boxes,
  team: Network,
};

function ownerLabel(owner: string) {
  if (owner === "agent-core") return "AGENT CORE";
  if (owner === "jiuwenswarm") return "JIUWEN SWARM";
  return owner.toLocaleUpperCase();
}

function ownerClass(owner: string) {
  if (owner === "agent-core") return "definition-node--core";
  if (owner === "jiuwenswarm") return "definition-node--swarm";
  return "definition-node--local";
}

export function DefinitionNode({ data, selected }: NodeProps<DefinitionFlowNode>) {
  const { record, childCount, relationCount, focus } = data;
  const Icon = kindIcons[record.kind] ?? GitFork;
  const source = record.evidence.find((evidence) => evidence.source)?.source;
  const footer = childCount > 0
    ? `${childCount} 个子节点 · 双击进入`
    : relationCount > 0
      ? `${relationCount} 条关系 · 双击查看`
      : "静态定义叶节点";

  return (
    <div
      className={[
        "definition-node",
        ownerClass(record.owner),
        "definition-node--kind-" + record.kind,
        focus ? "definition-node--focus" : "",
        selected ? "definition-node--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle id="target-left" type="target" position={Position.Left} className="definition-handle" />
      <Handle id="target-top" type="target" position={Position.Top} className="definition-handle" />
      <div className="definition-node__topline">
        <span className="definition-node__owner">{ownerLabel(record.owner)}</span>
        <span className="definition-node__kind">{record.kind}</span>
      </div>
      <div className="definition-node__identity">
        <span className="definition-node__icon" aria-hidden="true">
          <Icon size={19} strokeWidth={1.8} />
        </span>
        <span>
          <strong>{record.label}</strong>
          <small>{source?.symbol ?? source?.path ?? "repository definition"}</small>
        </span>
      </div>
      <p>{record.summary}</p>
      <div className="definition-node__footer">
        <span>{footer}</span>
        <code>L{record.level}</code>
      </div>
      <Handle id="source-right" type="source" position={Position.Right} className="definition-handle" />
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="definition-handle" />
    </div>
  );
}
