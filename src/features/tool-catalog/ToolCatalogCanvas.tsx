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
import type {
  ProjectedToolDefinition,
  ToolCatalogProjection,
  ToolCatalogSelection,
} from "./model";
import {
  ToolCatalogNode,
  type ToolCatalogFlowNode,
  type ToolCatalogNodeData,
} from "./ToolCatalogNode";

const nodeTypes = { "tool-catalog": ToolCatalogNode } satisfies NodeTypes;

function buildFlow(
  projection: ToolCatalogProjection,
  selectedTool: ProjectedToolDefinition | null,
  selection: ToolCatalogSelection | null,
  previous: readonly ToolCatalogFlowNode[] = [],
) {
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const sites = selectedTool?.registrationSites ?? [];
  const observations = selectedTool?.observations ?? [];
  const maxRows = Math.max(1, sites.length, observations.length);
  const rowGap = 138;
  const centerY = ((maxRows - 1) * rowGap) / 2;
  const records: Array<{
    id: string;
    position: { x: number; y: number };
    data: ToolCatalogNodeData;
    selected?: boolean;
  }> = [
    {
      id: "tool-catalog-root",
      position: { x: 0, y: centerY },
      data: {
        variant: "root",
        label: projection.catalog.repository.name,
        subtitle: `${projection.catalog.repository.branch} · ${projection.catalog.repository.revision.slice(0, 12)}`,
        counts: {
          tools: projection.catalog.statistics.tools,
          sites: projection.catalog.statistics.registrationSites,
          observed: projection.observations.length,
        },
      },
    },
  ];
  if (selectedTool) {
    records.push({
      id: `tool-flow:${selectedTool.tool.id}`,
      position: { x: 250, y: centerY },
      selected: selection?.kind === "tool" && selection.id === selectedTool.tool.id,
      data: {
        variant: "tool",
        label: selectedTool.tool.name,
        subtitle: selectedTool.tool.source.path,
        projectedTool: selectedTool,
      },
    });
    sites.slice(0, 14).forEach((site, index) => records.push({
      id: `registration-flow:${site.id}`,
      position: { x: 500, y: index * rowGap },
      selected: selection?.kind === "registration" && selection.id === site.id,
      data: {
        variant: "registration",
        label: site.container || site.callee.split(".").at(-1) || site.callee,
        subtitle: site.callee,
        registration: site,
      },
    }));
    observations.slice(0, 10).forEach((runtime, index) => records.push({
      id: `runtime-flow:${runtime.id}`,
      position: { x: sites.length ? 750 : 500, y: index * rowGap },
      selected: selection?.kind === "runtime" && selection.id === runtime.id,
      data: {
        variant: "runtime",
        label: runtime.name,
        subtitle: runtime.source ?? runtime.abilityType,
        runtime,
      },
    }));
  }
  const nodes = records.map<ToolCatalogFlowNode>((record) => ({
    id: record.id,
    type: "tool-catalog",
    position: previousPositions.get(record.id) ?? record.position,
    selected: record.selected,
    data: record.data,
    ariaLabel: `${record.data.label}，${record.data.variant} Tool 节点，点击查看详情`,
  }));
  const edges: Edge[] = [];
  if (selectedTool) {
    const toolFlowId = `tool-flow:${selectedTool.tool.id}`;
    edges.push({
      id: "catalog-root-tool",
      source: "tool-catalog-root",
      target: toolFlowId,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: "declares",
      style: { stroke: "#2e7c80", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#2e7c80", width: 15, height: 15 },
    });
    sites.slice(0, 14).forEach((site) => edges.push({
      id: `tool-registration:${site.id}`,
      source: toolFlowId,
      target: `registration-flow:${site.id}`,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: site.confidence === "exact" ? "registers" : "may register",
      style: {
        stroke: site.confidence === "exact" ? "#a76825" : "#8b7a61",
        strokeWidth: 1.6,
        strokeDasharray: site.confidence === "exact" ? undefined : "5 4",
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#8b7a61", width: 14, height: 14 },
    }));
    observations.slice(0, 10).forEach((runtime, index) => edges.push({
      id: `tool-runtime:${runtime.id}`,
      source: sites[index % Math.max(1, sites.length)]
        ? `registration-flow:${sites[index % sites.length].id}`
        : toolFlowId,
      target: `runtime-flow:${runtime.id}`,
      sourceHandle: "source-right",
      targetHandle: "target-left",
      type: "smoothstep",
      label: "observed",
      style: { stroke: "#6b56a6", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6b56a6", width: 14, height: 14 },
    }));
  }
  return { nodes, edges };
}

interface ToolCatalogCanvasProps {
  projection: ToolCatalogProjection;
  selectedTool: ProjectedToolDefinition | null;
  selection: ToolCatalogSelection | null;
  onSelect: (selection: ToolCatalogSelection | null) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

export function ToolCatalogCanvas({
  projection,
  selectedTool,
  selection,
  onSelect,
  magnetEnabled,
  magnetStrength,
}: ToolCatalogCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<ToolCatalogFlowNode, Edge> | null>(null);
  const layoutKey = `${projection.catalog.repository.id}:${selectedTool?.tool.id ?? "overview"}`;
  const previousLayoutKey = useRef(layoutKey);
  const initial = buildFlow(projection, selectedTool, selection);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolCatalogFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);
  const fitViewOptions = useMemo(() => ({ padding: 0.2, minZoom: 0.28, maxZoom: 1 }), []);

  useEffect(() => {
    const preserve = previousLayoutKey.current === layoutKey;
    const next = buildFlow(projection, selectedTool, selection, preserve ? nodes : []);
    setNodes(next.nodes);
    setEdges(next.edges);
    previousLayoutKey.current = layoutKey;
  }, [layoutKey, projection, selectedTool, selection, setEdges, setNodes]);

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
    <div ref={elementRef} className="tool-catalog-canvas" aria-label="Tool 注册关系图">
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          if (node.data.projectedTool) onSelect({ kind: "tool", id: node.data.projectedTool.tool.id });
          else if (node.data.registration) onSelect({ kind: "registration", id: node.data.registration.id });
          else if (node.data.runtime) onSelect({ kind: "runtime", id: node.data.runtime.id });
        }}
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
        <Controls showInteractive={false} position="bottom-left" aria-label="Tool 画布缩放控制" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as ToolCatalogNodeData;
            if (data.variant === "root") return "#2e7c80";
            if (data.variant === "runtime") return "#6b56a6";
            if (data.variant === "registration") return "#b67831";
            return data.projectedTool?.tool.owner === "jiuwenswarm" ? "#7456a8" : "#238489";
          }}
          maskColor="rgba(246, 244, 238, 0.72)"
        />
        <Panel position="top-left" className="tool-catalog-canvas__legend">
          <span><i className="tool-legend--declared" />工具声明</span>
          <span><i className="tool-legend--path" />静态路径</span>
          <span><i className="tool-legend--runtime" />运行确认</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
