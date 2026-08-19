import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Box,
  Braces,
  Database,
  GitCompareArrows,
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
import { projectTraceGraph } from "./domain/trace/projection";
import { RailDecisionCanvas } from "./features/rail-review";
import {
  SubagentExecutionCanvas,
  projectSubagentExecutions,
} from "./features/subagent-runtime";
import { DefinitionWorkspace } from "./features/definition-plane";
import { ChangeWorkspace } from "./features/change-plane";
import {
  CoreRuntimeSessionBar,
  RuntimeSourceToggle,
  useCoreRuntimeSession,
  type RuntimeSourceMode,
} from "./features/core-runtime";
import { MagnetControls } from "./features/trace-graph";
import { ModelRuntimePanel, projectModelRuntime } from "./features/model-runtime";
import {
  AgentCoreRuntimeLauncher,
  useAgentCoreExecution,
} from "./features/agent-core-execution";
import {
  PluginControlWorkspace,
  usePluginWorkbench,
  workbenchAvailability,
} from "./features/plugin-control";
import {
  SwarmContextScopeBar,
  SwarmRuntimeSessionBar,
  useSwarmRuntimeSession,
} from "./features/swarm-runtime";
import { RuntimeBadge } from "./shared/ui/RuntimeBadge";
import { useReplayStore } from "./state/replay-store";
import { defaultWorkbench } from "./workbench/default-workbench";

const SwarmFlowCanvas = lazy(() =>
  import("./features/swarm-runtime/SwarmFlowCanvas").then((module) => ({
    default: module.SwarmFlowCanvas,
  })),
);
const SwarmRuntimeInspector = lazy(() =>
  import("./features/swarm-runtime/SwarmRuntimeInspector").then((module) => ({
    default: module.SwarmRuntimeInspector,
  })),
);

type WorkbenchMode = "runtime" | "definition" | "change" | "modules";

