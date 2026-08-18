import type { TraceScenario } from "../types/trace";
import { graphEdges, graphNodes } from "../domain/trace/graph";
import { compression } from "./scenarios/context-compression";
import { directResponse } from "./scenarios/direct-response";
import { guardrailRetry } from "./scenarios/guardrail-retry";
import { toolLoop } from "./scenarios/tool-loop";

export { graphEdges, graphNodes };

export const scenarios: TraceScenario[] = [
  toolLoop,
  directResponse,
  compression,
  guardrailRetry,
];

export function getScenario(id: string): TraceScenario {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0];
}
