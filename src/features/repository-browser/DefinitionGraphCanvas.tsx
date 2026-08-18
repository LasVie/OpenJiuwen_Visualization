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
import type { DefinitionGraphIndex, DefinitionViewport } from "./model";
import {
  DefinitionNode,
  type DefinitionNodeData,
  type DefinitionFlowNode,
} from "./DefinitionNode";

const nodeTypes = { definition: DefinitionNode } satisfies NodeTypes;

function relationCount(index: DefinitionGraphIndex, nodeId: string) {
  return [
    ...(index.incomingByNode.get(nodeId) ?? []),
    ...(index.outgoingByNode.get(nodeId) ?? []),
  ].filter((edge) => edge.kind !== "contains").length;
}

function buildNodes(
  index: DefinitionGraphIndex,
  viewport: DefinitionViewport,
  selectedNodeId: string | null,
  previous: DefinitionFlowNode[] = [],
) {
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const columnCount = Math.min(
    4,
    viewport.members.length <= 4
      ? 2
      : Math.max(2, Math.ceil(Math.sqrt(viewport.members.length * 1.25))),
  );
  const defaultPosition = new Map<string, { x: number; y: number }>([
    [viewport.focus.id, { x: ((columnCount - 1) * 310) / 2, y: 0 }],
  ]);
  viewport.members.forEach((record, indexInView) => {
    const row = Math.floor(indexInView / columnCount);
    const rowStart = row * columnCount;
    const rowSize = Math.min(columnCount, viewport.members.length - rowStart);
    const rowOffset = ((columnCount - rowSize) * 310) / 2;
    defaultPosition.set(record.id, {
      x: rowOffset + (indexInView % columnCount) * 310,
      y: 230 + row * 188,
    });
  });

  return [viewport.focus, ...viewport.members].map<DefinitionFlowNode>((record) => ({
    id: record.id,
    type: "definition",
    position:
      previousPositions.get(record.id) ?? defaultPosition.get(record.id) ?? { x: 0, y: 0 },
    selected: selectedNodeId === record.id,
    data: {
      record,
      childCount: index.childrenByParent.get(record.id)?.length ?? 0,
      relationCount: relationCount(index, record.id),
      focus: record.id === viewport.focus.id,
    },
    ariaLabel: `${record.label}，${record.kind} 定义节点，点击查看详情，双击进入`,
  }));
}

function edgeColor(kind: string) {
  if (kind === "inherits") return "#7259ad";
  if (kind === "imports") return "#2f7e85";
  return "#9aadae";
}

function buildEdges(viewport: DefinitionViewport): Edge[] {
  return viewport.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.kind === "contains" ? "source-bottom" : "source-right",
    targetHandle: edge.kind === "contains" ? "target-top" : "target-left",
    type: "smoothstep",
    label: edge.kind === "contains" ? undefined : edge.kind,
    labelStyle: {
      fill: edgeColor(edge.kind),
      fontSize: 9,
      fontWeight: 700,
    },
    labelBgStyle: { fill: "#f8faf9", fillOpacity: 0.94 },
    style: {
      stroke: edgeColor(edge.kind),
      strokeWidth: edge.kind === "contains" ? 1.25 : 1.8,
      strokeDasharray: edge.kind === "imports" ? "6 5" : undefined,
    },
    markerEnd:
      edge.kind === "contains"
        ? undefined
        : {
            type: MarkerType.ArrowClosed,
            width: 15,
            height: 15,
            color: edgeColor(edge.kind),
          },
  }));
}

interface DefinitionGraphCanvasProps {
  index: DefinitionGraphIndex;
  viewport: DefinitionViewport;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onFocusNode: (nodeId: string) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

export function DefinitionGraphCanvas({
  index,
  viewport,
  selectedNodeId,
  onSelectNode,
  onFocusNode,
  magnetEnabled,
  magnetStrength,
}: DefinitionGraphCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<DefinitionFlowNode, Edge> | null>(null);
  const layoutKey = `${viewport.focus.id}:${viewport.page}:${viewport.members
    .map((node) => node.id)
    .join("|")}`;
  const previousLayoutKey = useRef(layoutKey);
  const [nodes, setNodes, onNodesChange] = useNodesState<DefinitionFlowNode>(
    buildNodes(index, viewport, selectedNodeId),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(viewport));
  const magnetProfile = useMemo(
    () => magneticProfile(magnetStrength),
    [magnetStrength],
  );
  const fitViewOptions = useMemo(
    () => ({ padding: 0.16, minZoom: 0.24, maxZoom: 1 }),
    [],
  );

  useEffect(() => {
    const preservePositions = previousLayoutKey.current === layoutKey;
    setNodes((current) =>
      buildNodes(
        index,
        viewport,
        selectedNodeId,
        preservePositions ? current : [],
      ),
    );
    setEdges(buildEdges(viewport));
    previousLayoutKey.current = layoutKey;
  }, [index, layoutKey, selectedNodeId, setEdges, setNodes, viewport]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let frame = 0;
    const fit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        void instanceRef.current?.fitView(fitViewOptions);
      });
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
    <div ref={elementRef} className="definition-canvas" aria-label="仓库静态定义图">
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDoubleClick={(_, node) => onFocusNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        onNodeDrag={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => {
            const moved = current.map((candidate) =>
              candidate.id === node.id
                ? { ...candidate, position: node.position }
                : candidate,
            );
            return repelNodeCollisions(moved, node.id, {
              gap: magnetProfile.gap,
            });
          });
        }}
        onNodeDragStop={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => {
            const moved = current.map((candidate) =>
              candidate.id === node.id
                ? { ...candidate, position: node.position }
                : candidate,
            );
            const repelled = repelNodeCollisions(moved, node.id, {
              gap: magnetProfile.gap,
            });
            return magnetizeNode(repelled, node.id, magnetProfile);
          });
        }}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.22}
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
        colorMode="light"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.15}
          color="#c8d2d2"
        />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(node) => {
            const owner = (node.data as DefinitionNodeData | undefined)?.record.owner;
            return owner === "jiuwenswarm" ? "#8f7bc4" : "#5b9fa5";
          }}
          maskColor="rgba(242, 245, 245, 0.72)"
        />
        <Panel position="top-left" className="definition-canvas__legend">
          <span><i className="definition-legend definition-legend--contains" />contains</span>
          <span><i className="definition-legend definition-legend--imports" />imports</span>
          <span><i className="definition-legend definition-legend--inherits" />inherits</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
