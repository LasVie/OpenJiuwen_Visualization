import type { TraceScenario } from "../types/trace";
import {
  defaultTraceGraph,
  defaultWorkbench,
} from "../workbench/default-workbench";

export const graphNodes = defaultTraceGraph.nodes;
export const graphEdges = defaultTraceGraph.edges;
export const scenarios: readonly TraceScenario[] = defaultWorkbench.scenarios;
export const installedPlugins = defaultWorkbench.plugins;

export function getScenario(id: string): TraceScenario {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0];
}
