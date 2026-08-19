import { describe, expect, it } from "vitest";
import type {
  CoreRuntimeEvent,
  RuntimeTraceSession,
} from "../../kernel";
import { emptyRuntimeScenario, projectCoreRuntimeTrace } from "./model";

const trace: RuntimeTraceSession = {
  id: "tr_core_001",
  owner: "agent-core",
  label: "Agent Core local run",
  status: "open",
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:01Z",
  eventCount: 3,
  lastSequence: 3,
  maxTokens: 8192,
  byteCount: 0,
};

function runtimeEvent(
  sequence: number,
  overrides: Partial<CoreRuntimeEvent>,
): CoreRuntimeEvent {
  return {
    eventId: `event-${sequence}`,
    traceId: trace.id,
    sequence,
    receivedAt: "2026-08-18T00:00:01Z",
    kind: "agent.invoke",
    phase: "start",
    timestampMs: sequence * 10,
    spanId: `span-${sequence}`,
    ...overrides,
  };
}

describe("Core Runtime trace projection", () => {
  it("keeps an empty collector session navigable", () => {
    const scenario = emptyRuntimeScenario(trace);

    expect(scenario.steps).toHaveLength(1);
    expect(scenario.steps[0].eventCode).toBe("trace.waiting");
    expect(scenario.provenance).toMatchObject({
      kind: "runtime",
      traceId: trace.id,
    });
  });

  it("projects ordered events, exact Rail evidence, and full context deltas", () => {
    const scenario = projectCoreRuntimeTrace(trace, [
      runtimeEvent(3, {
        kind: "model.call",
        phase: "end",
        token: { used: 141, delta: 77, budget: 16384 },
      }),
      runtimeEvent(1, {
        kind: "agent.user_message",
        phase: "instant",
        token: { used: 18 },
        context: {
          operation: "append",
          messages: [
            {
              id: "message-user",
              role: "user",
              label: "User message",
              raw: "联系 me@example.com，并保留这一整段运行时原文。",
              tokens: 18,
              source: "on_user_message",
            },
          ],
        },
      }),
      runtimeEvent(2, {
        kind: "rail.hook",
        phase: "end",
        payload: { callback: "before_model_call" },
        hook: {
          rail: "ContextAssembleRail",
          railNodeId: "rail-context",
          callback: "before_model_call",
          priority: 85,
          namespace: "inner",
          durationMs: 1.7,
          mutationDiff: "+ runtime prompt",
          controlSignal: "continue",
          exact: true,
          examines: ["ModelCallInputs.messages"],
        },
        token: { used: 64, delta: 46 },
      }),
    ]);

    expect(scenario.steps.map((step) => step.id)).toEqual([
      "tr_core_001:1",
      "tr_core_001:2",
      "tr_core_001:3",
    ]);
    expect(scenario.steps[1]).toMatchObject({
      eventCode: "before_model_call",
      activeNodeIds: ["rail-context", "context"],
      activeEdgeIds: ["e-rail-context-context"],
      tokenUsed: 64,
    });
    expect(scenario.steps[1].hooks[0]).toMatchObject({
      rail: "ContextAssembleRail",
      mutationDiff: "+ runtime prompt",
      examines: ["ModelCallInputs.messages"],
    });
    expect(scenario.messages[0].raw).toContain("整段运行时原文");
    expect(scenario.messages[0].addedAt).toBe(0);
    expect(scenario.maxTokens).toBe(16384);
    expect(scenario.railNodeIds).toEqual(["rail-context"]);
  });

  it("does not invent individual Rail decisions from a callback-chain event", () => {
    const scenario = projectCoreRuntimeTrace(trace, [
      runtimeEvent(1, {
        kind: "rail.chain",
        phase: "end",
        payload: { callback: "before_model_call" },
      }),
    ]);

    expect(scenario.steps[0].activeNodeIds).toEqual(["context"]);
    expect(scenario.steps[0].activeEdgeIds).toEqual([]);
    expect(scenario.steps[0].hooks).toEqual([]);
    expect(scenario.steps[0].summary).toContain("不推断");
  });
});
