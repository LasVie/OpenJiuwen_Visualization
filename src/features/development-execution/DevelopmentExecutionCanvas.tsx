import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { DevelopmentExecution } from "../../adapters/development-execution";
import {
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../trace-graph";
import {
  DevelopmentExecutionNode,
  type DevelopmentExecutionFlowNode,
} from "./DevelopmentExecutionNode";
import {
  projectDevelopmentExecutionFlow,
  type DevelopmentExecutionStep,
} from "./model";

const nodeTypes = {
  "development-execution": DevelopmentExecutionNode,
} satisfies NodeTypes;

interface DevelopmentExecutionCanvasProps {
  execution: DevelopmentExecution;
  selectedStep: DevelopmentExecutionStep;
  onSelectStep: (step: DevelopmentExecutionStep) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

export function DevelopmentExecutionCanvas({
  execution,
  selectedStep,
  onSelectStep,
  magnetEnabled,
  magnetStrength,
}: DevelopmentExecutionCanvasProps) {
  const initial = projectDevelopmentExecutionFlow(execution, selectedStep);
  const [nodes, setNodes, onNodesChange] = useNodesState<DevelopmentExecutionFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const instanceRef = useRef<ReactFlowInstance<DevelopmentExecutionFlowNode, Edge> | null>(null);
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);
  const fitViewOptions = useMemo(() => ({ padding: 0.16, minZoom: 0.45, maxZoom: 1.05 }), []);

  useEffect(() => {
    const next = projectDevelopmentExecutionFlow(execution, selectedStep);
    const projectedNodes = new Map(next.nodes.map((node) => [node.id, node]));
    setNodes((current) => current.map((node) => {
      const projected = projectedNodes.get(node.id);
      if (!projected) return node;
      return {
        ...node,
        selected: projected.selected,
        data: projected.data,
        ariaLabel: projected.ariaLabel,
      };
    }));
    setEdges(next.edges);
  }, [execution, selectedStep, setEdges, setNodes]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void instanceRef.current?.fitView(fitViewOptions);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [execution.status, fitViewOptions]);

  return (
    <div className="development-execution-canvas" aria-label="受控开发执行状态图">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => onNodesChange(changes.filter((change) => change.type !== "remove"))}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelectStep(node.data.step)}
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
        minZoom={0.35}
        maxZoom={1.6}
        fitView
        fitViewOptions={fitViewOptions}
        onInit={(instance) => {
          instanceRef.current = instance;
          window.requestAnimationFrame(() => void instance.fitView(fitViewOptions));
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d4dedb" gap={22} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as DevelopmentExecutionFlowNode["data"];
            if (data.step === "rollback") return "#b46a62";
            if (data.step === "commit") return "#7654b5";
            if (data.step === "test") return "#34766b";
            if (data.step === "source") return "#52796f";
            return "#b0792f";
          }}
          maskColor="rgba(241, 245, 244, 0.74)"
          style={{ width: 112, height: 70 }}
        />
      </ReactFlow>
    </div>
  );
}
