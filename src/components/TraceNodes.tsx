import {
  ArchiveRestore,
  BrainCircuit,
  Braces,
  GitFork,
  Layers3,
  Maximize2,
  MessageSquareText,
  Network,
  Repeat2,
  Route,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ownerClassName } from "../domain/runtime/ownership";
import { getRailReviewProfile } from "../features/rail-review";
import { RuntimeBadge } from "../shared/ui/RuntimeBadge";
import type {
  RailNodeDefinition,
  StageNodeDefinition,
  TraceNodeStatus,
} from "../types/trace";

export interface StageNodeData extends Record<string, unknown> {
  definition: StageNodeDefinition;
  status: TraceNodeStatus;
  eventCode?: string;
  hierarchy?: "outer" | "main" | "branch";
  compact?: boolean;
}

export interface RailNodeData extends Record<string, unknown> {
  definition: RailNodeDefinition;
  status: TraceNodeStatus;
  eventCode?: string;
}

export interface AgentSummaryNodeData extends Record<string, unknown> {
  definition: StageNodeDefinition;
  status: TraceNodeStatus;
  eventCode?: string;
  currentStage: string;
}

export interface AgentGroupNodeData extends Record<string, unknown> {
  definition: StageNodeDefinition;
  status: TraceNodeStatus;
  eventCode?: string;
  currentStage: string;
}

export type StageFlowNode = Node<StageNodeData, "stage">;
export type RailFlowNode = Node<RailNodeData, "rail">;
export type AgentSummaryFlowNode = Node<AgentSummaryNodeData, "agentSummary">;
export type AgentGroupFlowNode = Node<AgentGroupNodeData, "agentGroup">;
export type TraceFlowNode =
  | StageFlowNode
  | RailFlowNode
  | AgentSummaryFlowNode
  | AgentGroupFlowNode;

const stageIcons: Record<StageNodeDefinition["kind"], LucideIcon> = {
  input: MessageSquareText,
  agent: BrainCircuit,
  loop: Repeat2,
  context: Layers3,
  model: Sparkles,
  decision: GitFork,
  tool: Wrench,
  output: Send,
};

const statusLabels: Record<TraceNodeStatus, string> = {
  idle: "WAIT",
  visited: "DONE",
  active: "NOW",
  muted: "NOT USED",
};

