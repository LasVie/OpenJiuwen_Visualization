import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  Box,
  ChevronsDown,
  CircleDot,
  GitFork,
  LocateFixed,
  LockKeyhole,
  Network,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import type { RegisteredGraphEdge, RegisteredGraphNode } from "../../kernel";
import { SourceViewer } from "../source-viewer";
import {
  MagnetControls,
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../trace-graph";
import type { DefinitionGraphIndex } from "../repository-browser";
import {
  projectRelationExplorer,
  relationKinds,
  type RelationDirection,
  type RelationExplorerProjection,
} from "./model";
import {
  RelationNode,
  type RelationFlowNode,
} from "./RelationNode";

const nodeTypes = { relationExplorer: RelationNode } satisfies NodeTypes;

const directionOptions: readonly {
  value: RelationDirection;
  label: string;
  icon: typeof Network;
}[] = [
  { value: "all", label: "双向", icon: ArrowDownToLine },
  { value: "incoming", label: "仅上游", icon: ArrowLeftToLine },
  { value: "outgoing", label: "仅下游", icon: ArrowRightToLine },
];

function edgeColor(kind: string) {
  if (kind === "inherits") return "#7259ad";
  if (kind === "imports") return "#2f7e85";
  return "#8d9e9f";
}

function buildEdges(projection: RelationExplorerProjection): Edge[] {
  return projection.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    label: edge.kind,
    labelStyle: { fill: edgeColor(edge.kind), fontSize: 9, fontWeight: 750 },
    labelBgStyle: { fill: "#f8faf9", fillOpacity: 0.95 },
    style: {
      stroke: edgeColor(edge.kind),
      strokeWidth: edge.kind === "contains" ? 1.5 : 2,
      strokeDasharray: edge.kind === "imports" ? "6 5" : undefined,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 15,
      height: 15,
      color: edgeColor(edge.kind),
    },
  }));
}

function buildNodes(
  projection: RelationExplorerProjection,
  selectedNodeId: string,
  onToggle: (nodeId: string) => void,
  previous: readonly RelationFlowNode[] = [],
) {
  const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
  return projection.nodes.map<RelationFlowNode>((item) => ({
    id: item.record.id,
    type: "relationExplorer",
    position: previousPositions.get(item.record.id) ?? item.position,
    selected: item.record.id === selectedNodeId,
    style: { width: 252, height: 142 },
    data: {
      record: item.record,
      root: item.root,
      expanded: item.expanded,
      expandable: item.expandable,
      totalRelations: item.totalRelations,
      visibleRelations: item.visibleRelations,
      hiddenRelations: item.hiddenRelations,
      onToggle,
    },
    ariaLabel: `${item.record.label}，${item.record.kind}，${item.visibleRelations} 条已显示关系`,
  }));
}

function peerFor(edge: RegisteredGraphEdge, nodeId: string) {
  return edge.source === nodeId ? edge.target : edge.source;
}

interface RelationExplorerProps {
  index: DefinitionGraphIndex;
  node: RegisteredGraphNode;
  repositoryPath: string;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
  buttonLabel?: string;
}

