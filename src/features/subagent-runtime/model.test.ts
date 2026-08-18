import { describe, expect, it } from "vitest";
import type { RuntimeTraceEvent } from "../../kernel";
import {
  projectSubagentExecutions,
  visibleSubagentStages,
} from "./model";

const subject = {
  id: "subagent:explore",
  kind: "subagent" as const,
  label: "Explore",
  parentId: "member:leader",
  contextOwnerId: "ctx:explore",
};

const observation = {
  invocationId: "invoke:explore",
  subagentType: "explore_agent",
  dispatcher: "task-tool" as const,
  runMode: "foreground" as const,
  parentSessionId: "session:parent",
  sessionId: "session:child",
  contextOwnerId: "ctx:explore",
  sessionPolicy: "ephemeral" as const,
  workspaceIsolation: "subdirectory" as const,
  toolPolicy: "configured" as const,
  toolCallSpanId: "span:dispatch",
};

function runtimeEvent(
  sequence: number,
  input: Omit<RuntimeTraceEvent, "sequence" | "traceId" | "receivedAt">,
): RuntimeTraceEvent {
  return {
    ...input,
    traceId: "tr_subagent",
    sequence,
    receivedAt: `2026-08-18T00:00:${String(sequence).padStart(2, "0")}Z`,
  };
}

describe("Subagent execution projection", () => {
  it("separates dispatch, child session, internal activity and result", () => {
    const parent = {
      id: "member:leader",
      kind: "member" as const,
      label: "Leader",
      contextOwnerId: "ctx:leader",
    };
    const events: RuntimeTraceEvent[] = [
      runtimeEvent(1, {
        eventId: "dispatch",
        kind: "tool.call",
        phase: "start",
        timestampMs: 1,
        spanId: "span:dispatch",
        subject: parent,
        payload: { toolName: "task_tool" },
      }),
      runtimeEvent(2, {
        eventId: "start",
        kind: "swarm.subagent",
        phase: "start",
        timestampMs: 2,
        spanId: "span:subagent",
        parentSpanId: "span:dispatch",
        subject,
        subagent: observation,
      }),
      runtimeEvent(3, {
        eventId: "context",
        kind: "context.snapshot",
        phase: "instant",
        timestampMs: 3,
        spanId: "span:context",
        parentSpanId: "span:subagent",
        subject,
        context: {
          operation: "replace",
          ownerId: "ctx:explore",
          messages: [{
            id: "message",
            role: "user",
            label: "Task",
            raw: "full task",
            tokens: 5,
            source: "subagent.task",
          }],
        },
        token: { used: 5, delta: 5, budget: 100 },
      }),
      runtimeEvent(4, {
        eventId: "model-start",
        kind: "model.call",
        phase: "start",
        timestampMs: 4,
        spanId: "span:model",
        parentSpanId: "span:subagent",
        subject,
        model: {
          invocationId: "model:1",
          providerId: "provider",
          modelId: "model",
          source: "live",
        },
      }),
      runtimeEvent(5, {
        eventId: "model-end",
        kind: "model.call",
        phase: "end",
        timestampMs: 5,
        spanId: "span:model",
        parentSpanId: "span:subagent",
        subject,
        model: {
          invocationId: "model:1",
          providerId: "provider",
          modelId: "model",
          source: "live",
          finishReason: "stop",
        },
      }),
      runtimeEvent(6, {
        eventId: "end",
        kind: "swarm.subagent",
        phase: "end",
        timestampMs: 6,
        durationMs: 4,
        spanId: "span:subagent",
        parentSpanId: "span:dispatch",
        subject,
        subagent: { ...observation, resultPreview: "done" },
      }),
      runtimeEvent(7, {
        eventId: "dispatch-end",
        kind: "tool.call",
        phase: "end",
        timestampMs: 7,
        spanId: "span:dispatch",
        subject: parent,
        payload: { toolName: "task_tool" },
      }),
    ];

    const [execution] = projectSubagentExecutions(events);

    expect(execution).toMatchObject({
      invocationId: "invoke:explore",
      parentLabel: "Leader",
      status: "completed",
      contextMessageCount: 1,
      tokenUsed: 5,
    });
    expect(execution.stages.map((stage) => stage.kind)).toEqual([
      "dispatch",
      "session",
      "context",
      "model",
      "result",
    ]);
    expect(execution.stages.find((stage) => stage.kind === "model"))
      .toMatchObject({ status: "completed", firstSequence: 4, lastSequence: 5 });
    expect(visibleSubagentStages(execution, 4).map((stage) => stage.kind))
      .toEqual(["dispatch", "session", "context", "model"]);
  });

  it("ignores unstructured or non-subagent lifecycle events", () => {
    const events = [runtimeEvent(1, {
      eventId: "member",
      kind: "swarm.member",
      phase: "start",
      timestampMs: 1,
      spanId: "member",
      subject: { id: "member:one", kind: "member", label: "One" },
    })];
    expect(projectSubagentExecutions(events)).toEqual([]);
  });
});
