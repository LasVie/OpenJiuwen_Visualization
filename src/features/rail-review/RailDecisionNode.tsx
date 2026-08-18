import {
  CheckCircle2,
  FileInput,
  GitCompareArrows,
  RadioTower,
  ShieldCheck,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type {
  RailDecisionFlowNode,
  RailDecisionKind,
} from "./decision-graph";

const icons: Record<RailDecisionKind, LucideIcon> = {
  payload: FileInput,
  hook: Webhook,
  check: ShieldCheck,
  mutation: GitCompareArrows,
  signal: RadioTower,
};

export function RailDecisionNode({ data }: NodeProps<RailDecisionFlowNode>) {
  const Icon = icons[data.kind] ?? CheckCircle2;

  return (
    <div
      className={[
        "rail-decision-node",
        `rail-decision-node--${data.kind}`,
        `rail-decision-node--${data.status}`,
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="rail-decision-node__handle"
      />
      <header>
        <span className="rail-decision-node__icon" aria-hidden="true">
          <Icon size={19} strokeWidth={1.8} />
        </span>
        <span className="rail-decision-node__phase">
          {data.sequence} · {data.phase}
        </span>
        <span className="rail-decision-node__status">{data.status}</span>
      </header>
      <strong>{data.label}</strong>
      <p>{data.summary}</p>
      <span className="rail-decision-node__hint">点击查看完整证据</span>
      <Handle
        type="source"
        position={Position.Right}
        className="rail-decision-node__handle"
      />
    </div>
  );
}

