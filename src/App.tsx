import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  Braces,
  Database,
  Layers2,
  Play,
  Route,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { ContextPanel } from "./components/ContextPanel";
import { FlowCanvas } from "./components/FlowCanvas";
import { InspectorPanel } from "./components/InspectorPanel";
import { ScenarioTabs } from "./components/ScenarioTabs";
import { TimelineControls } from "./components/TimelineControls";
import { getScenario, graphNodes, scenarios } from "./data/scenarios";
import { RailDecisionCanvas } from "./features/rail-review";
import { RepositoryWorkspace } from "./features/repository-browser";
import {
  CoreRuntimeSessionBar,
  RuntimeSourceToggle,
  useCoreRuntimeSession,
  type RuntimeSourceMode,
} from "./features/core-runtime";
import { MagnetControls } from "./features/trace-graph";
import { RuntimeBadge } from "./shared/ui/RuntimeBadge";
import { useReplayStore } from "./state/replay-store";

export default function App() {
  const [workbenchMode, setWorkbenchMode] = useState<"runtime" | "definition">(
    "runtime",
  );
  const [runtimeSource, setRuntimeSource] =
    useState<RuntimeSourceMode>("fixture");
  const [coreTraceLabel, setCoreTraceLabel] = useState("Agent Core local run");
  const [liveStepIndex, setLiveStepIndex] = useState(0);
  const [followLive, setFollowLive] = useState(true);
  const coreRuntime = useCoreRuntimeSession();
  const {
    scenarioId,
    stepIndex: fixtureStepIndex,
    draftInput,
    runInput,
    contextOpen,
    inspectorOpen,
    viewMode,
    deepAgentExpanded,
    selectedNodeId,
    railCanvasRailId,
    magnetEnabled,
    magnetStrength,
    playbackRevision,
    setScenario,
    setDraftInput,
    startRun,
    nextStep: nextFixtureStep,
    previousStep: previousFixtureStep,
    jumpToStep: jumpToFixtureStep,
    setViewMode,
    expandDeepAgent,
    toggleContext,
    toggleInspector,
    selectNode,
    openRailCanvas,
    closeRailCanvas,
    toggleMagnet,
    setMagnetStrength,
  } = useReplayStore();
  const fixtureScenario = getScenario(scenarioId);
  const scenario = runtimeSource === "core-runtime"
    ? coreRuntime.scenario
    : fixtureScenario;
  const liveLastStep = Math.max(0, scenario.steps.length - 1);
  const stepIndex = runtimeSource === "core-runtime"
    ? Math.min(liveStepIndex, liveLastStep)
    : fixtureStepIndex;
  const step = scenario.steps[stepIndex];
  const activeRunInput = runtimeSource === "core-runtime" ? "" : runInput;
  const railCanvasDefinition = graphNodes.find(
    (node) => node.id === railCanvasRailId && node.type === "rail",
  );

  useEffect(() => {
    if (runtimeSource !== "core-runtime") return;
    setLiveStepIndex((current) => followLive
      ? liveLastStep
      : Math.min(current, liveLastStep));
  }, [followLive, liveLastStep, runtimeSource]);

  function nextStep() {
    if (runtimeSource === "fixture") {
      nextFixtureStep();
      return;
    }
    const next = Math.min(stepIndex + 1, liveLastStep);
    setLiveStepIndex(next);
    setFollowLive(next === liveLastStep);
  }

  function previousStep() {
    if (runtimeSource === "fixture") {
      previousFixtureStep();
      return;
    }
    const previous = Math.max(0, stepIndex - 1);
    setLiveStepIndex(previous);
    setFollowLive(false);
  }

  function jumpToStep(index: number) {
    if (runtimeSource === "fixture") {
      jumpToFixtureStep(index);
      return;
    }
    const next = Math.max(0, Math.min(index, liveLastStep));
    setLiveStepIndex(next);
    setFollowLive(next === liveLastStep);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (workbenchMode !== "runtime") return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, button") ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previousStep();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        nextStep();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runtimeSource, scenario, stepIndex, liveLastStep, workbenchMode]);

  async function createCoreTrace() {
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    closeRailCanvas();
    await coreRuntime.startSession(coreTraceLabel.trim() || "Agent Core local run");
  }

  function changeRuntimeSource(value: RuntimeSourceMode) {
    setRuntimeSource(value);
    closeRailCanvas();
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    if (value === "core-runtime") {
      setLiveStepIndex(0);
      setFollowLive(true);
    }
  }

  function submitRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (runtimeSource === "core-runtime") {
      void createCoreTrace();
    } else {
      startRun();
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <Route size={20} strokeWidth={2} />
          </span>
          <span className="brand__text">
            <strong>OpenJiuwen Trace</strong>
            <small>Architecture & execution workbench</small>
          </span>
        </div>

        <nav className="workbench-mode-switch" aria-label="工作台数据平面">
          <button
            type="button"
            className={workbenchMode === "runtime" ? "workbench-mode--active" : ""}
            onClick={() => setWorkbenchMode("runtime")}
            aria-pressed={workbenchMode === "runtime"}
          >
            <Activity size={15} />
            <span><strong>运行链路</strong><small>RUNTIME</small></span>
          </button>
          <button
            type="button"
            className={workbenchMode === "definition" ? "workbench-mode--active" : ""}
            onClick={() => setWorkbenchMode("definition")}
            aria-pressed={workbenchMode === "definition"}
          >
            <Database size={15} />
            <span><strong>定义图</strong><small>DEFINITION</small></span>
          </button>
        </nav>

        {workbenchMode === "runtime" ? (
          <form className="run-composer" onSubmit={submitRun}>
            <label className="sr-only" htmlFor="simulation-input">
              {runtimeSource === "core-runtime" ? "Trace 标签" : "模拟输入"}
            </label>
            <span className="run-composer__icon" aria-hidden="true">
              <Braces size={17} strokeWidth={1.8} />
            </span>
            <input
              id="simulation-input"
              value={runtimeSource === "core-runtime" ? coreTraceLabel : draftInput}
              onChange={(event) => runtimeSource === "core-runtime"
                ? setCoreTraceLabel(event.target.value)
                : setDraftInput(event.target.value)}
              placeholder={runtimeSource === "core-runtime"
                ? "填写 Trace 标签；采集器不会执行 Agent"
                : "输入一段文字，按确定性轨迹模拟运行"}
              autoComplete="off"
            />
            <button
              type="submit"
              className="run-button"
              disabled={coreRuntime.connection === "creating"}
            >
              <Play size={16} strokeWidth={2} fill="currentColor" aria-hidden="true" />
              {runtimeSource === "core-runtime" ? "开始监听" : "开始模拟"}
            </button>
          </form>
        ) : (
          <div className="definition-header-summary">
            <Database size={17} />
            <span>
              <strong>Repository Definition Plane</strong>
              <small>本地 AST 索引 · 分层加载 · 源码证据</small>
            </span>
          </div>
        )}

        <div className="runtime-key" aria-label="节点来源颜色图例">
          <span className="runtime-key__label">NODE SOURCE</span>
          <RuntimeBadge owner="agent-core" />
          <RuntimeBadge owner="jiuwenswarm" />
        </div>
      </header>

      {workbenchMode === "runtime" ? <div className="content-shell">
        <section className="stage-column">
          {runtimeSource === "fixture" ? (
            <ScenarioTabs
              scenarios={scenarios}
              activeId={scenarioId}
              onChange={setScenario}
            />
          ) : (
            <CoreRuntimeSessionBar
              created={coreRuntime.created}
              trace={coreRuntime.trace}
              connection={coreRuntime.connection}
              error={coreRuntime.error}
              onCreate={() => void createCoreTrace()}
            />
          )}
          <div className="scenario-note">
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
            <RuntimeSourceToggle
              value={runtimeSource}
              onChange={changeRuntimeSource}
            />
            <span>{scenario.description}</span>
            <MagnetControls
              enabled={magnetEnabled}
              strength={magnetStrength}
              onToggle={toggleMagnet}
              onStrengthChange={setMagnetStrength}
            />
            <div className="view-mode-toggle" role="group" aria-label="链路视图模式">
              <button
                type="button"
                className={
                  viewMode === "macro"
                    ? "view-mode-button view-mode-button--active"
                    : "view-mode-button"
                }
                onClick={() => setViewMode("macro")}
                aria-pressed={viewMode === "macro"}
              >
                <Layers2 size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>
                  <strong>宏观</strong>
                  <small>按需展开</small>
                </span>
              </button>
              <button
                type="button"
                className={
                  viewMode === "micro"
                    ? "view-mode-button view-mode-button--active"
                    : "view-mode-button"
                }
                onClick={() => setViewMode("micro")}
                aria-pressed={viewMode === "micro"}
              >
                <Workflow size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>
                  <strong>微观</strong>
                  <small>展开全部</small>
                </span>
              </button>
            </div>
          </div>
          <FlowCanvas
            scenario={scenario}
            stepIndex={stepIndex}
            playbackRevision={playbackRevision + coreRuntime.events.length}
            selectedNodeId={selectedNodeId}
            viewMode={viewMode}
            deepAgentExpanded={deepAgentExpanded}
            onExpandDeepAgent={expandDeepAgent}
            onSelectNode={selectNode}
            onOpenRail={openRailCanvas}
            magnetEnabled={magnetEnabled}
            magnetStrength={magnetStrength}
          />
          <InspectorPanel
            step={step}
            selectedNodeId={selectedNodeId}
            runInput={activeRunInput}
            open={inspectorOpen}
            onToggle={toggleInspector}
          />
          <TimelineControls
            scenario={scenario}
            step={step}
            stepIndex={stepIndex}
            onPrevious={previousStep}
            onNext={nextStep}
            onJump={jumpToStep}
          />
        </section>

        <ContextPanel
          scenario={scenario}
          step={step}
          stepIndex={stepIndex}
          runInput={activeRunInput}
          open={contextOpen}
          onToggle={toggleContext}
        />
      </div> : (
        <RepositoryWorkspace
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={toggleMagnet}
          onMagnetStrengthChange={setMagnetStrength}
        />
      )}

      {workbenchMode === "runtime" && railCanvasDefinition?.type === "rail" ? (
        <RailDecisionCanvas
          key={railCanvasDefinition.id}
          definition={railCanvasDefinition}
          scenario={scenario}
          currentStepIndex={stepIndex}
          runInput={activeRunInput}
          onClose={closeRailCanvas}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={toggleMagnet}
          onMagnetStrengthChange={setMagnetStrength}
        />
      ) : null}
    </div>
  );
}