export function RelationExplorer({
  index,
  node,
  repositoryPath,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
  buttonLabel = "关系画布",
}: RelationExplorerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<RelationFlowNode, Edge> | null>(null);
  const [open, setOpen] = useState(false);
  const [rootId, setRootId] = useState(node.id);
  const [selectedNodeId, setSelectedNodeId] = useState(node.id);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => new Set([node.id]),
  );
  const availableKinds = useMemo(() => relationKinds(index), [index]);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(
    () => new Set(availableKinds),
  );
  const [direction, setDirection] = useState<RelationDirection>("all");
  const profile = useMemo(() => magneticProfile(magnetStrength), [magnetStrength]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const resolvedRootId = index.nodesById.has(rootId) ? rootId : node.id;
  const projection = useMemo(
    () => projectRelationExplorer(index, resolvedRootId, expandedNodeIds, {
      direction,
      edgeKinds: enabledKinds,
    }),
    [direction, enabledKinds, expandedNodeIds, index, resolvedRootId],
  );
  const resolvedSelectedId = projection.nodes.some(
    (item) => item.record.id === selectedNodeId,
  ) ? selectedNodeId : projection.root.id;
  const selectedNode = index.nodesById.get(resolvedSelectedId) ?? projection.root;
  const selectedSource = selectedNode.evidence.find((evidence) => evidence.source)?.source;
  const selectedEdges = projection.edges.filter(
    (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
  );
  const projectionKey = `${resolvedRootId}:${direction}:${[...enabledKinds].sort().join("|")}:${projection.nodes
    .map((item) => `${item.record.id}:${item.expanded}`)
    .join("|")}`;
  const previousProjectionKey = useRef(projectionKey);
  const [nodes, setNodes, onNodesChange] = useNodesState<RelationFlowNode>(
    buildNodes(projection, resolvedSelectedId, toggleExpanded),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(projection));
  const fitViewOptions = useMemo(
    () => ({ padding: 0.24, minZoom: 0.22, maxZoom: 1, duration: 260 }),
    [],
  );

  useEffect(() => {
    const preservePositions = previousProjectionKey.current === projectionKey;
    setNodes((current) => buildNodes(
      projection,
      resolvedSelectedId,
      toggleExpanded,
      preservePositions ? current : [],
    ));
    setEdges(buildEdges(projection));
    previousProjectionKey.current = projectionKey;
  }, [projection, projectionKey, resolvedSelectedId, setEdges, setNodes, toggleExpanded]);

  useEffect(() => {
    if (!open) return;
    const element = canvasRef.current;
    if (!element) return;
    let firstFrame = 0;
    let secondFrame = 0;
    const fit = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          void flowRef.current?.fitView(fitViewOptions);
        });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [fitViewOptions, open, projectionKey]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (document.querySelector(".source-viewer-dialog")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => !element.hasAttribute("aria-hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  function openExplorer() {
    setRootId(node.id);
    setSelectedNodeId(node.id);
    setExpandedNodeIds(new Set([node.id]));
    setEnabledKinds(new Set(availableKinds));
    setDirection("all");
    setOpen(true);
  }

  function useAsRoot(nodeId: string) {
    setRootId(nodeId);
    setSelectedNodeId(nodeId);
    setExpandedNodeIds(new Set([nodeId]));
  }

  function toggleKind(kind: string) {
    setEnabledKinds((current) => {
      if (current.has(kind) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function expandVisible() {
    setExpandedNodeIds((current) => new Set([
      ...current,
      ...projection.nodes.filter((item) => item.expandable).map((item) => item.record.id),
    ]));
  }

  const dialog = open ? (
    <div
      className="relation-explorer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <section
        ref={dialogRef}
        className="relation-explorer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${projection.root.label} 关系深入`}
      >
        <header className="relation-explorer-header">
          <span className="relation-explorer-header__icon"><Network size={20} /></span>
          <span className="relation-explorer-header__identity">
            <small>NODE RELATION EXPLORER</small>
            <strong>{projection.root.label}</strong>
            <code>{projection.root.kind} · {projection.root.owner}</code>
          </span>
          <span className="relation-explorer-header__metric"><b>{projection.nodes.length}</b>节点</span>
          <span className="relation-explorer-header__metric"><b>{projection.edges.length}</b>关系</span>
          <span className="relation-explorer-header__readonly"><LockKeyhole size={12} />静态只读</span>
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="关闭关系深入画布">
            <X size={18} />
          </button>
        </header>

        <div className="relation-explorer-body">
          <aside className="relation-explorer-controls" aria-label="关系筛选与展开控制">
            <section>
              <small>探索方向</small>
              <div className="relation-direction-switch">
                {directionOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      type="button"
                      key={option.value}
                      className={direction === option.value ? "is-active" : ""}
                      onClick={() => setDirection(option.value)}
                    >
                      <Icon size={13} />{option.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <small>关系类型</small>
              <div className="relation-kind-list">
                {availableKinds.map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    className={enabledKinds.has(kind) ? "is-active" : ""}
                    onClick={() => toggleKind(kind)}
                    aria-pressed={enabledKinds.has(kind)}
                  >
                    <i style={{ background: edgeColor(kind) }} />
                    <code>{kind}</code>
                  </button>
                ))}
              </div>
            </section>

            <section className="relation-expansion-actions">
              <small>分层展开</small>
              <button type="button" onClick={expandVisible}>
                <ChevronsDown size={14} />展开可见节点一层
              </button>
              <button
                type="button"
                onClick={() => {
                  setExpandedNodeIds(new Set([resolvedRootId]));
                  setSelectedNodeId(resolvedRootId);
                }}
              >
                <RotateCcw size={14} />收起到起点
              </button>
            </section>

            <section className="relation-boundary-note">
              <CircleDot size={14} />
              <p>每个节点最多展开 18 条关系，整张画布最多 64 个节点。达到边界时会明确标记。</p>
            </section>

            {projection.truncated ? (
              <p className="relation-truncated-note">
                当前还有 {projection.hiddenRelations} 条关系未显示；可收起分支或调整筛选。
              </p>
            ) : null}
          </aside>

          <main ref={canvasRef} className="relation-explorer-canvas">
            <ReactFlow
              key={resolvedRootId}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, flowNode) => setSelectedNodeId(flowNode.id)}
              onNodeDoubleClick={(_, flowNode) => {
                if (flowNode.id !== resolvedRootId) toggleExpanded(flowNode.id);
              }}
              onNodeDrag={(_, dragged) => {
                if (!magnetEnabled) return;
                setNodes((current) => repelNodeCollisions(
                  current.map((candidate) => candidate.id === dragged.id
                    ? { ...candidate, position: dragged.position }
                    : candidate),
                  dragged.id,
                  { gap: profile.gap },
                ));
              }}
              onNodeDragStop={(_, dragged) => {
                if (!magnetEnabled) return;
                setNodes((current) => {
                  const moved = current.map((candidate) => candidate.id === dragged.id
                    ? { ...candidate, position: dragged.position }
                    : candidate);
                  return magnetizeNode(
                    repelNodeCollisions(moved, dragged.id, { gap: profile.gap }),
                    dragged.id,
                    profile,
                  );
                });
              }}
              nodesConnectable={false}
              deleteKeyCode={null}
              minZoom={0.2}
              maxZoom={1.8}
              fitView
              fitViewOptions={fitViewOptions}
              onInit={(instance) => {
                flowRef.current = instance;
                window.requestAnimationFrame(() => {
                  window.requestAnimationFrame(() => void instance.fitView(fitViewOptions));
                });
              }}
              proOptions={{ hideAttribution: true }}
              colorMode="light"
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#c8d2d2" />
              <Controls position="bottom-left" showInteractive={false} aria-label="关系画布缩放控制" />
              <MiniMap
                position="top-left"
                pannable
                zoomable
                nodeStrokeWidth={2}
                nodeColor={(flowNode) => {
                  const owner = (flowNode.data as RelationFlowNode["data"]).record.owner;
                  return owner === "jiuwenswarm" ? "#8f7bc4" : "#5b9fa5";
                }}
                maskColor="rgba(242, 245, 245, 0.72)"
              />
              <Panel position="top-right" className="relation-explorer-magnet">
                <MagnetControls
                  enabled={magnetEnabled}
                  strength={magnetStrength}
                  onToggle={onToggleMagnet}
                  onStrengthChange={onMagnetStrengthChange}
                />
              </Panel>
            </ReactFlow>
          </main>

          <aside className="relation-explorer-inspector" aria-label="关系节点详情">
            <header>
              <span><Box size={16} /></span>
              <div><small>SELECTED NODE</small><strong>{selectedNode.label}</strong></div>
              <code>{selectedNode.kind}</code>
            </header>
            <div className="relation-explorer-inspector__scroll">
              <section>
                <h3>定义证据</h3>
                <p>{selectedNode.summary}</p>
                <dl>
                  <div><dt>owner</dt><dd>{selectedNode.owner}</dd></div>
                  <div><dt>path</dt><dd><code>{selectedSource?.path ?? "—"}</code></dd></div>
                  <div><dt>symbol</dt><dd><code>{selectedSource?.symbol ?? "—"}</code></dd></div>
                  <div><dt>lines</dt><dd><code>{selectedSource?.startLine ? `${selectedSource.startLine}–${selectedSource.endLine ?? selectedSource.startLine}` : "—"}</code></dd></div>
                </dl>
                {selectedSource ? <SourceViewer repositoryPath={repositoryPath} source={selectedSource} /> : null}
                {selectedNode.id !== resolvedRootId ? (
                  <button className="relation-use-root" type="button" onClick={() => useAsRoot(selectedNode.id)}>
                    <LocateFixed size={13} />设为探索起点
                  </button>
                ) : null}
              </section>

              <section>
                <h3>当前可见关系</h3>
                <div className="relation-visible-list">
                  {selectedEdges.map((edge) => {
                    const peerId = peerFor(edge, selectedNode.id);
                    const peer = index.nodesById.get(peerId);
                    const incoming = edge.target === selectedNode.id;
                    return (
                      <button type="button" key={edge.id} onClick={() => setSelectedNodeId(peerId)}>
                        <code>{incoming ? "←" : "→"} {edge.kind}</code>
                        <span>{peer?.label ?? peerId}</span>
                      </button>
                    );
                  })}
                  {selectedEdges.length === 0 ? <p>当前筛选下没有已显示关系。</p> : null}
                </div>
              </section>
            </div>
          </aside>
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      <button ref={triggerRef} type="button" className="relation-explorer-trigger" onClick={openExplorer}>
        <GitFork size={13} />{buttonLabel}
      </button>
      {dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
