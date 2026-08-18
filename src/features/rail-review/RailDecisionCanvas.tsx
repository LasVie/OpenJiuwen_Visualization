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
  ChevronLeft,
  ChevronRight,
  GitBranch,
  ScanSearch,
  X,
} from "lucide-react";
import {
  MagnetControls,
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
} from "../trace-graph";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import type {
  RailNodeDefinition,
  TraceScenario,
} from "../../types/trace";
import { buildRailDecisionGraph } from "./decision-graph";
import type {
  RailDecisionFlowEdge,
  RailDecisionFlowNode,
} from "./decision-graph";
import { RailDecisionNode } from "./RailDecisionNode";
import {
  buildRailReviewFrames,
  buildRailReviewSnapshot,
  type RailReviewFrame,
  type RailReviewStatus,
} from "./model";

interface RailDecisionCanvasProps {
  definition: RailNodeDefinition;
  scenario: TraceScenario;
  currentStepIndex: number;
  runInput: string;
  onClose: () => void;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

const nodeTypes = {
  railDecision: RailDecisionNode,
} satisfies NodeTypes;

const statusLabels: Record<RailReviewStatus, string> = {
  waiting: "WAIT",
  reviewing: "CHECKING",
  passed: "PASS",
  changed: "CHANGED",
  blocked: "BLOCKED",
  skipped: "SKIPPED",
};

function nearestFrameIndex(frames: RailReviewFrame[], currentStepIndex: number) {
  const exact = frames.findIndex(
    (frame) => frame.stepIndex === currentStepIndex,
  );
  if (exact >= 0) return exact;

  let nearestPrevious = -1;
  frames.forEach((frame, index) => {
    if (frame.stepIndex <= currentStepIndex) nearestPrevious = index;
  });
  return nearestPrevious >= 0 ? nearestPrevious : 0;
}

export function RailDecisionCanvas({
  definition,
  scenario,
  currentStepIndex,
  runInput,
  onClose,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: RailDecisionCanvasProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const flowInstanceRef = useRef<
    ReactFlowInstance<RailDecisionFlowNode, RailDecisionFlowEdge> | null
  >(null);
  const fitAfterMeasurementsRef = useRef(true);
  const reviewFrames = useMemo(
    () => buildRailReviewFrames(definition, scenario, runInput),
    [definition, runInput, scenario],
  );
  const frames = useMemo(() => {
    if (reviewFrames.length > 0) return reviewFrames;
    const step = scenario.steps[currentStepIndex];
    return [
      {
        id: `${step.id}:preview`,
        stepIndex: currentStepIndex,
        step,
        snapshot: buildRailReviewSnapshot(definition, step, runInput),
      },
    ];
  }, [currentStepIndex, definition, reviewFrames, runInput, scenario.steps]);
  const [frameIndex, setFrameIndex] = useState(() =>
    nearestFrameIndex(frames, currentStepIndex),
  );
  const selectedFrame = frames[Math.min(frameIndex, frames.length - 1)];
  const graph = useMemo(
    () =>
      buildRailDecisionGraph(
        definition,
        selectedFrame.step,
        selectedFrame.snapshot,
      ),
    [definition, selectedFrame],
  );
  const [nodes, setNodes, onNodesChange] =
    useNodesState<RailDecisionFlowNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] =
    useEdgesState<RailDecisionFlowEdge>(graph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState(graph.nodes[0].id);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const magnetProfile = useMemo(
    () => magneticProfile(magnetStrength),
    [magnetStrength],
  );
  const fitViewOptions = useMemo(
    () => ({
      padding: 0.14,
      minZoom: 0.42,
      maxZoom: 0.92,
      duration: 260,
    }),
    [],
  );

  useEffect(() => {
    setSelectedNodeId(graph.nodes[0].id);
    setNodes(
      graph.nodes.map((node, index) => ({ ...node, selected: index === 0 })),
    );
    setEdges(graph.edges);
    fitAfterMeasurementsRef.current = true;
    let secondAnimationFrame = 0;
    const firstAnimationFrame = window.requestAnimationFrame(() => {
      secondAnimationFrame = window.requestAnimationFrame(() => {
        void flowInstanceRef.current?.fitView(fitViewOptions);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstAnimationFrame);
      window.cancelAnimationFrame(secondAnimationFrame);
    };
  }, [fitViewOptions, graph, setEdges, setNodes]);

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

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function selectNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: node.id === nodeId })),
    );
  }

  function handleFrameNavigation(direction: -1 | 1) {
    setFrameIndex((current) =>
      Math.min(frames.length - 1, Math.max(0, current + direction)),
    );
  }

  function keepDialogKeyboardEvents(event: ReactKeyboardEvent) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopPropagation();
    }
  }

  const frameCountLabel = reviewFrames.length
    ? `${reviewFrames.length} 次实际触发`
    : "当前场景无实际触发 · 结构预览";

  return (
    <div className="rail-decision-overlay">
      <section
        ref={dialogRef}
        className="rail-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rail-decision-title"
        onKeyDown={keepDialogKeyboardEvents}
      >
        <header className="rail-decision-dialog__header">
          <button
            type="button"
            className="rail-decision-dialog__back"
            onClick={onClose}
          >
            <ArrowLeft size={18} strokeWidth={1.9} aria-hidden="true" />
            返回主链路
          </button>
          <span className="rail-decision-dialog__identity" aria-hidden="true">
            <ScanSearch size={22} strokeWidth={1.8} />
          </span>
          <div className="rail-decision-dialog__title">
            <span>
              RAIL DECISION WORKBENCH · {scenario.provenance?.kind === "runtime"
                ? "RUNTIME TRACE"
                : "DETERMINISTIC TRACE"}
            </span>
            <h2 id="rail-decision-title">{definition.label}</h2>
            <p>{selectedFrame.snapshot.profile.examines}</p>
          </div>
          <div className="rail-decision-dialog__meta">
            <RuntimeBadge owner={definition.owner} />
            <span
              className={`rail-review-status rail-review-status--${selectedFrame.snapshot.status}`}
            >
              {statusLabels[selectedFrame.snapshot.status]}
            </span>
            <code>{frameCountLabel}</code>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button rail-decision-dialog__close"
            onClick={onClose}
            aria-label="关闭 Rail 决策画布"
            data-tooltip="关闭决策画布"
          >
            <X size={20} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>

        <nav className="rail-invocation-strip" aria-label="Rail 触发帧">
          <div className="rail-invocation-strip__label">
            <GitBranch size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>
              <strong>调用轨迹</strong>
              <small>切换同一 Rail 的每次触发</small>
            </span>
          </div>
          <button
            type="button"
            className="rail-invocation-strip__step"
            onClick={() => handleFrameNavigation(-1)}
            disabled={frameIndex === 0}
            aria-label="上一次 Rail 触发"
          >
            <ChevronLeft size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <div className="rail-invocation-strip__frames">
            {frames.map((frame, index) => (
              <button
                type="button"
                className={[
                  "rail-invocation-frame",
                  `rail-invocation-frame--${frame.snapshot.status}`,
                  index === frameIndex ? "rail-invocation-frame--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={frame.id}
                onClick={() => setFrameIndex(index)}
                aria-pressed={index === frameIndex}
                aria-label={`第 ${index + 1} 次触发，主轨迹第 ${frame.stepIndex + 1} 步，${frame.step.eventCode}`}
              >
                <span>
                  #{String(index + 1).padStart(2, "0")} · STEP {frame.stepIndex + 1}
                </span>
                <strong>{frame.step.eventCode}</strong>
                <small>{statusLabels[frame.snapshot.status]}</small>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rail-invocation-strip__step"
            onClick={() => handleFrameNavigation(1)}
            disabled={frameIndex === frames.length - 1}
            aria-label="下一次 Rail 触发"
          >
            <ChevronRight size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </nav>

        <div className="rail-decision-dialog__body">
          <main className="rail-decision-canvas" aria-label="Rail 决策流程画布">
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
                setNodes((current) => {
                  const withDraggedPosition = current.map((candidate) =>
                    candidate.id === node.id
                      ? { ...candidate, position: node.position }
                      : candidate,
                  );
                  return repelNodeCollisions(
                    withDraggedPosition,
                    node.id,
                    { gap: magnetProfile.gap },
                  );
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
              nodesConnectable={false}
              deleteKeyCode={null}
              minZoom={0.32}
              maxZoom={1.65}
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
                size={1.25}
                color="#c3d1d1"
              />
              <Controls
                position="bottom-left"
                showInteractive={false}
                aria-label="Rail 画布缩放控制"
              />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={(node) =>
                  node.data.status === "blocked"
                    ? "#d88f8f"
                    : node.data.kind === "check"
                      ? "#73aeb3"
                      : "#d4aa73"
                }
                maskColor="rgba(242, 246, 246, 0.72)"
                aria-label="Rail 决策流程缩略图"
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

          <aside className="rail-decision-evidence" aria-live="polite">
            <header>
              <span>SELECTED STAGE</span>
              <strong>
                {selectedNode?.data.sequence} · {selectedNode?.data.phase}
              </strong>
              <h3>{selectedNode?.data.detailTitle}</h3>
            </header>
            <div className="rail-decision-evidence__rows">
              {selectedNode?.data.details.map((detail) => (
                <div key={detail.label}>
                  <span>{detail.label}</span>
                  <pre>{detail.value}</pre>
                </div>
              ))}
            </div>
            <section className="rail-decision-evidence__trace">
              <span>TRACE EVIDENCE</span>
              <strong>{selectedFrame.step.title}</strong>
              <p>{selectedFrame.step.summary}</p>
              <dl>
                <div>
                  <dt>timestamp</dt>
                  <dd>{selectedFrame.step.timestampMs} ms</dd>
                </div>
                <div>
                  <dt>duration</dt>
                  <dd>{selectedFrame.step.durationMs} ms</dd>
                </div>
                <div>
                  <dt>tokens</dt>
                  <dd>{selectedFrame.step.tokenUsed}</dd>
                </div>
              </dl>
            </section>
            <footer>
              <span>实现位置</span>
              <code>{definition.sourceLocation}</code>
            </footer>
          </aside>
        </div>
      </section>
    </div>
  );
}
