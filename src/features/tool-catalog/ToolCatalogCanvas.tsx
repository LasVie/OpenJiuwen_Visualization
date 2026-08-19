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
const REGISTRATION_LIMIT = 8;
const CALL_LIMIT = 10;
const PATH_LIMIT = 8;

function edge(
  id: string,
  source: string,
  target: string,
  label: string,
  color: string,
  dashed = false,
): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "source-right",
    targetHandle: "target-left",
    type: "smoothstep",
    label,
    style: { stroke: color, strokeWidth: dashed ? 1.45 : 2, strokeDasharray: dashed ? "6 5" : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
  };
}

function buildFlow(
  projection: ToolCatalogProjection,
  selectedTool: ProjectedToolDefinition | null,
  selection: ToolCatalogSelection | null,
  previous: readonly ToolCatalogFlowNode[] = [],
) {
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  const registrations = selectedTool?.registrations.slice(0, REGISTRATION_LIMIT) ?? [];
  const calls = selectedTool?.calls.slice(0, CALL_LIMIT) ?? [];
  const paths = selectedTool?.registrationSites.slice(0, PATH_LIMIT) ?? [];
  const runtimeRows = Math.max(1, registrations.length, calls.length);
  const rowGap = 144;
  const centerY = ((runtimeRows - 1) * rowGap) / 2;
  const pathStartY = Math.max(runtimeRows * rowGap + 36, centerY + 190);
  const records: Array<{
    id: string;
    position: { x: number; y: number };
    data: ToolCatalogNodeData;
    selected?: boolean;
  }> = [{
    id: "tool-catalog-root",
    position: { x: 0, y: centerY },
    data: {
      variant: "root",
      repositoryOwner: projection.catalog.repository.owner,
      label: projection.catalog.repository.name,
      subtitle: `${projection.catalog.repository.branch} · ${projection.catalog.repository.revision.slice(0, 12)}`,
      counts: {
        tools: projection.counts.discovered,
        authorized: projection.counts.authorized,
        registered: projection.counts.registered,
        called: projection.counts.called,
      },
    },
  }];
  const edges: Edge[] = [];

  if (selectedTool) {
    const toolId = `tool-flow:${selectedTool.tool.id}`;
    const authorizationId = `authorization-flow:${selectedTool.authorization.id}`;
    records.push({
      id: toolId,
      position: { x: 270, y: centerY },
      selected: selection?.kind === "tool" && selection.id === selectedTool.tool.id,
      data: {
        variant: "tool",
        label: selectedTool.tool.name,
        subtitle: selectedTool.tool.source.path,
        projectedTool: selectedTool,
      },
    }, {
      id: authorizationId,
      position: { x: 540, y: centerY },
      selected: selection?.kind === "authorization" && selection.id === selectedTool.authorization.id,
      data: {
        variant: "authorization",
        label: selectedTool.authorization.state === "authorized" ? "目录读取已授权" : "目录授权未确认",
        subtitle: "仅核验静态 Tool Catalog 读取范围",
        authorization: selectedTool.authorization,
      },
    });
    edges.push(
      edge("catalog-root-tool", "tool-catalog-root", toolId, "AST identity", "#2e7c80"),
      edge("tool-authorization", toolId, authorizationId, "catalog scope", "#4f846f"),
    );

    if (registrations.length) {
      registrations.forEach((registration, index) => {
        const id = `runtime-registration-flow:${registration.id}`;
        records.push({
          id,
          position: { x: 810, y: index * rowGap },
          selected: selection?.kind === "runtime-registration" && selection.id === registration.id,
          data: {
            variant: "runtime-registration",
            label: registration.name,
            subtitle: `${registration.traceId} · seq ${registration.sequence}`,
            runtimeRegistration: registration,
          },
        });
        edges.push(edge(
          `authorization-registration:${registration.id}`,
          authorizationId,
          id,
          "ability.register",
          "#a86f2c",
        ));
      });
    } else {
      records.push({
        id: "runtime-registration-placeholder",
        position: { x: 810, y: centerY },
        data: {
          variant: "placeholder",
          placeholderStage: "registered",
          label: "未观察到运行注册",
          subtitle: "静态路径不等于本次 Trace 已注册",
        },
      });
      edges.push(edge(
        "authorization-registration-placeholder",
        authorizationId,
        "runtime-registration-placeholder",
        "no runtime event",
        "#9b9588",
        true,
      ));
    }

    const registrationSources = registrations.length
      ? registrations.map((item) => `runtime-registration-flow:${item.id}`)
      : ["runtime-registration-placeholder"];
    if (calls.length) {
      calls.forEach((call, index) => {
        const id = `runtime-call-flow:${call.id}`;
        records.push({
          id,
          position: { x: 1080, y: index * rowGap },
          selected: selection?.kind === "runtime-call" && selection.id === call.id,
          data: {
            variant: "runtime-call",
            label: call.name,
            subtitle: call.argumentsPreview ?? "无参数预览",
            runtimeCall: call,
          },
        });
        edges.push(edge(
          `registration-call:${call.id}`,
          registrationSources[index % registrationSources.length],
          id,
          call.status === "error" ? "call error" : "tool.call",
          call.status === "error" ? "#b9574f" : "#6b56a6",
          !registrations.length,
        ));
      });
    } else {
      records.push({
        id: "runtime-call-placeholder",
        position: { x: 1080, y: centerY },
        data: {
          variant: "placeholder",
          placeholderStage: "called",
          label: "未观察到 Tool 调用",
          subtitle: "当前 Trace 没有可对齐的 tool.call",
        },
      });
      registrationSources.forEach((source, index) => edges.push(edge(
        `registration-call-placeholder:${index}`,
        source,
        "runtime-call-placeholder",
        "not called",
        "#9b9588",
        true,
      )));
    }

    paths.forEach((path, index) => {
      const id = `registration-path-flow:${path.id}`;
      records.push({
        id,
        position: { x: 540 + (index % 2) * 270, y: pathStartY + Math.floor(index / 2) * rowGap },
        selected: selection?.kind === "registration-path" && selection.id === path.id,
        data: {
          variant: "registration-path",
          label: path.container || path.callee.split(".").at(-1) || path.callee,
          subtitle: path.callee,
          registrationPath: path,
        },
      });
      edges.push(edge(
        `tool-registration-path:${path.id}`,
        toolId,
        id,
        path.confidence === "exact" ? "static path" : "static inference",
        "#b67831",
        path.confidence !== "exact",
      ));
    });
  }

  const nodes = records.map<ToolCatalogFlowNode>((record) => ({
    id: record.id,
    type: "tool-catalog",
    position: previousPositions.get(record.id) ?? record.position,
    selected: record.selected,
    data: record.data,
    ariaLabel: `${record.data.label}，${record.data.variant} Tool 证据节点，点击查看详情`,
  }));
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
  const layoutKey = `${projection.catalog.repository.id}:${projection.catalog.repository.revision}:${selectedTool?.tool.id ?? "overview"}`;
  const fitKey = `${layoutKey}:${selectedTool?.authorization.state ?? "none"}:${selectedTool?.registrationSites.length ?? 0}:${selectedTool?.registrations.length ?? 0}:${selectedTool?.calls.length ?? 0}`;
  const previousLayoutKey = useRef(layoutKey);
  const initial = buildFlow(projection, selectedTool, selection);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolCatalogFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);
  const fitViewOptions = useMemo(() => ({ padding: 0.2, minZoom: 0.24, maxZoom: 1 }), []);

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
    let measuredFrame = 0;
    const fit = () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(measuredFrame);
      frame = window.requestAnimationFrame(() => {
        measuredFrame = window.requestAnimationFrame(() => {
          void instanceRef.current?.fitView(fitViewOptions);
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
  }, [fitKey, fitViewOptions]);

  return (
    <div ref={elementRef} className="tool-catalog-canvas" aria-label="Tool 四层证据关系图">
      <ReactFlow
        key={layoutKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => onNodesChange(
          changes.filter((change) => change.type !== "remove"),
        )}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          if (node.data.authorization) onSelect({ kind: "authorization", id: node.data.authorization.id });
          else if (node.data.registrationPath) onSelect({ kind: "registration-path", id: node.data.registrationPath.id });
          else if (node.data.runtimeRegistration) onSelect({ kind: "runtime-registration", id: node.data.runtimeRegistration.id });
          else if (node.data.runtimeCall) onSelect({ kind: "runtime-call", id: node.data.runtimeCall.id });
          else if (node.data.projectedTool) onSelect({ kind: "tool", id: node.data.projectedTool.tool.id });
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
        onlyRenderVisibleElements={false}
        deleteKeyCode={null}
        minZoom={0.18}
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
        <Background color="#d8dfdd" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} position="bottom-left" aria-label="Tool 画布缩放控制" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as ToolCatalogNodeData;
            if (data.variant === "authorization") return "#4f846f";
            if (data.variant === "runtime-registration") return "#b67831";
            if (data.variant === "runtime-call") return "#6b56a6";
            if (data.variant === "registration-path") return "#d8a35d";
            if (data.variant === "placeholder") return "#aaa499";
            return data.projectedTool?.tool.owner === "jiuwenswarm" ? "#7456a8" : "#238489";
          }}
          maskColor="rgba(246, 244, 238, 0.72)"
        />
        <Panel position="top-left" className="tool-catalog-canvas__legend">
          <span><i className="tool-legend--declared" />代码发现</span>
          <span><i className="tool-legend--authorized" />目录读取授权</span>
          <span><i className="tool-legend--registered" />运行注册</span>
          <span><i className="tool-legend--called" />实际调用</span>
          <span><i className="tool-legend--path" />静态路径</span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
