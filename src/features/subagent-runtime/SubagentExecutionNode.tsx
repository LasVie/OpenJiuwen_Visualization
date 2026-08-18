import {
  Bot,
  BrainCircuit,
  Braces,
  Database,
  GitBranch,
  LogIn,
  LogOut,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import type {
  SubagentExecutionFlowNode,
  SubagentExecutionNodeData,
} from "./graph";

const ICONS: Record<SubagentExecutionNodeData["stage"]["kind"], LucideIcon> = {
  dispatch: LogIn,
  session: Database,
  agent: Bot,
  context: Braces,
  rail: ShieldCheck,
  model: BrainCircuit,
  tool: Wrench,
  ability: GitBranch,
  result: LogOut,
};

const STATUS = {
  waiting: "WAIT",
  running: "RUNNING",
  completed: "DONE",
  failed: "FAILED",
  observed: "OBSERVED",
};

export function SubagentExecutionNode({ data }: NodeProps<SubagentExecutionFlowNode>) {
  const { stage, sequence, owner } = data;
  const Icon = ICONS[stage.kind];
  return (
    <article className={[
      "subagent-execution-node",
      `subagent-execution-node--${stage.kind}`,
      `subagent-execution-node--${stage.status}`,
      `subagent-execution-node--${owner}`,
    ].join(" ")}>
      <Handle
        id="subagent-target"
        type="target"
        position={Position.Left}
        className="subagent-execution-node__handle"
      />
      <header>
        <span className="subagent-execution-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <span className="subagent-execution-node__kind">{sequence} · {stage.kind}</span>
        <span className={`subagent-execution-node__status subagent-execution-node__status--${stage.status}`}>
          {STATUS[stage.status]}
        </span>
      </header>
      <strong>{stage.label}</strong>
      <p>{stage.summary}</p>
      <footer>
        <code>seq {stage.firstSequence}{stage.lastSequence !== stage.firstSequence ? `–${stage.lastSequence}` : ""}</code>
        <RuntimeBadge owner={owner} compact />
      </footer>
      <Handle
        id="subagent-source"
        type="source"
        position={Position.Right}
        className="subagent-execution-node__handle"
      />
    </article>
  );
}
