// Compatibility entry point for existing imports. New graph sources should be
// contributed through a plugin and resolved by the default workbench.
import {
  defaultTraceGraph,
  defaultWorkbench,
} from "../../workbench/default-workbench";

export const graphNodes = defaultTraceGraph.nodes;
export const graphEdges = defaultTraceGraph.edges;
export const traceGraph = defaultTraceGraph;
export const workbench = defaultWorkbench;
