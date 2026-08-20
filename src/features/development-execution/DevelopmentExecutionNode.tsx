import {
  Check,
  Eye,
  FlaskConical,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type {
  DevelopmentExecutionNodeState,
  DevelopmentExecutionStep,
} from "./model";

export interface DevelopmentExecutionNodeData extends Record<string, unknown> {
  step: DevelopmentExecutionStep;
  kicker: string;
  label: string;
  detail: string;
  state: DevelopmentExecutionNodeState;
  status: string;
}

export type DevelopmentExecutionFlowNode = Node<
  DevelopmentExecutionNodeData,
  "development-execution"
>;

const iconByStep = {
  review: Eye,
  apply: GitBranch,
  test: FlaskConical,
  commit: GitCommitHorizontal,
  rollback: RotateCcw,
  source: ShieldCheck,
} satisfies Record<DevelopmentExecutionStep, typeof Eye>;

function StateIcon({ state }: { state: DevelopmentExecutionNodeState }) {
  if (state === "active") return <LoaderCircle size={13} className="spin" />;
  if (state === "success" || state === "protected") return <Check size={13} />;
  if (state === "error") return <TriangleAlert size={13} />;
  return <span aria-hidden="true" />;
}

export function DevelopmentExecutionNode({ data, selected }: NodeProps<DevelopmentExecutionFlowNode>) {
  const Icon = iconByStep[data.step];
  const branchNode = data.step === "source" || data.step === "rollback";
  return (
    <article
      className={`development-execution-node development-execution-node--${data.step} development-execution-node--${data.state} ${selected ? "development-execution-node--selected" : ""}`}
    >
      {data.step !== "review" ? (
        <Handle
          type="target"
          position={branchNode ? Position.Top : Position.Left}
          id={branchNode ? "target-top" : "target-left"}
        />
      ) : null}
      <header>
        <span><Icon size={16} strokeWidth={1.8} aria-hidden="true" /></span>
        <small>{data.kicker}</small>
        <em className={`development-execution-node__state development-execution-node__state--${data.state}`}>
          <StateIcon state={data.state} />{data.state}
        </em>
      </header>
      <strong>{data.label}</strong>
      <p>{data.detail}</p>
      {data.step !== "commit" && data.step !== "rollback" && data.step !== "source" ? (
        <Handle type="source" position={Position.Right} id="source-right" />
      ) : null}
      {data.step === "review" || data.step === "apply" ? (
        <Handle type="source" position={Position.Bottom} id="source-bottom" />
      ) : null}
    </article>
  );
}
