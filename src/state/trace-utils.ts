import type {
  ContextMessage,
  TraceEdgeDefinition,
  TraceNodeDefinition,
  TraceScenario,
  TraceViewMode,
} from "../types/trace";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_PATTERN = /\b(?:sk|ak|api)[-_][A-Za-z0-9_-]{8,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d -]{7,}\d)(?!\d)/g;

export function maskSensitiveText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[邮箱已隐藏]")
    .replace(TOKEN_PATTERN, "[凭据已隐藏]")
    .replace(PHONE_PATTERN, "[号码已隐藏]");
}

export function materializeText(value: string, input: string): string {
  return value.replaceAll("{{input}}", input);
}

export function visibleContextMessages(
  messages: ContextMessage[],
  stepIndex: number,
): ContextMessage[] {
  return messages.filter(
    (message) =>
      message.addedAt <= stepIndex &&
      (message.removedAt === undefined || stepIndex < message.removedAt),
  );
}

export function getVisitedNodeIds(
  scenario: TraceScenario,
  stepIndex: number,
): Set<string> {
  const visited = new Set<string>();
  scenario.steps.slice(0, stepIndex).forEach((step) => {
    step.activeNodeIds.forEach((nodeId) => visited.add(nodeId));
  });
  return visited;
}

export function clampStepIndex(index: number, stepCount: number): number {
  return Math.max(0, Math.min(index, Math.max(0, stepCount - 1)));
}

export function shouldExpandDeepAgent(
  viewMode: TraceViewMode,
  manuallyExpanded: boolean,
  stepIndex: number,
): boolean {
  return viewMode === "micro" || manuallyExpanded || stepIndex > 0;
}

export function validateScenarios(
  scenarios: TraceScenario[],
  nodes: TraceNodeDefinition[],
  edges: TraceEdgeDefinition[],
): string[] {
  const issues: string[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));

  scenarios.forEach((scenario) => {
    if (scenario.steps.length === 0) {
      issues.push(scenario.id + ": trajectory is empty");
    }

    scenario.railNodeIds.forEach((nodeId) => {
      if (!nodeIds.has(nodeId)) {
        issues.push(scenario.id + ": unknown rail node " + nodeId);
      }
    });

    scenario.steps.forEach((step, stepIndex) => {
      step.activeNodeIds.forEach((nodeId) => {
        if (!nodeIds.has(nodeId)) {
          issues.push(scenario.id + "[" + stepIndex + "]: unknown node " + nodeId);
        }
      });
      step.activeEdgeIds.forEach((edgeId) => {
        if (!edgeIds.has(edgeId)) {
          issues.push(scenario.id + "[" + stepIndex + "]: unknown edge " + edgeId);
        }
      });
      if (step.tokenUsed > scenario.maxTokens) {
        issues.push(scenario.id + "[" + stepIndex + "]: token budget exceeded");
      }
    });
  });

  return issues;
}
