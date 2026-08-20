import { useEffect, useMemo, useRef } from "react";
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
import {
  DevelopmentNode,
  type DevelopmentFlowNode,
  type DevelopmentNodeData,
} from "./DevelopmentNode";
import type {
  DevelopmentAnalysisProjection,
  DevelopmentSelection,
  DevelopmentStageKind,
} from "./model";

const nodeTypes = { development: DevelopmentNode } satisfies NodeTypes;
const MAIN_GAP = 300;
const MAIN_ROW_GAP = 176;
const CHILD_GAP = 146;
const CHILD_COLUMNS = 4;
const CHILD_COLUMN_GAP = 258;

const stageColor: Readonly<Record<DevelopmentStageKind, string>> = {
  intent: "#2e6570",
  scope: "#52796f",
  evidence: "#16747b",
  diagnosis: "#a36b2a",
  impact: "#6b56a6",
  "change-plan": "#477d63",
  "test-plan": "#496d9c",
  "patch-outline": "#9a5d38",
  boundary: "#66757a",
};

function mainEdge(source: string, target: string, index: number, activeIndex: number): Edge {
  const visited = index <= activeIndex;
  const active = index === activeIndex;
  const color = active ? "#0f7b82" : visited ? "#6f9290" : "#bdc9c7";
  return {
    id: `development-main:${source}:${target}`,
    source,
    target,
    sourceHandle: "source-right",
    targetHandle: "target-left",
    type: "smoothstep",
    label: active ? "CURRENT" : undefined,
    animated: active,
    style: { stroke: color, strokeWidth: active ? 2.8 : visited ? 2 : 1.4 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
  };
}

function branchEdge(
  stageId: string,
  childId: string,
  color: string,
  focused: boolean,
): Edge {
  return {
    id: `development-branch:${stageId}:${childId}`,
    source: stageId,
    target: childId,
    sourceHandle: focused ? "source-right" : "source-bottom",
    targetHandle: focused ? "target-left" : "target-top",
    type: "smoothstep",
    style: { stroke: color, strokeWidth: 1.5, strokeDasharray: "6 5" },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
  };
}

function selectionId(selection: DevelopmentSelection | null) {
  return selection ? `${selection.kind}:${selection.id}` : "";
}

function buildFlow(
  projection: DevelopmentAnalysisProjection,
  activeIndex: number,
  expanded: ReadonlySet<DevelopmentStageKind>,
  selection: DevelopmentSelection | null,
  onToggle: (kind: DevelopmentStageKind) => void,
  previous: readonly DevelopmentFlowNode[] = [],
) {
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const records: DevelopmentFlowNode[] = [];
  const edges: Edge[] = [];
  const selected = selectionId(selection);
  const stageByKind = new Map(projection.stages.map((stage) => [stage.kind, stage]));
  const focusedKind = expanded.size === 1 ? [...expanded][0] : undefined;
  const itemCounts: Partial<Record<DevelopmentStageKind, number>> = {
    evidence: projection.evidence.length,
    impact: projection.impacts.length,
    "change-plan": projection.changes.length,
    "test-plan": projection.tests.length,
    "patch-outline": projection.patchOutlines.length,
  };
  let branchLaneY = 560;
  const statusFor = (index: number) => index === activeIndex
    ? "active" as const
    : index < activeIndex
      ? "visited" as const
      : "future" as const;
  const expandable = new Set<DevelopmentStageKind>([
    "evidence", "impact", "change-plan", "test-plan", "patch-outline",
  ]);

  projection.stages.forEach((stage, index) => {
    if (focusedKind && stage.kind !== focusedKind) return;
    const id = stage.id;
    const data: DevelopmentNodeData = {
      variant: "stage",
      label: stage.label,
      summary: stage.summary,
      status: statusFor(index),
      owner: projection.repository.owner,
      stage,
      expandable: expandable.has(stage.kind),
      expanded: expanded.has(stage.kind),
      onToggle: () => onToggle(stage.kind),
      meta: stage.kind === "scope"
        ? [projection.repository.branch, projection.repository.dirty ? "DIRTY" : "CLEAN"]
        : stage.kind === "boundary"
          ? ["READ ONLY", "NO MODEL", "NO WRITE"]
          : [],
    };
    const row = Math.floor(index / 3);
    const offset = index % 3;
    const column = row % 2 === 0 ? offset : 2 - offset;
    const focusedColumns = (itemCounts[stage.kind] ?? 0) > 6 ? 3 : 2;
    const focusedRows = Math.ceil((itemCounts[stage.kind] ?? 0) / focusedColumns);
    records.push({
      id,
      type: "development",
      position: previousPositions.get(id) ?? (focusedKind
        ? { x: 0, y: Math.max(0, (focusedRows - 1) * CHILD_GAP / 2) }
        : { x: column * MAIN_GAP, y: row * MAIN_ROW_GAP }),
      selected: selected === `stage:${stage.id}`,
      data,
      ariaLabel: `${stage.ordinal} ${stage.label}，${stage.summary}`,
    });
    if (!focusedKind && index > 0) {
      edges.push(mainEdge(projection.stages[index - 1].id, id, index, activeIndex));
    }
  });

  const addChildren = <T extends { id: string }>(
    kind: DevelopmentStageKind,
    variant: DevelopmentNodeData["variant"],
    items: readonly T[],
    label: (item: T) => string,
    summary: (item: T) => string,
    meta: (item: T) => readonly string[],
    selectionKind: DevelopmentSelection["kind"],
  ) => {
    if (!expanded.has(kind)) return;
    const stage = stageByKind.get(kind);
    if (!stage) return;
    const stageIndex = projection.stages.findIndex((candidate) => candidate.kind === kind);
    const focused = focusedKind === kind;
    const columns = focused ? (items.length > 6 ? 3 : 2) : CHILD_COLUMNS;
    const laneStart = focused ? 0 : branchLaneY;
    items.forEach((item, index) => {
      const id = `development-child:${selectionKind}:${item.id}`;
      records.push({
        id,
        type: "development",
        position: previousPositions.get(id) ?? {
          x: focused
            ? MAIN_GAP + (index % columns) * CHILD_COLUMN_GAP
            : (index % columns) * CHILD_COLUMN_GAP,
          y: laneStart + Math.floor(index / columns) * CHILD_GAP,
        },
        selected: selected === `${selectionKind}:${item.id}`,
        data: {
          variant,
          label: label(item),
          summary: summary(item),
          status: statusFor(stageIndex),
          owner: projection.repository.owner,
          entity: item as unknown as DevelopmentNodeData["entity"],
          meta: meta(item),
          groupKind: kind,
        },
        ariaLabel: `${label(item)}，${variant} 详情节点`,
      });
      edges.push(branchEdge(stage.id, id, stageColor[kind], focused));
    });
    if (!focused) {
      branchLaneY += Math.max(1, Math.ceil(items.length / columns)) * CHILD_GAP + 64;
    }
  };

  addChildren("evidence", "evidence", projection.evidence,
    (item) => item.node.label,
    (item) => item.source.path,
    (item) => [item.node.kind, item.confidence.toUpperCase()],
    "evidence");
  addChildren("impact", "impact", projection.impacts,
    (item) => item.node.label,
    (item) => item.reason,
    (item) => [item.relationship, item.direction],
    "impact");
  addChildren("change-plan", "change", projection.changes,
    (item) => item.title,
    (item) => item.detail,
    (item) => [`${item.risk.toUpperCase()} RISK`, item.target.source.path],
    "change");
  addChildren("test-plan", "test", projection.tests,
    (item) => item.title,
    (item) => item.detail,
    (item) => [item.kind.toUpperCase(), item.evidenceLabel],
    "test");
  addChildren("patch-outline", "patch", projection.patchOutlines,
    (item) => item.title,
    () => "只读结构草案，不是可应用 patch。",
    (item) => [item.basis.toUpperCase(), "NOT APPLICABLE"],
    "patch");

  return { nodes: records, edges };
}

function nodeSelection(node: DevelopmentFlowNode): DevelopmentSelection | null {
  if (node.data.stage) return { kind: "stage", id: node.data.stage.id };
  const entity = node.data.entity;
  if (!entity) return null;
  if (node.data.variant === "evidence") return { kind: "evidence", id: entity.id };
  if (node.data.variant === "impact") return { kind: "impact", id: entity.id };
  if (node.data.variant === "change") return { kind: "change", id: entity.id };
  if (node.data.variant === "test") return { kind: "test", id: entity.id };
  if (node.data.variant === "patch") return { kind: "patch", id: entity.id };
  return null;
}

interface DevelopmentCanvasProps {
  projection: DevelopmentAnalysisProjection;
  activeIndex: number;
  expanded: ReadonlySet<DevelopmentStageKind>;
  selection: DevelopmentSelection | null;
  onSelect: (selection: DevelopmentSelection | null) => void;
  onToggle: (kind: DevelopmentStageKind) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

export function DevelopmentCanvas({
  projection,
  activeIndex,
  expanded,
  selection,
  onSelect,
  onToggle,
  magnetEnabled,
  magnetStrength,
}: DevelopmentCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<DevelopmentFlowNode, Edge> | null>(null);
  const layoutKey = `${projection.repository.id}:${projection.repository.revision}:${projection.intent}`;
  const layoutMode = expanded.size === 1
    ? `focus:${[...expanded][0]}`
    : expanded.size > 1
      ? "expanded"
      : "macro";
  const positionLayoutKey = `${layoutKey}:${layoutMode}`;
  const fitKey = `${layoutKey}:${[...expanded].sort().join(",")}`;
  const previousLayoutKey = useRef(positionLayoutKey);
  const initial = buildFlow(projection, activeIndex, expanded, selection, onToggle);
  const [nodes, setNodes, onNodesChange] = useNodesState<DevelopmentFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);
  const fitViewOptions = useMemo(() => ({ padding: 0.18, minZoom: 0.2, maxZoom: 1.05 }), []);
  const nodeStructureKey = nodes.map((node) => node.id).join("|");

  useEffect(() => {
    const preserve = previousLayoutKey.current === positionLayoutKey;
    const next = buildFlow(
      projection,
      activeIndex,
      expanded,
      selection,
      onToggle,
      preserve ? nodes : [],
    );
    setNodes(next.nodes);
    setEdges(next.edges);
    previousLayoutKey.current = positionLayoutKey;
  }, [activeIndex, expanded, onToggle, positionLayoutKey, projection, selection, setEdges, setNodes]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let frame = 0;
    let measuredFrame = 0;
    const fit = () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(measuredFrame);
      frame = window.requestAnimationFrame(() => {
        measuredFrame = window.requestAnimationFrame(() => {
          const instance = instanceRef.current;
          if (!instance) return;
          const expandedKinds = [...expanded];
          const allNodes = instance.getNodes();
          const focusNodes = expandedKinds.length === 1
            ? allNodes.filter((node) =>
                node.data.stage?.kind === expandedKinds[0] ||
                node.data.groupKind === expandedKinds[0])
            : expandedKinds.length === 0
              ? allNodes.filter((node) => Boolean(node.data.stage))
              : allNodes;
          void instance.fitView({ ...fitViewOptions, nodes: focusNodes });
        });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(measuredFrame);
    };
  }, [expanded, fitKey, fitViewOptions, nodeStructureKey]);

  return (
    <div ref={elementRef} className="development-canvas" aria-label="只读开发辅助证据链">
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => onNodesChange(changes.filter((change) => change.type !== "remove"))}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelect(nodeSelection(node))}
        onPaneClick={() => onSelect(null)}
        onNodeDrag={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => repelNodeCollisions(
            current.map((candidate) => candidate.id === node.id
              ? { ...candidate, position: node.position }
              : candidate),
            node.id,
            { gap: profile.gap },
          ));
        }}
        onNodeDragStop={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => magnetizeNode(
            repelNodeCollisions(
              current.map((candidate) => candidate.id === node.id
                ? { ...candidate, position: node.position }
                : candidate),
              node.id,
              { gap: profile.gap },
            ),
            node.id,
            profile,
          ));
        }}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.16}
        maxZoom={1.8}
        fitView
        fitViewOptions={fitViewOptions}
        onInit={(instance) => {
          instanceRef.current = instance;
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => void instance.fitView(fitViewOptions));
          });
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d4dfdd" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} position="bottom-left" aria-label="开发辅助画布缩放控制" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as DevelopmentNodeData;
            if (data.stage) return stageColor[data.stage.kind];
            if (data.variant === "impact") return stageColor.impact;
            if (data.variant === "change") return stageColor["change-plan"];
            if (data.variant === "test") return stageColor["test-plan"];
            if (data.variant === "patch") return stageColor["patch-outline"];
            return stageColor.evidence;
          }}
          maskColor="rgba(238, 243, 242, 0.72)"
          style={{ width: 126, height: 82 }}
        />
        <Panel position="top-left" className="development-canvas__legend">
          <span><i className="development-legend--evidence" />证据</span>
          <span><i className="development-legend--impact" />影响</span>
          <span><i className="development-legend--plan" />建议</span>
          <span><i className="development-legend--test" />测试</span>
          <span><i className="development-legend--patch" />草案</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
