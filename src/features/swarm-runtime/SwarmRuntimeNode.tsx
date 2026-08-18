import {
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  GitBranch,
  ListChecks,
  Network,
  Sparkles,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import type {
  SwarmRuntimeSubject,
  SwarmSubjectStatus,
} from "./model";

export interface SwarmRuntimeNodeData extends Record<string, unknown> {
  subject: SwarmRuntimeSubject;
  status: SwarmSubjectStatus;
  active: boolean;
  expandable: boolean;
  expanded: boolean;
  contextActive: boolean;
  childCount: number;
  eventCode?: string;
  eventCountAtStep: number;
}

export type SwarmRuntimeFlowNode = Node<
  SwarmRuntimeNodeData,
  "swarmSubject"
>;

const KIND_ICON: Record<SwarmRuntimeSubject["kind"], LucideIcon> = {
  team: UsersRound,
  workflow: Workflow,
  phase: GitBranch,
  member: CircleUserRound,
  agent: Bot,
  subagent: Sparkles,
  human: CircleUserRound,
  task: ListChecks,
};

const STATUS_LABEL: Record<SwarmSubjectStatus, string> = {
  planned: "等待",
  running: "运行中",
  waiting: "等待输入",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  observed: "已观测",
};

export function SwarmRuntimeNode({ data }: NodeProps<SwarmRuntimeFlowNode>) {
  const {
    subject,
    status,
    active,
    expandable,
    expanded,
    contextActive,
    childCount,
    eventCode,
    eventCountAtStep,
  } = data;
  const Icon = KIND_ICON[subject.kind] ?? Boxes;

  return (
    <div
      className={[
        "swarm-runtime-node",
        `swarm-runtime-node--${subject.kind}`,
        `swarm-runtime-node--${status}`,
        active ? "swarm-runtime-node--active" : "",
        contextActive ? "swarm-runtime-node--context" : "",
      ].filter(Boolean).join(" ")}
    >
      <Handle
        id="swarm-target"
        type="target"
        position={Position.Left}
        className="swarm-runtime-handle"
      />

      <header className="swarm-runtime-node__header">
        <span className="swarm-runtime-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <span className="swarm-runtime-node__identity">
          <small>{subject.kind.toUpperCase()}{subject.role ? ` · ${subject.role}` : ""}</small>
          <strong>{subject.label}</strong>
        </span>
        <span className={`swarm-runtime-node__status swarm-runtime-node__status--${status}`}>
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="swarm-runtime-node__meta">
        <span><Network size={12} aria-hidden="true" />{eventCountAtStep} events</span>
        {subject.contextOwnerId ? <code>CTX</code> : null}
        {contextActive ? <b>正在查看 Context</b> : null}
      </div>

      <footer className="swarm-runtime-node__footer">
        <span className="swarm-runtime-node__event">
          {active ? eventCode ?? "active" : `step ${subject.lastStep + 1}`}
        </span>
        {expandable ? (
          <span className="swarm-runtime-node__expand">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {childCount} 子节点
          </span>
        ) : null}
        {subject.kind === "subagent" ? (
          <span className="swarm-runtime-node__drilldown">打开执行画布</span>
        ) : null}
        <RuntimeBadge owner="jiuwenswarm" compact />
      </footer>

      <Handle
        id="swarm-source"
        type="source"
        position={Position.Right}
        className="swarm-runtime-handle"
      />
    </div>
  );
}
