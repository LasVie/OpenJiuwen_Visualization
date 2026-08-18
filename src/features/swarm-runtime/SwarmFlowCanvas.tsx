import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../trace-graph";
import type { TraceViewMode } from "../../kernel";
import {
  swarmSubjectIsContainer,
  swarmSubjectStatusAt,
  type SwarmRuntimeProjection,
  type SwarmRuntimeRelation,
  type SwarmRuntimeSubject,
} from "./model";
import {
  SwarmRuntimeNode,
  type SwarmRuntimeFlowNode,
} from "./SwarmRuntimeNode";

const nodeTypes = {
  swarmSubject: SwarmRuntimeNode,
} satisfies NodeTypes;

interface SwarmFlowCanvasProps {
  projection: SwarmRuntimeProjection;
  stepIndex: number;
  selectedNodeId: string | null;
  viewMode: TraceViewMode;
  activeContextOwnerId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onActivateContext: (contextOwnerId: string) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

interface SwarmEdgeData extends Record<string, unknown> {
  relation: SwarmRuntimeRelation;
  active: boolean;
}

type SwarmFlowEdge = Edge<SwarmEdgeData>;

const KIND_ORDER: Record<SwarmRuntimeSubject["kind"], number> = {
  team: 0,
  workflow: 1,
  member: 2,
  phase: 3,
  task: 4,
  agent: 5,
  human: 6,
  subagent: 7,
};

function subjectDepth(
  subject: SwarmRuntimeSubject,
  byId: ReadonlyMap<string, SwarmRuntimeSubject>,
) {
  let depth = 0;
  let current = subject;
  const seen = new Set([subject.id]);
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

function activePathIds(
  projection: SwarmRuntimeProjection,
  stepIndex: number,
) {
  const active = new Set(
    projection.scenario.steps[stepIndex]?.activeNodeIds ?? [],
  );
  const byId = new Map(projection.subjects.map((subject) => [subject.id, subject]));
  [...active].forEach((id) => {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      active.add(current.parentId);
      current = byId.get(current.parentId);
    }
  });
  return active;
}

function visibleSubjects(
  projection: SwarmRuntimeProjection,
  stepIndex: number,
  viewMode: TraceViewMode,
  expandedIds: ReadonlySet<string>,
) {
  const introduced = projection.subjects.filter(
    (subject) => subject.firstStep <= stepIndex,
  );
  if (viewMode === "micro") return introduced;

  const byId = new Map(introduced.map((subject) => [subject.id, subject]));
  const activePath = activePathIds(projection, stepIndex);
  return introduced.filter((subject) => {
    const depth = subjectDepth(subject, byId);
    if (depth <= 1 || activePath.has(subject.id)) return true;

    let parent = subject.parentId ? byId.get(subject.parentId) : undefined;
    while (parent && subjectDepth(parent, byId) >= 1) {
      if (!expandedIds.has(parent.id)) return false;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return true;
  });
}

function defaultPositions(subjects: readonly SwarmRuntimeSubject[]) {
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const byDepth = new Map<number, SwarmRuntimeSubject[]>();
  subjects.forEach((subject) => {
    const depth = subjectDepth(subject, byId);
    const group = byDepth.get(depth) ?? [];
    group.push(subject);
    byDepth.set(depth, group);
  });
  const maxGroupSize = Math.max(1, ...[...byDepth.values()].map((group) => group.length));
  const positions = new Map<string, { x: number; y: number }>();
  byDepth.forEach((group, depth) => {
    group.sort((left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.firstStep - right.firstStep ||
      left.label.localeCompare(right.label));
    const offset = (maxGroupSize - group.length) * 70;
    group.forEach((subject, index) => {
      positions.set(subject.id, {
        x: 40 + depth * 305,
        y: 55 + offset + index * 140,
      });
    });
  });
  return positions;
}

function buildNodes(
  projection: SwarmRuntimeProjection,
  stepIndex: number,
  selectedNodeId: string | null,
  viewMode: TraceViewMode,
  expandedIds: ReadonlySet<string>,
  activeContextOwnerId: string | null,
  previous: readonly SwarmRuntimeFlowNode[] = [],
): SwarmRuntimeFlowNode[] {
  const visible = visibleSubjects(projection, stepIndex, viewMode, expandedIds);
  const visibleIds = new Set(visible.map((subject) => subject.id));
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const defaults = defaultPositions(visible);
  const activeIds = new Set(
    projection.scenario.steps[stepIndex]?.activeNodeIds ?? [],
  );
  const childCount = new Map<string, number>();
  projection.subjects.forEach((subject) => {
    if (!subject.parentId || subject.firstStep > stepIndex) return;
    childCount.set(subject.parentId, (childCount.get(subject.parentId) ?? 0) + 1);
  });

  return visible.map((subject) => ({
    id: subject.id,
    type: "swarmSubject",
    position: previousPositions.get(subject.id) ?? defaults.get(subject.id) ?? { x: 0, y: 0 },
    selected: selectedNodeId === subject.id,
    data: {
      subject,
      status: swarmSubjectStatusAt(subject, stepIndex),
      active: activeIds.has(subject.id),
      expandable: swarmSubjectIsContainer(subject.kind) && (childCount.get(subject.id) ?? 0) > 0,
      expanded: viewMode === "micro" || expandedIds.has(subject.id),
      contextActive:
        Boolean(activeContextOwnerId) &&
        (subject.contextOwnerId === activeContextOwnerId ||
          subject.id === activeContextOwnerId),
      childCount: childCount.get(subject.id) ?? 0,
      eventCode: activeIds.has(subject.id)
        ? projection.scenario.steps[stepIndex]?.eventCode
        : undefined,
    },
    style: { width: 252 },
    zIndex: activeIds.has(subject.id) ? 5 : visibleIds.has(subject.id) ? 2 : 1,
    ariaLabel: `${subject.kind} ${subject.label}，点击查看详情${subject.contextOwnerId ? "与独立 Context" : ""}`,
  }));
}

function relationColor(relation: SwarmRuntimeRelation, active: boolean) {
  if (active) return relation.kind === "assignment" ? "#b76d21" : "#6b56a6";
  if (relation.kind === "message") return "#6a8eaa";
  if (relation.kind === "assignment") return "#b99a72";
  return "#a9a0c3";
}

function buildEdges(
  projection: SwarmRuntimeProjection,
  stepIndex: number,
  visibleNodeIds: ReadonlySet<string>,
): SwarmFlowEdge[] {
  const activeIds = new Set(
    projection.scenario.steps[stepIndex]?.activeEdgeIds ?? [],
  );
  return projection.relations
    .filter((relation) =>
      relation.firstStep <= stepIndex &&
      visibleNodeIds.has(relation.source) &&
      visibleNodeIds.has(relation.target))
    .map((relation) => {
      const active = activeIds.has(relation.id);
      const color = relationColor(relation, active);
      const label = relation.kind === "message"
        ? `${relation.label ?? "message"}${relation.count > 1 ? ` ×${relation.count}` : ""}`
        : relation.kind === "assignment"
          ? relation.label
          : undefined;
      return {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        sourceHandle: "swarm-source",
        targetHandle: "swarm-target",
        type: "smoothstep",
        animated: active,
        label,
        data: { relation, active },
        zIndex: active ? 4 : relation.kind === "hierarchy" ? 0 : 2,
        style: {
          stroke: color,
          strokeWidth: active ? 2.6 : relation.kind === "hierarchy" ? 1.5 : 2,
          strokeDasharray: relation.kind === "message" ? "5 5" : undefined,
        },
        labelStyle: {
          fill: active ? "#42336f" : "#536a72",
          fontSize: 10,
          fontWeight: 700,
        },
        labelBgStyle: { fill: "#f8faf9", fillOpacity: 0.92 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 5,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 15,
          height: 15,
        },
      };
    });
}

function settleNodeCollisions(
  nodes: SwarmRuntimeFlowNode[],
  anchorIds: readonly string[],
  gap: number,
) {
  return anchorIds.reduce(
    (settled, nodeId) => repelNodeCollisions(settled, nodeId, {
      gap,
      maxRings: 16,
    }),
    nodes,
  );
}

export function SwarmFlowCanvas({
  projection,
  stepIndex,
  selectedNodeId,
  viewMode,
  activeContextOwnerId,
  onSelectNode,
  onActivateContext,
  magnetEnabled,
  magnetStrength,
}: SwarmFlowCanvasProps) {
  const canvasElementRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<
    ReactFlowInstance<SwarmRuntimeFlowNode, SwarmFlowEdge> | null
  >(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () => visibleSubjects(projection, stepIndex, viewMode, expandedIds),
    [expandedIds, projection, stepIndex, viewMode],
  );
  const visibleIds = useMemo(
    () => new Set(visible.map((subject) => subject.id)),
    [visible],
  );
  const visibleKey = [...visibleIds].sort().join("|");
  const layoutKey = `${projection.trace?.id ?? "pending"}:${viewMode}:${[...expandedIds].sort().join("|")}`;
  const previousLayoutKey = useRef(layoutKey);
  const previousVisibleKey = useRef(visibleKey);
  const [nodes, setNodes, onNodesChange] = useNodesState<SwarmRuntimeFlowNode>(
    buildNodes(
      projection,
      stepIndex,
      selectedNodeId,
      viewMode,
      expandedIds,
      activeContextOwnerId,
    ),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<SwarmFlowEdge>(
    buildEdges(projection, stepIndex, visibleIds),
  );
  const magnetProfile = useMemo(
    () => magneticProfile(magnetStrength),
    [magnetStrength],
  );

  useEffect(() => {
    setExpandedIds(new Set());
  }, [projection.trace?.id]);

  useEffect(() => {
    const preservePositions = previousLayoutKey.current === layoutKey;
    const topologyChanged = previousVisibleKey.current !== visibleKey;
    setNodes((current) => {
      const currentIds = new Set(current.map((node) => node.id));
      const built = buildNodes(
        projection,
        stepIndex,
        selectedNodeId,
        viewMode,
        expandedIds,
        activeContextOwnerId,
        preservePositions ? current : [],
      );
      const newNodeIds = built
        .filter((node) => !currentIds.has(node.id))
        .map((node) => node.id);
      return topologyChanged
        ? settleNodeCollisions(built, newNodeIds, magnetProfile.gap)
        : built;
    });
    setEdges(buildEdges(projection, stepIndex, visibleIds));
    previousLayoutKey.current = layoutKey;
    previousVisibleKey.current = visibleKey;
  }, [
    activeContextOwnerId,
    expandedIds,
    layoutKey,
    magnetProfile.gap,
    projection,
    selectedNodeId,
    setEdges,
    setNodes,
    stepIndex,
    viewMode,
    visibleIds,
    visibleKey,
  ]);

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;
    let animationFrame = 0;
    const fit = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        void flowInstanceRef.current?.fitView({
          padding: 0.16,
          minZoom: 0.2,
          maxZoom: 1,
        });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [layoutKey, visibleKey]);

  return (
    <div
      ref={canvasElementRef}
      className="flow-canvas swarm-runtime-canvas"
      aria-label="JiuwenSwarm 运行时层级图"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          const subject = projection.subjects.find((candidate) => candidate.id === node.id);
          onSelectNode(node.id);
          if (subject?.contextOwnerId) onActivateContext(subject.contextOwnerId);
          if (
            viewMode === "macro" &&
            subject &&
            swarmSubjectIsContainer(subject.kind)
          ) {
            setExpandedIds((current) => {
              const next = new Set(current);
              if (next.has(subject.id)) next.delete(subject.id);
              else next.add(subject.id);
              return next;
            });
          }
        }}
        onNodeDrag={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => repelNodeCollisions(
            current.map((candidate) => candidate.id === node.id
              ? { ...candidate, position: node.position }
              : candidate),
            node.id,
            { gap: magnetProfile.gap },
          ));
        }}
        onNodeDragStop={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => {
            const withDragged = current.map((candidate) => candidate.id === node.id
              ? { ...candidate, position: node.position }
              : candidate);
            return magnetizeNode(
              repelNodeCollisions(withDragged, node.id, { gap: magnetProfile.gap }),
              node.id,
              magnetProfile,
            );
          });
        }}
        onPaneClick={() => onSelectNode(null)}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.16, minZoom: 0.2, maxZoom: 1 }}
        onInit={(instance) => {
          flowInstanceRef.current = instance;
          window.requestAnimationFrame(() => {
            void instance.fitView({ padding: 0.16, minZoom: 0.2, maxZoom: 1 });
          });
        }}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="#c9c2dc"
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          aria-label="Swarm 画布缩放控制"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(node) => {
            const subject = (node.data as { subject?: SwarmRuntimeSubject }).subject;
            if (subject?.kind === "team") return "#6b56a6";
            if (subject?.kind === "workflow" || subject?.kind === "phase") return "#8a72c6";
            if (subject?.kind === "task") return "#b78a55";
            return "#a99bd1";
          }}
          maskColor="rgba(242, 241, 248, 0.72)"
          aria-label="Swarm 链路缩略图"
        />
        <Panel position="top-left" className="canvas-legend swarm-runtime-legend">
          <span><i className="legend-dot legend-dot--active" />当前主体</span>
          <span><i className="swarm-legend-line swarm-legend-line--hierarchy" />层级</span>
          <span><i className="swarm-legend-line swarm-legend-line--message" />消息</span>
          <span><i className="swarm-legend-line swarm-legend-line--assignment" />任务分配</span>
        </Panel>
        {nodes.length === 0 ? (
          <Panel position="top-center" className="swarm-runtime-empty">
            等待带 subject 的 Swarm Runtime 事件
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}
