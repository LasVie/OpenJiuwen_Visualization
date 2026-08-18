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
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { graphEdges, graphNodes } from "../data/scenarios";
import {
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../features/trace-graph";
import {
  getVisitedNodeIds,
  shouldExpandDeepAgent,
} from "../state/trace-utils";
import type {
  StageNodeDefinition,
  TraceEdgeDefinition,
  TraceNodeStatus,
  TraceScenario,
  TraceViewMode,
} from "../types/trace";
import {
  AgentGroupNode,
  AgentSummaryNode,
  RailNode,
  StageNode,
  type TraceFlowNode,
} from "./TraceNodes";
import {
  TraceEdge,
  type TraceEdgeData,
  type TraceFlowEdge,
} from "./TraceEdge";

const nodeTypes = {
  stage: StageNode,
  rail: RailNode,
  agentSummary: AgentSummaryNode,
  agentGroup: AgentGroupNode,
} satisfies NodeTypes;

const edgeTypes = {
  trace: TraceEdge,
} satisfies EdgeTypes;

const internalNodeIds = new Set([
  "react-loop",
  "context",
  "model",
  "decision",
  "tool",
]);

const expandedPositions: Record<string, { x: number; y: number }> = {
  input: { x: 0, y: 300 },
  "deep-agent": { x: 250, y: 100 },
  "react-loop": { x: 35, y: 125 },
  context: { x: 285, y: 125 },
  model: { x: 535, y: 125 },
  decision: { x: 785, y: 125 },
  tool: { x: 535, y: 310 },
  output: { x: 1225, y: 300 },
  "rail-safety": { x: 0, y: 85 },
  "rail-init": { x: 250, y: -55 },
  "rail-context": { x: 490, y: -55 },
  "rail-retry": { x: 730, y: -55 },
  "rail-trajectory": { x: 970, y: -55 },
  "rail-compression": { x: 490, y: 600 },
  "rail-tool": { x: 730, y: 600 },
};

const collapsedPositions: Record<string, { x: number; y: number }> = {
  input: { x: 20, y: 275 },
  "deep-agent": { x: 430, y: 235 },
  output: { x: 920, y: 275 },
  "rail-safety": { x: 20, y: 70 },
  "rail-init": { x: 310, y: 20 },
  "rail-context": { x: 550, y: 20 },
  "rail-retry": { x: 790, y: 20 },
  "rail-trajectory": { x: 1030, y: 20 },
  "rail-compression": { x: 550, y: 500 },
  "rail-tool": { x: 790, y: 500 },
};

interface FlowCanvasProps {
  scenario: TraceScenario;
  stepIndex: number;
  playbackRevision: number;
  selectedNodeId: string | null;
  viewMode: TraceViewMode;
  deepAgentExpanded: boolean;
  onExpandDeepAgent: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onOpenRail: (railId: string) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

function definitionById(id: string) {
  return graphNodes.find((node) => node.id === id);
}

function visibleDefinitions(
  scenario: TraceScenario,
  expanded: boolean,
) {
  return graphNodes.filter((node) => {
    if (node.type === "rail") return scenario.railNodeIds.includes(node.id);
    if (
      node.id === "input" ||
      node.id === "deep-agent" ||
      node.id === "output"
    ) {
      return true;
    }
    return expanded && internalNodeIds.has(node.id);
  });
}

function currentInternalStage(scenario: TraceScenario, stepIndex: number) {
  const step = scenario.steps[stepIndex];
  const activeDefinition = step.activeNodeIds
    .map(definitionById)
    .find(
      (definition): definition is StageNodeDefinition =>
        definition?.type === "stage" && internalNodeIds.has(definition.id),
    );

  if (activeDefinition) return activeDefinition.label;
  if (step.activeNodeIds.includes("deep-agent")) {
    return "DeepAgent lifecycle";
  }
  if (stepIndex === 0) return "等待进入 DeepAgent";
  return step.title;
}

function nodeStatus(
  id: string,
  scenario: TraceScenario,
  stepIndex: number,
): TraceNodeStatus {
  const step = scenario.steps[stepIndex];
  const active = new Set(step.activeNodeIds);
  const visited = getVisitedNodeIds(scenario, stepIndex);
  const muted = new Set(scenario.mutedNodeIds ?? []);

  if (muted.has(id)) return "muted";

  if (id === "deep-agent") {
    const internalActive = [...internalNodeIds].some((nodeId) =>
      active.has(nodeId),
    );
    if (
      active.has(id) ||
      internalActive ||
      (stepIndex > 0 && stepIndex < scenario.steps.length - 1)
    ) {
      return "active";
    }
    return stepIndex > 0 ? "visited" : "idle";
  }

  if (id === "react-loop") {
    if (active.has("decision")) return "active";
    const internalVisited = [...internalNodeIds].some((nodeId) =>
      visited.has(nodeId),
    );
    return internalVisited ? "visited" : "idle";
  }

  if (active.has(id)) return "active";
  if (visited.has(id)) return "visited";
  return "idle";
}

function buildNodes(
  scenario: TraceScenario,
  stepIndex: number,
  selectedNodeId: string | null,
  expanded: boolean,
  previous: TraceFlowNode[] = [],
): TraceFlowNode[] {
  const step = scenario.steps[stepIndex];
  const currentStage = currentInternalStage(scenario, stepIndex);
  const previousPositions = new Map(
    previous.map((node) => [node.id, node.position]),
  );
  const defaultPositions = expanded ? expandedPositions : collapsedPositions;

  return visibleDefinitions(scenario, expanded).map((definition) => {
    const status = nodeStatus(definition.id, scenario, stepIndex);
    const fallbackPosition =
      defaultPositions[definition.id] ?? definition.position;
    const position = previousPositions.get(definition.id) ?? fallbackPosition;

    if (definition.type === "stage" && definition.id === "deep-agent") {
      if (!expanded) {
        return {
          id: definition.id,
          type: "agentSummary",
          position,
          selected: selectedNodeId === definition.id,
          data: {
            definition,
            status,
            eventCode: status === "active" ? step.eventCode : undefined,
            currentStage,
          },
          ariaLabel: "DeepAgent 宏观容器，点击展开 ReAct 内部链路",
        };
      }

      return {
        id: definition.id,
        type: "agentGroup",
        position,
        selected: selectedNodeId === definition.id,
        data: {
          definition,
          status,
          eventCode: status === "active" ? step.eventCode : undefined,
          currentStage,
        },
        style: { width: 1100, height: 475 },
        zIndex: 0,
        ariaLabel: "DeepAgent 展开容器，包含 ReActAgent 主链和工具分支",
      };
    }

    if (definition.type === "stage") {
      const isInternal = internalNodeIds.has(definition.id);
      return {
        id: definition.id,
        type: "stage",
        position,
        parentId: isInternal ? "deep-agent" : undefined,
        extent: isInternal ? "parent" : undefined,
        expandParent: false,
        draggable: true,
        zIndex: isInternal ? 3 : 2,
        selected: selectedNodeId === definition.id,
        data: {
          definition,
          status,
          eventCode: status === "active" ? step.eventCode : undefined,
          compact: isInternal,
          hierarchy:
            definition.id === "tool"
              ? "branch"
              : isInternal
                ? "main"
                : "outer",
        },
        ariaLabel: definition.label + "，点击查看详情",
      };
    }

    return {
      id: definition.id,
      type: "rail",
      position,
      selected: selectedNodeId === definition.id,
      data: {
        definition,
        status,
        eventCode: status === "active" ? step.eventCode : undefined,
      },
      zIndex: 2,
      ariaLabel:
        definition.label +
        "，点击打开独立决策画布；包含 " +
        definition.hooks.length +
        " 个 Hook",
    };
  });
}

function collapsedEdges(scenario: TraceScenario): TraceEdgeDefinition[] {
  const railDefinitions = graphEdges.filter(
    (edge) =>
      edge.kind === "rail" &&
      scenario.railNodeIds.includes(edge.source),
  );

  return [
    {
      id: "e-input-deep",
      source: "input",
      target: "deep-agent",
      kind: "causal",
    },
    {
      id: "e-deep-output-macro",
      source: "deep-agent",
      target: "output",
      label: "response",
      kind: "causal",
    },
    ...railDefinitions.map((edge) =>
      edge.id === "e-rail-safety-input" || edge.id === "e-rail-init-deep"
        ? edge
        : {
            ...edge,
            target: "deep-agent",
            targetHandle: "rail-target-top",
          },
    ),
  ];
}

function buildEdges(
  scenario: TraceScenario,
  stepIndex: number,
  pulseKey: number,
  expanded: boolean,
): TraceFlowEdge[] {
  const definitions = visibleDefinitions(scenario, expanded);
  const visibleNodeIds = new Set(definitions.map((node) => node.id));
  const step = scenario.steps[stepIndex];
  const active = new Set(step.activeEdgeIds);
  const visited = new Set(
    scenario.steps
      .slice(0, stepIndex)
      .flatMap((traceStep) => traceStep.activeEdgeIds),
  );
  const edgeDefinitions = expanded ? graphEdges : collapsedEdges(scenario);

  return edgeDefinitions
    .filter(
      (edge) =>
        visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
    )
    .map((edge) => {
      const mappedActive =
        edge.id === "e-deep-output-macro"
          ? active.has("e-decision-output")
          : active.has(edge.id);
      const mappedVisited =
        edge.id === "e-deep-output-macro"
          ? visited.has("e-decision-output")
          : visited.has(edge.id);
      const color =
        edge.kind === "rail"
          ? mappedActive
            ? "#b76d21"
            : "#b6a58f"
          : mappedActive
            ? "#0f7b82"
            : mappedVisited
              ? "#7f999c"
              : "#aebabc";

      const data: TraceEdgeData = {
        active: mappedActive,
        visited: mappedVisited,
        kind: edge.kind ?? "causal",
        label: edge.label,
        pulseKey,
      };

      return {
        id: edge.id,
        type: "trace",
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        data,
        zIndex: mappedActive ? 5 : edge.kind === "rail" ? 0 : 1,
        markerEnd:
          edge.kind === "rail"
            ? undefined
            : {
                type: MarkerType.ArrowClosed,
                color,
                width: 16,
                height: 16,
              },
      };
    });
}

export function FlowCanvas({
  scenario,
  stepIndex,
  playbackRevision,
  selectedNodeId,
  viewMode,
  deepAgentExpanded,
  onExpandDeepAgent,
  onSelectNode,
  onOpenRail,
  magnetEnabled,
  magnetStrength,
}: FlowCanvasProps) {
  const canvasElementRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<
    ReactFlowInstance<TraceFlowNode, TraceFlowEdge> | null
  >(null);
  const expanded = shouldExpandDeepAgent(
    viewMode,
    deepAgentExpanded,
    stepIndex,
  );
  const layoutKey =
    scenario.id +
    ":" +
    viewMode +
    ":" +
    (expanded ? "expanded" : "collapsed");
  const previousLayoutKey = useRef(layoutKey);
  const [nodes, setNodes, onNodesChange] = useNodesState<TraceFlowNode>(
    buildNodes(scenario, stepIndex, selectedNodeId, expanded),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<TraceFlowEdge>(
    buildEdges(scenario, stepIndex, playbackRevision, expanded),
  );
  const fitViewOptions = useMemo(
    () => ({
      padding: expanded ? 0.1 : 0.15,
      minZoom: 0.3,
      maxZoom: expanded ? 0.86 : 1,
    }),
    [expanded],
  );
  const magnetProfile = useMemo(
    () => magneticProfile(magnetStrength),
    [magnetStrength],
  );

  useEffect(() => {
    const preservePositions = previousLayoutKey.current === layoutKey;
    setNodes((current) =>
      buildNodes(
        scenario,
        stepIndex,
        selectedNodeId,
        expanded,
        preservePositions ? current : [],
      ),
    );
    setEdges(buildEdges(scenario, stepIndex, playbackRevision, expanded));
    previousLayoutKey.current = layoutKey;
  }, [
    expanded,
    layoutKey,
    playbackRevision,
    scenario,
    selectedNodeId,
    setEdges,
    setNodes,
    stepIndex,
  ]);

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;

    let animationFrame = 0;
    let previousWidth = 0;
    let previousHeight = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width;
      previousHeight = height;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        void flowInstanceRef.current?.fitView(fitViewOptions);
      });
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [fitViewOptions, layoutKey]);

  return (
    <div
      ref={canvasElementRef}
      className="flow-canvas"
      aria-label="Agent 执行链路图"
    >
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          if (node.id === "deep-agent" && !expanded) {
            onExpandDeepAgent();
            return;
          }
          if (definitionById(node.id)?.type === "rail") {
            onOpenRail(node.id);
            return;
          }
          onSelectNode(node.id);
        }}
        onNodeDrag={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => {
            const withDraggedPosition = current.map((candidate) =>
              candidate.id === node.id
                ? { ...candidate, position: node.position }
                : candidate,
            );
            return repelNodeCollisions(withDraggedPosition, node.id, {
              gap: magnetProfile.gap,
            });
          });
        }}
        onNodeDragStop={(_, node) => {
          if (!magnetEnabled) return;
          setNodes((current) => {
            const withDraggedPosition = current.map((candidate) =>
              candidate.id === node.id
                ? { ...candidate, position: node.position }
                : candidate,
            );
            const repelled = repelNodeCollisions(
              withDraggedPosition,
              node.id,
              { gap: magnetProfile.gap },
            );
            return magnetizeNode(repelled, node.id, magnetProfile);
          });
        }}
        onPaneClick={() => onSelectNode(null)}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.32}
        maxZoom={1.8}
        fitView
        fitViewOptions={fitViewOptions}
        onInit={(instance) => {
          flowInstanceRef.current = instance;
          // Custom parent/child nodes report their final bounds just after init.
          // Re-fit once those measurements settle so outer Rail cards stay visible.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              void instance.fitView(fitViewOptions);
            });
          });
        }}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="#c8d2d2"
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          aria-label="画布缩放控制"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(node) =>
            (node.data as { definition?: { owner?: string } }).definition
              ?.owner === "jiuwenswarm"
              ? "#9a88cf"
              : node.type === "rail"
                ? "#c9a16c"
                : "#73aeb3"
          }
          maskColor="rgba(242, 245, 245, 0.72)"
          aria-label="链路缩略图"
        />
        <Panel position="top-left" className="canvas-legend">
          <span><i className="legend-dot legend-dot--active" />当前</span>
          <span><i className="legend-dot legend-dot--visited" />已运行</span>
          <span><i className="legend-line" />Rail / Hook</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
