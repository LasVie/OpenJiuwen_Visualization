import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type {
  SubagentExecution,
  SubagentExecutionStage,
  SubagentExecutionStatus,
  SubagentStageKind,
} from "./model";
import { visibleSubagentStages } from "./model";

export interface SubagentExecutionNodeData extends Record<string, unknown> {
  stage: SubagentExecutionStage;
  sequence: string;
  owner: "agent-core" | "jiuwenswarm";
}
export type SubagentExecutionFlowNode = Node<
  SubagentExecutionNodeData,
  "subagentExecution"
>;

export type SubagentExecutionFlowEdge = Edge;

function stageOwner(kind: SubagentStageKind) {
  return ["dispatch", "session", "result"].includes(kind)
    ? "jiuwenswarm" as const
    : "agent-core" as const;
}

function edgeColor(status: SubagentExecutionStatus, owner: "agent-core" | "jiuwenswarm") {
  if (status === "failed") return "#b74a4a";
  if (status === "running") return "#b76d21";
  return owner === "jiuwenswarm" ? "#7760ad" : "#5b8f9a";
}

function parentStageId(
  stage: SubagentExecutionStage,
  stages: readonly SubagentExecutionStage[],
  dispatchId: string,
  sessionId: string,
) {
  if (stage.kind === "session") return dispatchId;
  if (stage.kind === "result") {
    return [...stages]
      .filter((candidate) =>
        candidate.id !== stage.id &&
        candidate.kind !== "dispatch" &&
        candidate.kind !== "session")
      .sort((left, right) => right.lastSequence - left.lastSequence)[0]?.id ?? sessionId;
  }
  if (stage.kind === "dispatch") return undefined;
  const byParentSpan = stage.parentSpanId
    ? [...stages]
        .filter((candidate) =>
          candidate.id !== stage.id &&
          candidate.spanId === stage.parentSpanId &&
          candidate.firstSequence <= stage.firstSequence)
        .sort((left, right) => right.firstSequence - left.firstSequence)[0]
    : undefined;
  return byParentSpan?.id ?? sessionId;
}

function stageDepth(
  stageId: string,
  parentById: ReadonlyMap<string, string>,
) {
  let depth = 0;
  let cursor = stageId;
  const seen = new Set<string>();
  while (parentById.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    cursor = parentById.get(cursor)!;
    depth += 1;
  }
  return depth;
}

export function buildSubagentExecutionGraph(
  execution: SubagentExecution,
  throughSequence: number,
) {
  const stages = visibleSubagentStages(execution, throughSequence);
  const dispatch = stages.find((stage) => stage.kind === "dispatch");
  const session = stages.find((stage) => stage.kind === "session");
  if (!dispatch || !session) return { nodes: [], edges: [] };

  const parentById = new Map<string, string>();
  stages.forEach((stage) => {
    const parent = parentStageId(stage, stages, dispatch.id, session.id);
    if (parent) parentById.set(stage.id, parent);
  });
  const byDepth = new Map<number, SubagentExecutionStage[]>();
  stages.forEach((stage) => {
    const depth = stageDepth(stage.id, parentById);
    const group = byDepth.get(depth) ?? [];
    group.push(stage);
    byDepth.set(depth, group);
  });
  const maxGroupSize = Math.max(1, ...[...byDepth.values()].map((group) => group.length));
  const positionById = new Map<string, { x: number; y: number }>();
  byDepth.forEach((group, depth) => {
    group.sort((left, right) => left.firstSequence - right.firstSequence);
    const offset = (maxGroupSize - group.length) * 82;
    group.forEach((stage, index) => {
      positionById.set(stage.id, {
        x: 50 + depth * 315,
        y: 70 + offset + index * 164,
      });
    });
  });

  const nodes: SubagentExecutionFlowNode[] = stages.map((stage, index) => ({
    id: stage.id,
    type: "subagentExecution",
    position: positionById.get(stage.id) ?? { x: index * 315, y: 80 },
    data: {
      stage,
      sequence: String(index + 1).padStart(2, "0"),
      owner: stageOwner(stage.kind),
    },
    style: { width: 252 },
    ariaLabel: `${stage.kind} ${stage.label}，点击查看 Subagent 执行证据`,
  }));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const edges: SubagentExecutionFlowEdge[] = [...parentById.entries()].map(
    ([target, source], index) => {
      const targetStage = stageById.get(target)!;
      const owner = stageOwner(targetStage.kind);
      const color = edgeColor(targetStage.status, owner);
      return {
        id: `subagent-edge:${index}:${source}:${target}`,
        source,
        target,
        type: "smoothstep",
        animated: targetStage.status === "running",
        style: { stroke: color, strokeWidth: targetStage.status === "running" ? 2.5 : 1.8 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 16,
          height: 16,
        },
      };
    },
  );
  return { nodes, edges };
}
