import { useEffect, type FormEvent } from "react";
import {
  Braces,
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
import { MagnetControls } from "./features/trace-graph";
import { RuntimeBadge } from "./shared/ui/RuntimeBadge";
import { useReplayStore } from "./state/replay-store";

export default function App() {
  const {
    scenarioId,
    stepIndex,
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
    nextStep,
    previousStep,
    jumpToStep,
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
  const scenario = getScenario(scenarioId);
  const step = scenario.steps[stepIndex];
  const railCanvasDefinition = graphNodes.find(
    (node) => node.id === railCanvasRailId && node.type === "rail",
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
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
  }, [nextStep, previousStep]);

  function submitRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startRun();
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
            <small>Agent execution workbench</small>
          </span>
          <span className="mode-badge">
            <span />
            SINGLE AGENT
          </span>
        </div>

        <form className="run-composer" onSubmit={submitRun}>
          <label className="sr-only" htmlFor="simulation-input">
            模拟输入
          </label>
          <span className="run-composer__icon" aria-hidden="true">
            <Braces size={17} strokeWidth={1.8} />
          </span>
          <input
            id="simulation-input"
            value={draftInput}
            onChange={(event) => setDraftInput(event.target.value)}
            placeholder="输入一段文字，按确定性轨迹模拟运行"
            autoComplete="off"
          />
          <button type="submit" className="run-button">
            <Play size={16} strokeWidth={2} fill="currentColor" aria-hidden="true" />
            开始模拟
          </button>
        </form>

        <div className="runtime-key" aria-label="节点来源颜色图例">
          <span className="runtime-key__label">NODE SOURCE</span>
          <RuntimeBadge owner="agent-core" />
          <RuntimeBadge owner="jiuwenswarm" />
        </div>
      </header>

      <div className="content-shell">
        <section className="stage-column">
          <ScenarioTabs
            scenarios={scenarios}
            activeId={scenarioId}
            onChange={setScenario}
          />
          <div className="scenario-note">
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
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
            playbackRevision={playbackRevision}
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
            runInput={runInput}
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
          runInput={runInput}
          open={contextOpen}
          onToggle={toggleContext}
        />
      </div>

      {railCanvasDefinition?.type === "rail" ? (
        <RailDecisionCanvas
          key={railCanvasDefinition.id}
          definition={railCanvasDefinition}
          scenario={scenario}
          currentStepIndex={stepIndex}
          runInput={runInput}
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
