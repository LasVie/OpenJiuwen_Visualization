import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowLeft,
  Braces,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Network,
  Sparkles,
  X,
} from "lucide-react";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import {
  MagnetControls,
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../trace-graph";
import {
  buildSubagentExecutionGraph,
  type SubagentExecutionFlowEdge,
  type SubagentExecutionFlowNode,
} from "./graph";
import type { SubagentExecution } from "./model";
import { visibleSubagentStages } from "./model";
import { SubagentExecutionNode } from "./SubagentExecutionNode";

interface SubagentExecutionCanvasProps {
  execution: SubagentExecution;
  throughSequence: number;
  onClose: () => void;
  onActivateContext: (contextOwnerId: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

const nodeTypes = {
  subagentExecution: SubagentExecutionNode,
} satisfies NodeTypes;

export function SubagentExecutionCanvas({
  execution,
  throughSequence,
  onClose,
  onActivateContext,
  onPrevious,
  onNext,
  canPrevious,
  canNext,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: SubagentExecutionCanvasProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const flowInstanceRef = useRef<
    ReactFlowInstance<SubagentExecutionFlowNode, SubagentExecutionFlowEdge> | null
  >(null);
  const fitAfterMeasurementsRef = useRef(true);
  const graph = useMemo(
    () => buildSubagentExecutionGraph(execution, throughSequence),
    [execution, throughSequence],
  );
  const visibleStages = useMemo(
    () => visibleSubagentStages(execution, throughSequence),
    [execution, throughSequence],
  );
  const [nodes, setNodes, onNodesChange] =
    useNodesState<SubagentExecutionFlowNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] =
    useEdgesState<SubagentExecutionFlowEdge>(graph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState(graph.nodes[0]?.id ?? "");
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const magnetProfile = useMemo(
    () => magneticProfile(magnetStrength),
    [magnetStrength],
  );
  const fitViewOptions = useMemo(() => ({
    padding: 0.16,
    minZoom: 0.34,
    maxZoom: 0.96,
    duration: 260,
  }), []);
  const currentStatus = visibleStages.some((stage) => stage.kind === "result")
    ? execution.status
    : "running";

  useEffect(() => {
    const firstId = graph.nodes[0]?.id ?? "";
    const nextSelected = graph.nodes.some((node) => node.id === selectedNodeId)
      ? selectedNodeId
      : firstId;
    setSelectedNodeId(nextSelected);
    setNodes((current) => {
      const previousById = new Map(current.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const previous = previousById.get(node.id);
        return {
          ...node,
          position: previous?.position ?? node.position,
          measured: previous?.measured,
          selected: node.id === nextSelected,
        };
      });
    });
    setEdges(graph.edges);
    fitAfterMeasurementsRef.current = true;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void flowInstanceRef.current?.fitView(fitViewOptions);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [fitViewOptions, graph, selectedNodeId, setEdges, setNodes]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("aria-hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function selectNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: node.id === nodeId,
    })));
  }

  function keepDialogKeyboardEvents(event: ReactKeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, button") || target.isContentEditable) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (canPrevious) onPrevious();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      if (canNext) onNext();
    }
  }

  return (
    <div className="subagent-execution-overlay">
      <section
        ref={dialogRef}
        className="subagent-execution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagent-execution-title"
        onKeyDown={keepDialogKeyboardEvents}
      >
        <header className="subagent-execution-dialog__header">
          <button
            type="button"
            className="subagent-execution-dialog__back"
            onClick={onClose}
          >
            <ArrowLeft size={18} strokeWidth={1.9} aria-hidden="true" />
            返回 Swarm 链路
          </button>
          <span className="subagent-execution-dialog__identity" aria-hidden="true">
            <Sparkles size={22} strokeWidth={1.8} />
          </span>
          <div className="subagent-execution-dialog__title">
            <span>SUBAGENT EXECUTION PLANE · RUNTIME TRACE</span>
            <h2 id="subagent-execution-title">{execution.label}</h2>
            <p>{execution.parentLabel ?? execution.parentSubjectId ?? "Parent Agent"} → {execution.observation.dispatcher} → isolated session</p>
          </div>
          <div className="subagent-execution-dialog__meta">
            <RuntimeBadge owner="jiuwenswarm" />
            <span className={`subagent-execution-status subagent-execution-status--${currentStatus}`}>
              {currentStatus.toUpperCase()}
            </span>
            <code>{execution.observation.runMode} · seq {throughSequence}</code>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button subagent-execution-dialog__close"
            onClick={onClose}
            aria-label="关闭 Subagent 执行画布"
            data-tooltip="关闭执行画布"
          >
            <X size={20} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>

        <div className="subagent-execution-strip">
          <div>
            <Network size={16} aria-hidden="true" />
            <span><small>DISPATCH</small><strong>{execution.observation.dispatcher}</strong></span>
          </div>
          <div>
            <GitBranch size={16} aria-hidden="true" />
            <span><small>SESSION</small><strong>{execution.observation.sessionPolicy}</strong></span>
          </div>
          <div>
            <Braces size={16} aria-hidden="true" />
            <span><small>CONTEXT OWNER</small><strong>{execution.observation.contextOwnerId}</strong></span>
          </div>
          <div className="subagent-execution-strip__metrics">
            <span>{visibleStages.length} stages</span>
            <span>{execution.contextMessageCount} messages</span>
            <span>{execution.tokenUsed} tokens</span>
          </div>
          <div className="subagent-execution-strip__steps" role="group" aria-label="Subagent 事件步进">
            <button
              type="button"
              onClick={onPrevious}
              disabled={!canPrevious}
              aria-label="上一个 Subagent 事件"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <code>SEQ {throughSequence}</code>
            <button
              type="button"
              onClick={onNext}
              disabled={!canNext}
              aria-label="下一个 Subagent 事件"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="subagent-execution-dialog__body">
          <main className="subagent-execution-canvas" aria-label="Subagent 独立执行流程画布">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(changes) => {
                onNodesChange(changes);
                if (
                  fitAfterMeasurementsRef.current &&
                  changes.some((change) => change.type === "dimensions")
                ) {
                  fitAfterMeasurementsRef.current = false;
                  window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                      void flowInstanceRef.current?.fitView(fitViewOptions);
                    });
                  });
                }
              }}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, node) => selectNode(node.id)}
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
              nodesConnectable={false}
              deleteKeyCode={null}
              minZoom={0.28}
              maxZoom={1.7}
              fitView
              fitViewOptions={fitViewOptions}
              onInit={(instance) => {
                flowInstanceRef.current = instance;
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
                color="#c9c2dc"
              />
              <Controls
                position="bottom-left"
                showInteractive={false}
                aria-label="Subagent 画布缩放控制"
              />
              <MiniMap
                position="top-center"
                pannable
                zoomable
                style={{ width: 158, height: 96 }}
                nodeColor={(node) => node.data.owner === "jiuwenswarm" ? "#8f7ac4" : "#79aeb5"}
                maskColor="rgba(244, 244, 249, 0.74)"
                aria-label="Subagent 执行流程缩略图"
              />
              <Panel position="top-left">
                <MagnetControls
                  enabled={magnetEnabled}
                  strength={magnetStrength}
                  onToggle={onToggleMagnet}
                  onStrengthChange={onMagnetStrengthChange}
                />
              </Panel>
            </ReactFlow>
          </main>

          <aside className="subagent-execution-evidence" aria-live="polite">
            <header>
              <span>SELECTED STAGE</span>
              <strong>{selectedNode?.data.sequence} · {selectedNode?.data.stage.kind}</strong>
              <h3>{selectedNode?.data.stage.label}</h3>
              <p>{selectedNode?.data.stage.summary}</p>
            </header>
            <div className="subagent-execution-evidence__rows">
              {selectedNode?.data.stage.details.map((detail, index) => (
                <div key={`${detail.label}:${index}`}>
                  <span>{detail.label}</span>
                  <pre>{detail.value}</pre>
                </div>
              ))}
            </div>
            <section className="subagent-execution-isolation">
              <span>ISOLATION BOUNDARY</span>
              <dl>
                <div><dt>parent session</dt><dd>{execution.observation.parentSessionId}</dd></div>
                <div><dt>child session</dt><dd>{execution.observation.sessionId}</dd></div>
                <div><dt>workspace</dt><dd>{execution.observation.workspaceIsolation}</dd></div>
                <div><dt>tools</dt><dd>{execution.observation.toolPolicy}</dd></div>
              </dl>
              <button
                type="button"
                onClick={() => onActivateContext(execution.observation.contextOwnerId)}
              >
                <Braces size={14} aria-hidden="true" />
                将右侧 Context 切到 Subagent
              </button>
            </section>
            <footer>
              <span>源码证据</span>
              <code>{selectedNode?.data.stage.sourceLocation ?? "事件未提供 definition"}</code>
            </footer>
          </aside>
        </div>
      </section>
    </div>
  );
}
