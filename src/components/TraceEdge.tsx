import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export interface TraceEdgeData extends Record<string, unknown> {
  active: boolean;
  visited: boolean;
  kind: "causal" | "rail";
  label?: string;
  pulseKey: number;
}

export type TraceFlowEdge = Edge<TraceEdgeData, "trace">;

export function TraceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<TraceFlowEdge>) {
  const edgeData: TraceEdgeData = data ?? {
    active: false,
    visited: false,
    kind: "causal",
    pulseKey: 0,
  };
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
    offset: edgeData.kind === "rail" ? 10 : 24,
  });

  const className = [
    "trace-edge",
    "trace-edge--" + edgeData.kind,
    edgeData.active ? "trace-edge--active" : "",
    edgeData.visited ? "trace-edge--visited" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={className}
      />
      {edgeData.active && edgeData.kind === "causal" ? (
        <circle
          key={id + "-" + edgeData.pulseKey}
          className="execution-pulse"
          r="4.5"
          aria-hidden="true"
        >
          <animateMotion dur="520ms" fill="freeze" path={edgePath} />
        </circle>
      ) : null}
      {edgeData.label ? (
        <EdgeLabelRenderer>
          <span
            className={[
              "trace-edge__label",
              edgeData.active ? "trace-edge__label--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              transform:
                "translate(-50%, -50%) translate(" +
                labelX +
                "px," +
                labelY +
                "px)",
            }}
          >
            {edgeData.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