export function StageNode({ data }: NodeProps<StageFlowNode>) {
  const { definition, status, eventCode, hierarchy, compact } = data;
  const Icon = stageIcons[definition.kind];

  return (
    <div
      className={[
        "trace-node",
        "trace-node--stage",
        "trace-node--" + status,
        "trace-node--kind-" + definition.kind,
        ownerClassName(definition.owner),
        compact ? "trace-node--compact" : "",
        hierarchy ? "trace-node--hierarchy-" + hierarchy : "",
        definition.accent ? "trace-node--accent-" + definition.accent : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle
        id="flow-target"
        type="target"
        position={Position.Left}
        className="trace-handle"
      />
      <Handle
        id="flow-target-right"
        type="target"
        position={Position.Right}
        className="trace-handle"
      />
      <Handle
        id="rail-target-top"
        type="target"
        position={Position.Top}
        className="trace-handle trace-handle--rail"
      />
      <Handle
        id="flow-target-bottom"
        type="target"
        position={Position.Bottom}
        className="trace-handle"
      />

      <div className="trace-node__header">
        <span className="trace-node__icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="trace-node__header-meta">
          <RuntimeBadge owner={definition.owner} compact />
          <span className={"trace-node__status trace-node__status--" + status}>
            {statusLabels[status]}
          </span>
        </span>
      </div>
      <strong className="trace-node__label">{definition.label}</strong>
      <span className="trace-node__subtitle">{definition.subtitle}</span>
      {status === "active" && eventCode ? (
        <code className="trace-node__event">{eventCode}</code>
      ) : (
        <span className="trace-node__hint">点击查看实现详情</span>
      )}

      <Handle
        id="flow-source"
        type="source"
        position={Position.Right}
        className="trace-handle"
      />
      <Handle
        id="flow-source-bottom"
        type="source"
        position={Position.Bottom}
        className="trace-handle"
      />
      <Handle
        id="flow-source-left"
        type="source"
        position={Position.Left}
        className="trace-handle"
      />
    </div>
  );
}

export function AgentSummaryNode({
  data,
}: NodeProps<AgentSummaryFlowNode>) {
  const { definition, status, eventCode, currentStage } = data;

  return (
    <div
      className={[
        "agent-summary",
        "agent-summary--" + status,
        ownerClassName(definition.owner),
      ].join(" ")}
    >
      <Handle
        id="flow-target"
        type="target"
        position={Position.Left}
        className="trace-handle"
      />
      <Handle
        id="rail-target-top"
        type="target"
        position={Position.Top}
        className="trace-handle trace-handle--rail"
      />
      <div className="agent-summary__topline">
        <RuntimeBadge owner={definition.owner} />
        <span className={"trace-node__status trace-node__status--" + status}>
          {statusLabels[status]}
        </span>
      </div>
      <strong className="agent-summary__title">{definition.label}</strong>
      <span className="agent-summary__subtitle">
        lifecycle · orchestration · session
      </span>
      <div className="agent-summary__inner">
        <span className="agent-summary__inner-icon" aria-hidden="true">
          <Repeat2 size={17} strokeWidth={2} />
        </span>
        <span>
          <strong>包含 ReActAgent</strong>
          <small>Context → Model → Decision ↺ Tool</small>
        </span>
        <Maximize2 size={15} strokeWidth={1.8} aria-hidden="true" />
      </div>
      <div className="agent-summary__footer">
        <code>{eventCode ?? currentStage}</code>
        <span>点击展开内部链路</span>
      </div>
      <Handle
        id="flow-source"
        type="source"
        position={Position.Right}
        className="trace-handle"
      />
    </div>
  );
}

export function AgentGroupNode({ data }: NodeProps<AgentGroupFlowNode>) {
  const { definition, status, eventCode, currentStage } = data;

  return (
    <div
      className={[
        "agent-group",
        "agent-group--" + status,
        ownerClassName(definition.owner),
      ].join(" ")}
    >
      <Handle
        id="flow-target"
        type="target"
        position={Position.Left}
        className="trace-handle"
      />
      <Handle
        id="rail-target-top"
        type="target"
        position={Position.Top}
        className="trace-handle trace-handle--rail"
      />
      <header className="agent-group__header">
        <span className="agent-group__identity">
          <span aria-hidden="true">
            <BrainCircuit size={20} strokeWidth={2} />
          </span>
          <span>
            <small>AGENT CORE · OUTER AGENT</small>
            <strong>{definition.label}</strong>
          </span>
        </span>
        <span className="agent-group__current">
          <Network size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>
            <small>CURRENT INTERNAL STAGE</small>
            <code>{eventCode ?? currentStage}</code>
          </span>
        </span>
      </header>
      <div className="agent-group__lane agent-group__lane--main">
        <span>MAIN REACT PATH</span>
      </div>
      <div className="agent-group__lane agent-group__lane--branch">
        <span>TOOL BRANCH · observation returns to Context</span>
      </div>
      <Handle
        id="flow-source"
        type="source"
        position={Position.Right}
        className="trace-handle"
      />
    </div>
  );
}

function railIcon(definition: RailNodeDefinition): LucideIcon {
  if (definition.lifecycle === "init") return ArchiveRestore;
  if (definition.id.includes("safety")) return ShieldCheck;
  if (definition.id.includes("trajectory")) return Route;
  return Braces;
}

export function RailNode({ data }: NodeProps<RailFlowNode>) {
  const { definition, status, eventCode } = data;
  const Icon = railIcon(definition);
  const review = getRailReviewProfile(definition.id);

  return (
    <div
      className={[
        "trace-node",
        "trace-node--rail",
        "trace-node--" + status,
        ownerClassName(definition.owner),
      ].join(" ")}
    >
      <Handle
        id="rail-source-top"
        type="source"
        position={Position.Top}
        className="trace-handle trace-handle--rail"
      />
      <div className="rail-node__heading">
        <span className="rail-node__icon" aria-hidden="true">
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <span>
          <strong>{definition.label}</strong>
          <small>{definition.subtitle}</small>
        </span>
        <span className="rail-node__count">{definition.hooks.length}</span>
      </div>
      <div className="rail-node__target">
        <ScanSearch size={14} strokeWidth={1.9} aria-hidden="true" />
        <span>
          <small>审查 {review.targetLabel}</small>
          <code>{review.targetPath}</code>
        </span>
      </div>
      <div className="rail-node__hooks" aria-label="Rail hooks">
        {definition.hooks.slice(0, 1).map((hook) => (
          <span className="rail-hook" key={hook.event}>
            <code>{hook.event}</code>
            <b>p{hook.priority}</b>
          </span>
        ))}
        {definition.hooks.length > 1 ? (
          <span className="rail-hook rail-hook--more">
            +{definition.hooks.length - 1} hook
          </span>
        ) : null}
      </div>
      <div className="rail-node__review-hint">
        <span>{status === "active" ? eventCode ?? "审查中" : "打开决策画布"}</span>
        <RuntimeBadge owner={definition.owner} compact />
      </div>
      <Handle
        id="rail-source-bottom"
        type="source"
        position={Position.Bottom}
        className="trace-handle trace-handle--rail"
      />
    </div>
  );
}