export default function App() {
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>("runtime");
  const [runtimeSource, setRuntimeSource] =
    useState<RuntimeSourceMode>("fixture");
  const [coreTraceLabel, setCoreTraceLabel] = useState("Agent Core local run");
  const [swarmTraceLabel, setSwarmTraceLabel] = useState("JiuwenSwarm local run");
  const [liveStepIndex, setLiveStepIndex] = useState(0);
  const [followLive, setFollowLive] = useState(true);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [swarmRecordingLoading, setSwarmRecordingLoading] = useState(false);
  const [swarmRecordingError, setSwarmRecordingError] = useState<string | null>(null);
  const [subagentCanvasSubjectId, setSubagentCanvasSubjectId] = useState<string | null>(null);
  const pluginWorkbench = usePluginWorkbench();
  const { workbench } = pluginWorkbench;
  const availability = useMemo(
    () => workbenchAvailability(workbench),
    [workbench],
  );
  const traceGraph = useMemo(
    () => projectTraceGraph(workbench.graph),
    [workbench.graph],
  );
  const defaultModelRecording = workbench.modelRecordings[0];
  const defaultSwarmRecording = workbench.runtimeRecordings.find(
    (recording) => recording.owner === "jiuwenswarm",
  );
  const coreRuntime = useCoreRuntimeSession();
  const swarmRuntime = useSwarmRuntimeSession();
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
  const createAgentCoreTrace = useCallback(async (label: string) => {
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    closeRailCanvas();
    setCoreTraceLabel(label);
    return coreRuntime.startSession(label);
  }, [
    closeRailCanvas,
    coreRuntime.startSession,
    inspectorOpen,
    selectNode,
    toggleInspector,
  ]);
  const agentCoreExecution = useAgentCoreExecution({
    enabled: availability.agentCoreExecution,
    createTrace: createAgentCoreTrace,
    trace: coreRuntime.trace,
    traceClient: coreRuntime.client,
  });
  const runtimeSourceAvailability = useMemo<
    Readonly<Record<RuntimeSourceMode, boolean>>
  >(() => ({
    fixture: availability.runtimeSources.fixture,
    "core-runtime": availability.runtimeSources.core,
    "swarm-runtime": availability.runtimeSources.swarm,
  }), [availability.runtimeSources]);
  const fixtureScenario = workbench.scenarios.find(
    (item) => item.id === scenarioId,
  ) ?? workbench.scenarios[0] ?? defaultWorkbench.scenarios[0]!;
  const scenario = runtimeSource === "core-runtime"
    ? coreRuntime.scenario
    : runtimeSource === "swarm-runtime"
      ? swarmRuntime.scenario
      : fixtureScenario;
  const liveLastStep = Math.max(0, scenario.steps.length - 1);
  const stepIndex = runtimeSource === "fixture"
    ? fixtureStepIndex
    : Math.min(liveStepIndex, liveLastStep);
  const step = scenario.steps[stepIndex];
  const activeRunInput = runtimeSource === "fixture"
    ? runInput
    : runtimeSource === "core-runtime"
      ? agentCoreExecution.lastInput
      : "";
  const runtimeEventCount = runtimeSource === "core-runtime"
    ? coreRuntime.events.length
    : runtimeSource === "swarm-runtime"
      ? swarmRuntime.events.length
      : 0;
  const activeRuntimeEvents = runtimeSource === "core-runtime"
    ? coreRuntime.events
    : runtimeSource === "swarm-runtime"
      ? swarmRuntime.events
      : [];
  const modelProjection = useMemo(
    () => projectModelRuntime(
      availability.modelRuntime ? activeRuntimeEvents : [],
      availability.modelRuntime
        ? activeRuntimeEvents[stepIndex]?.sequence ?? 0
        : 0,
    ),
    [activeRuntimeEvents, availability.modelRuntime, stepIndex],
  );
  const currentSwarmSequence = runtimeSource === "swarm-runtime"
    ? swarmRuntime.events[stepIndex]?.sequence ?? 0
    : 0;
  const subagentExecutions = useMemo(
    () => availability.subagentRuntime
      ? projectSubagentExecutions(
          swarmRuntime.events.filter(
            (event) => event.sequence <= currentSwarmSequence,
          ),
        )
      : [],
    [availability.subagentRuntime, currentSwarmSequence, swarmRuntime.events],
  );
  const subagentCanvasExecution = subagentExecutions.find(
    (execution) => execution.subjectId === subagentCanvasSubjectId,
  );
  const railCanvasDefinition = traceGraph.nodes.find(
    (node) => node.id === railCanvasRailId && node.type === "rail",
  );

  useEffect(() => {
    if (runtimeSourceAvailability[runtimeSource]) return;
    const fallback = (Object.entries(runtimeSourceAvailability) as Array<
      [RuntimeSourceMode, boolean]
    >).find(([, available]) => available)?.[0];
    if (fallback) changeRuntimeSource(fallback);
  }, [runtimeSource, runtimeSourceAvailability]);

  useEffect(() => {
    const currentModeAvailable =
      workbenchMode === "modules" ||
      (workbenchMode === "runtime" && availability.runtime) ||
      (workbenchMode === "definition" && availability.definition) ||
      (workbenchMode === "change" && availability.change);
    if (!currentModeAvailable) setWorkbenchMode("modules");
  }, [availability.change, availability.definition, availability.runtime, workbenchMode]);

  useEffect(() => {
    if (runtimeSource === "fixture") return;
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
    if (agentCoreExecution.active) return;
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    closeRailCanvas();
    await coreRuntime.startSession(coreTraceLabel.trim() || "Agent Core local run");
  }

  async function loadModelRecording() {
    if (!defaultModelRecording || agentCoreExecution.active) return;
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    closeRailCanvas();
    setRecordingLoading(true);
    setRecordingError(null);
    setCoreTraceLabel(defaultModelRecording.label);
    try {
      const created = await coreRuntime.startSession(defaultModelRecording.label);
      if (!created) return;
      await coreRuntime.client.appendEvents(
        created.trace.id,
        created.writeToken,
        defaultModelRecording.events,
      );
    } catch (caught) {
      setRecordingError(
        caught instanceof Error ? caught.message : "无法载入模型录制。",
      );
    } finally {
      setRecordingLoading(false);
    }
  }

  async function createSwarmTrace() {
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    closeRailCanvas();
    setSubagentCanvasSubjectId(null);
    setSwarmRecordingError(null);
    await swarmRuntime.startSession(
      swarmTraceLabel.trim() || "JiuwenSwarm local run",
    );
  }

  async function loadSwarmRecording() {
    if (!defaultSwarmRecording) return;
    setLiveStepIndex(0);
    setFollowLive(true);
    selectNode(null);
    closeRailCanvas();
    setSubagentCanvasSubjectId(null);
    setSwarmRecordingLoading(true);
    setSwarmRecordingError(null);
    setSwarmTraceLabel(defaultSwarmRecording.label);
    try {
      const created = await swarmRuntime.startSession(defaultSwarmRecording.label);
      if (!created) return;
      await swarmRuntime.client.appendEvents(
        created.trace.id,
        created.writeToken,
        defaultSwarmRecording.events,
      );
    } catch (caught) {
      setSwarmRecordingError(
        caught instanceof Error ? caught.message : "无法载入 Subagent 录制。",
      );
    } finally {
      setSwarmRecordingLoading(false);
    }
  }

  function changeRuntimeSource(value: RuntimeSourceMode) {
    setRuntimeSource(value);
    closeRailCanvas();
    setSubagentCanvasSubjectId(null);
    selectNode(null);
    if (inspectorOpen) toggleInspector();
    if (value !== "fixture") {
      setLiveStepIndex(0);
      setFollowLive(true);
    }
  }

  function submitRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (runtimeSource === "core-runtime") {
      void createCoreTrace();
    } else if (runtimeSource === "swarm-runtime") {
      void createSwarmTrace();
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
            disabled={!availability.runtime}
          >
            <Activity size={15} />
            <span><strong>运行链路</strong><small>RUNTIME</small></span>
          </button>
          <button
            type="button"
            className={workbenchMode === "definition" ? "workbench-mode--active" : ""}
            onClick={() => setWorkbenchMode("definition")}
            aria-pressed={workbenchMode === "definition"}
            disabled={!availability.definition}
          >
            <Database size={15} />
            <span><strong>定义图</strong><small>DEFINITION</small></span>
          </button>
          <button
            type="button"
            className={workbenchMode === "change" ? "workbench-mode--active" : ""}
            onClick={() => setWorkbenchMode("change")}
            aria-pressed={workbenchMode === "change"}
            disabled={!availability.change}
          >
            <GitCompareArrows size={15} />
            <span><strong>变更图</strong><small>CHANGE</small></span>
          </button>
          <button
            type="button"
            className={workbenchMode === "modules" ? "workbench-mode--active" : ""}
            onClick={() => setWorkbenchMode("modules")}
            aria-pressed={workbenchMode === "modules"}
          >
            <Box size={15} />
            <span><strong>模块</strong><small>MODULES</small></span>
          </button>
        </nav>

        {workbenchMode === "runtime" ? (
          <form className="run-composer" onSubmit={submitRun}>
            <label className="sr-only" htmlFor="simulation-input">
              {runtimeSource === "fixture" ? "模拟输入" : "Trace 标签"}
            </label>
            <span className="run-composer__icon" aria-hidden="true">
              <Braces size={17} strokeWidth={1.8} />
            </span>
            <input
              id="simulation-input"
              value={runtimeSource === "core-runtime"
                ? coreTraceLabel
                : runtimeSource === "swarm-runtime"
                  ? swarmTraceLabel
                  : draftInput}
              onChange={(event) => runtimeSource === "core-runtime"
                ? setCoreTraceLabel(event.target.value)
                : runtimeSource === "swarm-runtime"
                  ? setSwarmTraceLabel(event.target.value)
                  : setDraftInput(event.target.value)}
              placeholder={runtimeSource === "fixture"
                ? "输入一段文字，按确定性轨迹模拟运行"
                : runtimeSource === "core-runtime"
                  ? "填写 Trace 标签；真实 DeepAgent 从 Agent Core 面板显式启动"
                  : "填写 Trace 标签；采集器不会执行 Swarm 或模型"}
              autoComplete="off"
            />
            <button
              type="submit"
              className="run-button"
              disabled={
                runtimeSource === "core-runtime"
                  ? coreRuntime.connection === "creating"
                    || agentCoreExecution.active
                  : runtimeSource === "swarm-runtime"
                    ? swarmRuntime.connection === "creating"
                    : false
              }
            >
              <Play size={16} strokeWidth={2} fill="currentColor" aria-hidden="true" />
              {runtimeSource === "fixture" ? "开始模拟" : "开始监听"}
            </button>
          </form>
        ) : workbenchMode === "definition" ? (
          <div className="definition-header-summary">
            <Database size={17} />
            <span>
              <strong>Repository Definition Plane</strong>
              <small>本地 AST 索引 · 分层加载 · 源码证据</small>
            </span>
          </div>
        ) : workbenchMode === "change" ? (
          <div className="definition-header-summary change-header-summary">
            <GitCompareArrows size={17} />
            <span>
              <strong>Git Change Plane</strong>
              <small>工作树 / commit refs / GitHub PR · 节点影响映射 · 只读</small>
            </span>
          </div>
        ) : (
          <div className="definition-header-summary module-header-summary">
            <Box size={17} />
            <span>
              <strong>Module Control Plane</strong>
              <small>插件开关 · 依赖解析 · 浏览器持久化</small>
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
        <section className={[
          "stage-column",
          runtimeSource === "swarm-runtime" ? "stage-column--swarm" : "",
          modelProjection.invocations.length ? "stage-column--model" : "",
        ].filter(Boolean).join(" ")}>
          {runtimeSource === "fixture" ? (
            <ScenarioTabs
              scenarios={workbench.scenarios}
              activeId={scenarioId}
              onChange={setScenario}
            />
          ) : runtimeSource === "core-runtime" ? (
            <CoreRuntimeSessionBar
              created={coreRuntime.created}
              trace={coreRuntime.trace}
              connection={coreRuntime.connection}
              error={coreRuntime.error}
              onCreate={() => void createCoreTrace()}
              onLoadRecording={() => void loadModelRecording()}
              recordingLabel={defaultModelRecording?.label ?? "无可用模型录制"}
              recordingAvailable={Boolean(defaultModelRecording)}
              recordingLoading={recordingLoading}
              recordingError={recordingError}
              providerBusy={agentCoreExecution.active}
              providerAction={availability.agentCoreExecution ? (
                <AgentCoreRuntimeLauncher controller={agentCoreExecution} />
              ) : null}
            />
          ) : (
            <SwarmRuntimeSessionBar
              created={swarmRuntime.created}
              trace={swarmRuntime.trace}
              connection={swarmRuntime.connection}
              error={swarmRuntime.error}
              onCreate={() => void createSwarmTrace()}
              onLoadRecording={() => void loadSwarmRecording()}
              recordingLabel={defaultSwarmRecording?.label ?? "无可用 Subagent 录制"}
              recordingAvailable={Boolean(defaultSwarmRecording)}
              recordingLoading={swarmRecordingLoading}
              recordingError={swarmRecordingError}
            />
          )}
          <div className="scenario-note">
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
            <RuntimeSourceToggle
              value={runtimeSource}
              available={runtimeSourceAvailability}
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
          {runtimeSource === "swarm-runtime" ? (
            <SwarmContextScopeBar
              scopes={swarmRuntime.projection.contextScopes}
              activeId={swarmRuntime.contextOwnerId}
              activeTokenUsed={step.tokenUsed}
              stepIndex={stepIndex}
              onChange={swarmRuntime.setContextOwnerId}
            />
          ) : null}
          {modelProjection.invocations.length ? (
            <ModelRuntimePanel projection={modelProjection} />
          ) : null}
          {runtimeSource === "swarm-runtime" ? (
            <Suspense fallback={<div className="swarm-runtime-loading">加载 Swarm 层级画布…</div>}>
              <SwarmFlowCanvas
                projection={swarmRuntime.projection}
                stepIndex={stepIndex}
                selectedNodeId={selectedNodeId}
                viewMode={viewMode}
                activeContextOwnerId={swarmRuntime.contextOwnerId}
                onSelectNode={selectNode}
                onActivateContext={swarmRuntime.setContextOwnerId}
                onOpenSubagent={setSubagentCanvasSubjectId}
                magnetEnabled={magnetEnabled}
                magnetStrength={magnetStrength}
              />
            </Suspense>
          ) : (
            <FlowCanvas
              graphNodes={traceGraph.nodes}
              graphEdges={traceGraph.edges}
              scenario={scenario}
              stepIndex={stepIndex}
              playbackRevision={playbackRevision + runtimeEventCount}
              selectedNodeId={selectedNodeId}
              viewMode={viewMode}
              deepAgentExpanded={deepAgentExpanded}
              onExpandDeepAgent={expandDeepAgent}
              onSelectNode={selectNode}
              onOpenRail={openRailCanvas}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
            />
          )}
          {runtimeSource === "swarm-runtime" ? (
            <Suspense fallback={<div className="inspector inspector--collapsed swarm-runtime-loading">加载步骤详情…</div>}>
              <SwarmRuntimeInspector
                projection={swarmRuntime.projection}
                step={step}
                stepIndex={stepIndex}
                selectedNodeId={selectedNodeId}
                open={inspectorOpen}
                onToggle={toggleInspector}
              />
            </Suspense>
          ) : (
            <InspectorPanel
              graphNodes={traceGraph.nodes}
              step={step}
              selectedNodeId={selectedNodeId}
              runInput={activeRunInput}
              open={inspectorOpen}
              onToggle={toggleInspector}
            />
          )}
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
          scopeLabel={runtimeSource === "swarm-runtime"
            ? swarmRuntime.projection.contextScopes.find(
                (scope) => scope.id === swarmRuntime.contextOwnerId,
              )?.label
            : undefined}
        />
      </div> : workbenchMode === "definition" ? (
        <DefinitionWorkspace
          runtimeEvents={activeRuntimeEvents}
          toolsEnabled={availability.tools}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={toggleMagnet}
          onMagnetStrengthChange={setMagnetStrength}
        />
      ) : workbenchMode === "change" ? (
        <ChangeWorkspace
          changeSources={workbench.changeSources}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={toggleMagnet}
          onMagnetStrengthChange={setMagnetStrength}
        />
      ) : (
        <PluginControlWorkspace
          plugins={workbench.plugins}
          hasOverrides={pluginWorkbench.hasOverrides}
          onSetEnabled={pluginWorkbench.setPluginEnabled}
          onReset={pluginWorkbench.resetPluginStates}
        />
      )}

      {workbenchMode === "runtime" &&
      runtimeSource !== "swarm-runtime" &&
      availability.railReview &&
      railCanvasDefinition?.type === "rail" ? (
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
      {workbenchMode === "runtime" &&
      runtimeSource === "swarm-runtime" &&
      availability.subagentRuntime &&
      subagentCanvasExecution ? (
        <SubagentExecutionCanvas
          key={subagentCanvasExecution.invocationId}
          execution={subagentCanvasExecution}
          throughSequence={currentSwarmSequence}
          onClose={() => setSubagentCanvasSubjectId(null)}
          onActivateContext={swarmRuntime.setContextOwnerId}
          onPrevious={previousStep}
          onNext={nextStep}
          canPrevious={stepIndex > 0}
          canNext={stepIndex < liveLastStep}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={toggleMagnet}
          onMagnetStrengthChange={setMagnetStrength}
        />
      ) : null}
    </div>
  );
}
