import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { RailNodeDefinition, TraceStep } from "../../types/trace";
import type {
  RailReviewSnapshot,
  RailReviewStatus,
} from "./model";

export type RailDecisionKind =
  | "payload"
  | "hook"
  | "check"
  | "mutation"
  | "signal";

export interface RailDecisionDetail {
  label: string;
  value: string;
}

export interface RailDecisionNodeData extends Record<string, unknown> {
  sequence: string;
  phase: string;
  label: string;
  kind: RailDecisionKind;
  status: RailReviewStatus;
  summary: string;
  detailTitle: string;
  details: RailDecisionDetail[];
}

export type RailDecisionFlowNode = Node<
  RailDecisionNodeData,
  "railDecision"
>;

export type RailDecisionFlowEdge = Edge;

function edgeColor(status: RailReviewStatus) {
  if (status === "blocked") return "#b74a4a";
  if (status === "changed" || status === "reviewing") return "#b76d21";
  if (status === "passed") return "#437965";
  return "#8ca0a3";
}

function outputStatus(snapshot: RailReviewSnapshot): RailReviewStatus {
  if (!snapshot.invocation) {
    return snapshot.status === "reviewing" ? "reviewing" : "waiting";
  }
  if (snapshot.invocation.noop) return "skipped";
  return snapshot.status;
}

function decisionNode(
  id: string,
  position: { x: number; y: number },
  data: RailDecisionNodeData,
): RailDecisionFlowNode {
  return {
    id,
    type: "railDecision",
    position,
    data,
    ariaLabel: `${data.sequence} ${data.label}，点击查看判定详情`,
  };
}

export function buildRailDecisionGraph(
  definition: RailNodeDefinition,
  step: TraceStep,
  snapshot: RailReviewSnapshot,
) {
  const invocation = snapshot.invocation;
  const mutation = invocation?.mutationDiff ?? "尚未产生 mutation";
  const signal = invocation?.controlSignal ?? "尚未发布 control signal";
  const hookSummary = invocation
    ? `${invocation.event} · p${invocation.priority} · ${invocation.namespace}`
    : definition.hooks.map((hook) => hook.event).join(" / ");
  const resultStatus = outputStatus(snapshot);

  const nodes: RailDecisionFlowNode[] = [
    decisionNode("read-payload", { x: 0, y: 210 }, {
      sequence: "01",
      phase: "READ",
      label: snapshot.profile.targetLabel,
      kind: "payload",
      status: snapshot.status === "waiting" ? "waiting" : "passed",
      summary: snapshot.payload,
      detailTitle: "Rail 收到的完整审查载荷",
      details: [
        { label: "字段路径", value: snapshot.profile.targetPath },
        { label: "运行步骤", value: step.eventCode },
        { label: "完整载荷", value: snapshot.payload },
      ],
    }),
    decisionNode("dispatch-hook", { x: 320, y: 210 }, {
      sequence: "02",
      phase: "DISPATCH",
      label: invocation?.event ?? "等待 Hook",
      kind: "hook",
      status: snapshot.status === "waiting" ? "waiting" : "passed",
      summary: hookSummary,
      detailTitle: "Hook 分发与执行边界",
      details: invocation
        ? [
            { label: "Rail 实例", value: invocation.rail },
            { label: "Hook 事件", value: invocation.event },
            { label: "优先级", value: `p${invocation.priority}` },
            { label: "命名空间", value: invocation.namespace },
            { label: "耗时", value: `${invocation.durationMs} ms` },
          ]
        : [
            { label: "状态", value: "当前调用帧尚无 Hook 结果" },
            {
              label: "已注册 Hook",
              value: definition.hooks
                .map((hook) => `${hook.event} · p${hook.priority}`)
                .join("\n"),
            },
          ],
    }),
    ...snapshot.checks.map((check, index) =>
      decisionNode(`check-${check.id}`, { x: 650, y: 20 + index * 190 }, {
        sequence: `0${index + 3}`,
        phase: "CHECK",
        label: check.label,
        kind: "check",
        status: check.status,
        summary: check.description,
        detailTitle: `${check.label} · 判定依据`,
        details: [
          { label: "规则标识", value: check.id },
          { label: "检查内容", value: check.description },
          { label: "轨迹证据", value: step.summary },
          { label: "当前结论", value: check.status.toUpperCase() },
        ],
      }),
    ),
    decisionNode("apply-mutation", { x: 990, y: 210 }, {
      sequence: "06",
      phase: "APPLY",
      label: "Mutation",
      kind: "mutation",
      status: resultStatus,
      summary: mutation,
      detailTitle: "Rail 对运行态的变更",
      details: [
        { label: "变更差异", value: mutation },
        { label: "No-op", value: invocation?.noop ? "是" : "否" },
        { label: "步骤 token Δ", value: `${step.tokenDelta}` },
      ],
    }),
    decisionNode("emit-signal", { x: 1310, y: 210 }, {
      sequence: "07",
      phase: "EMIT",
      label: "Control signal",
      kind: "signal",
      status: resultStatus,
      summary: signal,
      detailTitle: "Rail 发布的控制结果",
      details: [
        { label: "控制信号", value: signal },
        { label: "最终状态", value: snapshot.status.toUpperCase() },
        { label: "运行结果", value: snapshot.outcome },
      ],
    }),
  ];

  const edgeDefinitions = [
    ["read-payload", "dispatch-hook"],
    ...snapshot.checks.map((check) => ["dispatch-hook", `check-${check.id}`]),
    ...snapshot.checks.map((check) => [`check-${check.id}`, "apply-mutation"]),
    ["apply-mutation", "emit-signal"],
  ];
  const color = edgeColor(snapshot.status);
  const edges: RailDecisionFlowEdge[] = edgeDefinitions.map(
    ([source, target], index) => ({
      id: `rail-decision-edge-${index}`,
      source,
      target,
      type: "smoothstep",
      style: { stroke: color, strokeWidth: 1.8 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 16,
        height: 16,
      },
    }),
  );

  return { nodes, edges };
}

