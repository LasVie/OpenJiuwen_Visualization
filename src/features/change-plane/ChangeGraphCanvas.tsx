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
import type { ChangeImpactProjection, FileImpactProjection } from "./model";
import {
  ChangeNode,
  type ChangeFlowNode,
  type ChangeNodeData,
} from "./ChangeNode";

const nodeTypes = { change: ChangeNode } satisfies NodeTypes;

function impactPriority(impact: FileImpactProjection["direct"][number]) {
  return { direct: 0, file: 1, container: 2, dependent: 3 }[impact.kind];
}

function buildFlow(
  projection: ChangeImpactProjection,
  activeFileId: string,
  selectedNodeId: string | null,
  previous: readonly ChangeFlowNode[] = [],
) {
  const fileProjection = projection.files.find((item) => item.file.id === activeFileId)
    ?? projection.files[0];
  if (!fileProjection) return { nodes: [], edges: [] };
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const primary = [
    ...fileProjection.direct,
    ...fileProjection.fileLevel,
    ...fileProjection.containers,
  ]
    .filter((impact, index, values) =>
      projection.nodesById.get(impact.nodeId)?.kind !== "repository" &&
      values.findIndex((candidate) => candidate.nodeId === impact.nodeId) === index)
    .sort((left, right) =>
      impactPriority(left) - impactPriority(right) ||
      (projection.nodesById.get(left.nodeId)?.label ?? "").localeCompare(
        projection.nodesById.get(right.nodeId)?.label ?? "",
      ))
    .slice(0, 12);
  const dependents = fileProjection.dependents
    .filter((impact, index, values) =>
      values.findIndex((candidate) => candidate.nodeId === impact.nodeId) === index)
    .slice(0, 10);
  const rowGap = 138;
  const maxRows = Math.max(1, primary.length, dependents.length);
  const centerY = ((maxRows - 1) * rowGap) / 2;
  const records: Array<{
    id: string;
    position: { x: number; y: number };
    data: ChangeNodeData;
    selected?: boolean;
  }> = [
    {
      id: "change-set-root",
      position: { x: 0, y: centerY },
      data: {
        variant: "root",
        label: projection.changes.repository.name,
        subtitle: projection.changes.comparison.mode === "working-tree"
          ? "HEAD → WORKTREE"
          : `${projection.changes.comparison.base.requested} → ${projection.changes.comparison.head.requested}`,
        fileCount: projection.changes.statistics.files,
        additions: projection.changes.statistics.additions,
        deletions: projection.changes.statistics.deletions,
        runtimeObservedCount: projection.runtime.summariesByNode.size,
      },
    },
    {
      id: `file-flow:${fileProjection.file.id}`,
      position: { x: 300, y: centerY },
      selected: selectedNodeId === null,
      data: {
        variant: "file",
        label: fileProjection.file.path.split("/").at(-1) ?? fileProjection.file.path,
        subtitle: fileProjection.file.path,
        file: fileProjection.file,
        runtimeObservedCount: fileProjection.runtimeObserved.length,
      },
    },
    ...primary.map((impact, index) => {
      const graphNode = projection.nodesById.get(impact.nodeId)!;
      return {
        id: impact.id,
        position: { x: 620, y: index * rowGap },
        selected: selectedNodeId === graphNode.id,
        data: {
          variant: "impact" as const,
          label: graphNode.label,
          subtitle: graphNode.evidence.find((evidence) => evidence.source)?.source?.symbol
            ?? graphNode.summary,
          impact,
          graphNode,
          runtimeSummary: projection.runtime.summariesByNode.get(graphNode.id),
        },
      };
    }),
    ...dependents.map((impact, index) => {
      const graphNode = projection.nodesById.get(impact.nodeId)!;
      return {
        id: impact.id,
        position: { x: 960, y: index * rowGap },
        selected: selectedNodeId === graphNode.id,
        data: {
          variant: "impact" as const,
          label: graphNode.label,
          subtitle: graphNode.evidence.find((evidence) => evidence.source)?.source?.path
            ?? graphNode.summary,
          impact,
          graphNode,
          runtimeSummary: projection.runtime.summariesByNode.get(graphNode.id),
        },
      };
    }),
  ];
  const nodes = records.map<ChangeFlowNode>((record) => ({
    id: record.id,
    type: "change",
    position: previousPositions.get(record.id) ?? record.position,
    selected: record.selected,
    data: record.data,
    ariaLabel: `${record.data.label}，${record.data.variant} 变更节点，点击查看详情`,
  }));
  const edges: Edge[] = [
    {
      id: "change-root-file",
      source: "change-set-root",
      target: `file-flow:${fileProjection.file.id}`,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: "changes",
      style: { stroke: "#a76825", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#a76825", width: 15, height: 15 },
    },
    ...primary.map<Edge>((impact) => ({
      id: `file-impact:${impact.id}`,
      source: `file-flow:${fileProjection.file.id}`,
      target: impact.id,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: impact.kind === "direct" ? "line hit" : impact.kind,
      style: {
        stroke: impact.kind === "direct" ? "#b85c45" : "#8b7a61",
        strokeWidth: impact.kind === "direct" ? 2 : 1.4,
        strokeDasharray: impact.kind === "container" ? "5 4" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: impact.kind === "direct" ? "#b85c45" : "#8b7a61", width: 14, height: 14 },
    })),
    ...dependents.map<Edge>((impact) => ({
      id: `file-dependent:${impact.id}`,
      source: `file-flow:${fileProjection.file.id}`,
      target: impact.id,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: "may affect",
      style: { stroke: "#6c57a2", strokeWidth: 1.5, strokeDasharray: "6 5" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6c57a2", width: 14, height: 14 },
    })),
  ];
  return { nodes, edges };
}

interface ChangeGraphCanvasProps {
  projection: ChangeImpactProjection;
  activeFileId: string;
  selectedNodeId: string | null;
  onSelectFile: (fileId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

export function ChangeGraphCanvas({
  projection,
  activeFileId,
  selectedNodeId,
  onSelectFile,
  onSelectNode,
  magnetEnabled,
  magnetStrength,
}: ChangeGraphCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<ChangeFlowNode, Edge> | null>(null);
  const layoutKey = `${projection.changes.repository.id}:${projection.changes.comparison.mergeBase}:${activeFileId}`;
  const previousLayoutKey = useRef(layoutKey);
  const initial = buildFlow(projection, activeFileId, selectedNodeId);
  const [nodes, setNodes, onNodesChange] = useNodesState<ChangeFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);
  const fitViewOptions = useMemo(() => ({ padding: 0.18, minZoom: 0.28, maxZoom: 1 }), []);

  useEffect(() => {
    const preserve = previousLayoutKey.current === layoutKey;
    const next = buildFlow(projection, activeFileId, selectedNodeId, preserve ? nodes : []);
    setNodes(next.nodes);
    setEdges(next.edges);
    previousLayoutKey.current = layoutKey;
  }, [activeFileId, layoutKey, projection, selectedNodeId, setEdges, setNodes]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let frame = 0;
    const fit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => void instanceRef.current?.fitView(fitViewOptions));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [fitViewOptions, layoutKey]);

  return (
    <div ref={elementRef} className="change-canvas" aria-label="Git 节点影响图">
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          if (node.data.file) {
            onSelectFile(node.data.file.id);
            onSelectNode(null);
          } else if (node.data.graphNode) {
            onSelectNode(node.data.graphNode.id);
          }
        }}
        onPaneClick={() => onSelectNode(null)}
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
        minZoom={0.2}
        maxZoom={1.8}
        fitView
        fitViewOptions={fitViewOptions}
        onInit={(instance) => {
          instanceRef.current = instance;
          window.requestAnimationFrame(() => void instance.fitView(fitViewOptions));
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d8dfdd" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} position="bottom-left" aria-label="变更画布缩放控制" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as ChangeNodeData;
            if (data.variant === "root") return "#b67831";
            if (data.variant === "file") return "#d88b45";
            if (data.impact?.kind === "dependent") return "#6b56a6";
            return "#ba6550";
          }}
          maskColor="rgba(246, 244, 238, 0.72)"
        />
        <Panel position="top-left" className="change-canvas__legend">
          <span><i className="change-legend--direct" />直接命中</span>
          <span><i className="change-legend--container" />上层容器</span>
          <span><i className="change-legend--dependent" />关系影响</span>
          <span><i className="change-legend--runtime" />Runtime 实际经过</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
