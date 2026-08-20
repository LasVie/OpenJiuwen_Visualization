import { MarkerType, type Edge } from "@xyflow/react";
import type {
  DevelopmentExecution,
  DevelopmentExecutionStatus,
} from "../../adapters/development-execution";
import type { DevelopmentExecutionFlowNode } from "./DevelopmentExecutionNode";

export type DevelopmentExecutionStep =
  | "review"
  | "apply"
  | "test"
  | "commit"
  | "rollback"
  | "source";

export type DevelopmentExecutionNodeState =
  | "waiting"
  | "active"
  | "success"
  | "error"
  | "available"
  | "skipped"
  | "protected";

function reachedApply(execution: DevelopmentExecution) {
  return Boolean(execution.appliedDiffSha256) || [
    "applied", "testing", "tested", "test_failed", "committing", "committed",
  ].includes(execution.status);
}

function stepState(
  execution: DevelopmentExecution,
  step: DevelopmentExecutionStep,
): DevelopmentExecutionNodeState {
  const status = execution.status;
  if (step === "source") return "protected";
  if (step === "review") return "success";
  if (step === "rollback") {
    if (status === "rolled_back") return "success";
    return execution.policy.rollbackAvailable ? "available" : "waiting";
  }
  if (step === "apply") {
    if (status === "applying") return "active";
    if (status === "failed" && !execution.appliedDiffSha256) return "error";
    if (reachedApply(execution) || status === "rolled_back") return "success";
    return "waiting";
  }
  if (step === "test") {
    if (!execution.testProfiles.length) return "skipped";
    if (status === "testing") return "active";
    if (execution.lastTest?.status === "passed") return "success";
    if (execution.lastTest || status === "test_failed") return "error";
    return "waiting";
  }
  if (status === "committing") return "active";
  if (execution.commitSha || status === "committed") return "success";
  if (status === "failed" && reachedApply(execution)) return "error";
  return "waiting";
}

function detail(execution: DevelopmentExecution, step: DevelopmentExecutionStep) {
  if (step === "review") {
    return `${execution.statistics.files} files · +${execution.statistics.additions} / -${execution.statistics.deletions}`;
  }
  if (step === "apply") {
    return reachedApply(execution) ? "isolated patch staged" : "single approval required";
  }
  if (step === "test") {
    if (!execution.testProfiles.length) return "no fixed profile detected";
    if (execution.lastTest) return `${execution.lastTest.status} · ${execution.lastTest.durationMs} ms`;
    return `${execution.testProfiles.length} allowlisted profile${execution.testProfiles.length > 1 ? "s" : ""}`;
  }
  if (step === "commit") {
    return execution.commitSha ? execution.commitSha.slice(0, 12) : "local branch only · no push";
  }
  if (step === "rollback") {
    return execution.status === "rolled_back" ? "generated state removed" : "exact branch/worktree only";
  }
  return "source checkout unchanged";
}

const positions: Record<DevelopmentExecutionStep, { x: number; y: number }> = {
  review: { x: 0, y: 0 },
  apply: { x: 252, y: 0 },
  test: { x: 504, y: 0 },
  commit: { x: 756, y: 0 },
  source: { x: 0, y: 174 },
  rollback: { x: 504, y: 174 },
};

const labels: Record<DevelopmentExecutionStep, { kicker: string; label: string }> = {
  review: { kicker: "01 · READ ONLY", label: "审查完整 Diff" },
  apply: { kicker: "02 · WRITE", label: "隔离应用" },
  test: { kicker: "03 · EXECUTE", label: "白名单测试" },
  commit: { kicker: "04 · GIT", label: "本地分支提交" },
  source: { kicker: "INVARIANT", label: "Source checkout" },
  rollback: { kicker: "RECOVERY", label: "精确回滚" },
};

function edge(
  id: string,
  source: DevelopmentExecutionStep,
  target: DevelopmentExecutionStep,
  options: { branch?: boolean; active?: boolean } = {},
): Edge {
  const color = options.branch ? "#b46a62" : options.active ? "#b0792f" : "#829894";
  return {
    id,
    source: `execution:${source}`,
    target: `execution:${target}`,
    sourceHandle: options.branch ? "source-bottom" : "source-right",
    targetHandle: options.branch ? "target-top" : "target-left",
    type: "smoothstep",
    animated: options.active,
    style: {
      stroke: color,
      strokeWidth: options.active ? 2.5 : 1.6,
      strokeDasharray: options.branch ? "6 5" : undefined,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
  };
}

export function projectDevelopmentExecutionFlow(
  execution: DevelopmentExecution,
  selectedStep: DevelopmentExecutionStep,
) {
  const steps: DevelopmentExecutionStep[] = [
    "review", "apply", "test", "commit", "source", "rollback",
  ];
  const nodes: DevelopmentExecutionFlowNode[] = steps.map((step) => ({
    id: `execution:${step}`,
    type: "development-execution",
    position: positions[step],
    selected: selectedStep === step,
    data: {
      step,
      kicker: labels[step].kicker,
      label: labels[step].label,
      detail: detail(execution, step),
      state: stepState(execution, step),
      status: execution.status,
    },
    ariaLabel: `${labels[step].label}，${detail(execution, step)}`,
  }));
  const active: DevelopmentExecutionStatus[] = ["applying", "testing", "committing"];
  const edges: Edge[] = [
    edge("execution:review:apply", "review", "apply", { active: execution.status === "applying" }),
    edge("execution:apply:test", "apply", "test", { active: execution.status === "testing" }),
    edge("execution:test:commit", "test", "commit", { active: execution.status === "committing" }),
    edge("execution:review:source", "review", "source", { branch: true }),
    edge("execution:apply:rollback", "apply", "rollback", {
      branch: true,
      active: execution.status === "rolled_back",
    }),
  ];
  return {
    nodes,
    edges,
    active: active.includes(execution.status),
  };
}
