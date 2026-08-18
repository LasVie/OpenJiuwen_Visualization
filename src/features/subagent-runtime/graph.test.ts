import { describe, expect, it } from "vitest";
import type { SubagentExecution } from "./model";
import { buildSubagentExecutionGraph } from "./graph";

const execution: SubagentExecution = {
  id: "invoke:one",
  invocationId: "invoke:one",
  subjectId: "subagent:one",
  label: "Explore",
  observation: {
    invocationId: "invoke:one",
    subagentType: "explore_agent",
    dispatcher: "task-tool",
    runMode: "foreground",
    parentSessionId: "parent",
    sessionId: "child",
    contextOwnerId: "ctx:child",
    sessionPolicy: "ephemeral",
    workspaceIsolation: "subdirectory",
    toolPolicy: "configured",
  },
  status: "completed",
  startSequence: 2,
  endSequence: 6,
  eventCount: 4,
  contextMessageCount: 1,
  tokenUsed: 12,
  stages: [
    {
      id: "dispatch",
      kind: "dispatch",
      label: "task-tool",
      summary: "dispatch",
      status: "completed",
      firstSequence: 1,
      lastSequence: 7,
      spanId: "dispatch-span",
      eventKinds: ["tool.call"],
      eventIds: ["dispatch"],
      details: [],
    },
    {
      id: "session",
      kind: "session",
      label: "child",
      summary: "session",
      status: "completed",
      firstSequence: 2,
      lastSequence: 2,
      spanId: "subagent-span",
      parentSpanId: "dispatch-span",
      eventKinds: ["swarm.subagent"],
      eventIds: ["start"],
      details: [],
    },
    {
      id: "model",
      kind: "model",
      label: "model",
      summary: "model",
      status: "completed",
      firstSequence: 4,
      lastSequence: 5,
      spanId: "model-span",
      parentSpanId: "subagent-span",
      eventKinds: ["model.call"],
      eventIds: ["model-start", "model-end"],
      details: [],
    },
    {
      id: "result",
      kind: "result",
      label: "return",
      summary: "done",
      status: "completed",
      firstSequence: 6,
      lastSequence: 6,
      spanId: "subagent-span",
      parentSpanId: "dispatch-span",
      eventKinds: ["swarm.subagent"],
      eventIds: ["end"],
      details: [],
    },
  ],
};

describe("Subagent execution graph", () => {
  it("reveals stages by runtime sequence and preserves nesting edges", () => {
    const partial = buildSubagentExecutionGraph(execution, 4);
    expect(partial.nodes.map((node) => node.id)).toEqual([
      "dispatch",
      "session",
      "model",
    ]);
    expect(partial.edges.map((edge) => [edge.source, edge.target]))
      .toEqual(expect.arrayContaining([
        ["dispatch", "session"],
        ["session", "model"],
      ]));

    const complete = buildSubagentExecutionGraph(execution, 6);
    expect(complete.nodes.map((node) => node.id)).toContain("result");
    expect(complete.edges.find((edge) => edge.target === "result")?.source)
      .toBe("model");
  });
});
