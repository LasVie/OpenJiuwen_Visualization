import { create } from "zustand";
import { scenarios } from "../data/scenarios";
import { clampStepIndex } from "./trace-utils";
import type { TraceViewMode } from "../types/trace";

interface ReplayState {
  scenarioId: string;
  stepIndex: number;
  draftInput: string;
  runInput: string;
  contextOpen: boolean;
  inspectorOpen: boolean;
  viewMode: TraceViewMode;
  deepAgentExpanded: boolean;
  selectedNodeId: string | null;
  railCanvasRailId: string | null;
  magnetEnabled: boolean;
  magnetStrength: number;
  playbackRevision: number;
  setScenario: (scenarioId: string) => void;
  setDraftInput: (value: string) => void;
  startRun: () => void;
  nextStep: () => void;
  previousStep: () => void;
  jumpToStep: (index: number) => void;
  setViewMode: (mode: TraceViewMode) => void;
  expandDeepAgent: () => void;
  toggleContext: () => void;
  toggleInspector: () => void;
  selectNode: (nodeId: string | null) => void;
  openRailCanvas: (railId: string) => void;
  closeRailCanvas: () => void;
  toggleMagnet: () => void;
  setMagnetStrength: (strength: number) => void;
}

const initialScenario = scenarios[0];

function scenarioById(id: string) {
  return scenarios.find((scenario) => scenario.id === id) ?? initialScenario;
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  scenarioId: initialScenario.id,
  stepIndex: 0,
  draftInput: initialScenario.defaultInput,
  runInput: initialScenario.defaultInput,
  contextOpen: true,
  inspectorOpen: false,
  viewMode: "macro",
  deepAgentExpanded: false,
  selectedNodeId: null,
  railCanvasRailId: null,
  magnetEnabled: true,
  magnetStrength: 58,
  playbackRevision: 0,

  setScenario: (scenarioId) => {
    const scenario = scenarioById(scenarioId);
    set((state) => ({
      scenarioId: scenario.id,
      stepIndex: 0,
      draftInput: scenario.defaultInput,
      runInput: scenario.defaultInput,
      selectedNodeId: null,
      railCanvasRailId: null,
      inspectorOpen: false,
      deepAgentExpanded: false,
      playbackRevision: state.playbackRevision + 1,
    }));
  },
  setDraftInput: (draftInput) => set({ draftInput }),
  startRun: () => {
    const state = get();
    const scenario = scenarioById(state.scenarioId);
    const runInput = state.draftInput.trim() || scenario.defaultInput;
    set({
      runInput,
      draftInput: runInput,
      stepIndex: 0,
      selectedNodeId: "input",
      railCanvasRailId: null,
      inspectorOpen: false,
      deepAgentExpanded: false,
      playbackRevision: state.playbackRevision + 1,
    });
  },
  nextStep: () => {
    const state = get();
    const scenario = scenarioById(state.scenarioId);
    const next = clampStepIndex(state.stepIndex + 1, scenario.steps.length);
    set({
      stepIndex: next,
      selectedNodeId: scenario.steps[next]?.activeNodeIds[0] ?? null,
      playbackRevision: state.playbackRevision + 1,
    });
  },
  previousStep: () => {
    const state = get();
    const scenario = scenarioById(state.scenarioId);
    const previous = clampStepIndex(state.stepIndex - 1, scenario.steps.length);
    set({
      stepIndex: previous,
      selectedNodeId: scenario.steps[previous]?.activeNodeIds[0] ?? null,
      playbackRevision: state.playbackRevision + 1,
    });
  },
  jumpToStep: (index) => {
    const state = get();
    const scenario = scenarioById(state.scenarioId);
    const next = clampStepIndex(index, scenario.steps.length);
    set({
      stepIndex: next,
      selectedNodeId: scenario.steps[next]?.activeNodeIds[0] ?? null,
      playbackRevision: state.playbackRevision + 1,
    });
  },
  setViewMode: (viewMode) =>
    set({
      viewMode,
      deepAgentExpanded: viewMode === "micro",
      selectedNodeId: null,
      railCanvasRailId: null,
      inspectorOpen: false,
    }),
  expandDeepAgent: () => set({ deepAgentExpanded: true }),
  toggleContext: () => set((state) => ({ contextOpen: !state.contextOpen })),
  toggleInspector: () =>
    set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  selectNode: (selectedNodeId) =>
    set((state) => ({
      selectedNodeId,
      inspectorOpen: selectedNodeId ? true : state.inspectorOpen,
    })),
  openRailCanvas: (railCanvasRailId) =>
    set({
      railCanvasRailId,
      selectedNodeId: railCanvasRailId,
      inspectorOpen: false,
    }),
  closeRailCanvas: () => set({ railCanvasRailId: null }),
  toggleMagnet: () =>
    set((state) => ({ magnetEnabled: !state.magnetEnabled })),
  setMagnetStrength: (magnetStrength) =>
    set({ magnetStrength: Math.min(100, Math.max(1, magnetStrength)) }),
}));
