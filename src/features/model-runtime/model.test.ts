import { describe, expect, it } from "vitest";
import type { RuntimeTraceEvent } from "../../kernel";
import { projectModelRuntime } from "./model";

function event(
  sequence: number,
  kind: RuntimeTraceEvent["kind"],
  model: NonNullable<RuntimeTraceEvent["model"]>,
  phase: RuntimeTraceEvent["phase"] = "instant",
): RuntimeTraceEvent {
  return {
    eventId: `event-${sequence}`,
    traceId: "trace-model",
    sequence,
    receivedAt: "2026-08-18T00:00:00Z",
    timestampMs: sequence * 10,
    spanId: "span-model",
    kind,
    phase,
    model,
  };
}

const baseModel = {
  invocationId: "invoke-1",
  providerId: "provider.demo",
  modelId: "demo-reasoner",
  source: "recording" as const,
  recordingId: "recording-1",
};

describe("model runtime projection", () => {
  it("reconstructs streamed output, usage and a completed invocation", () => {
    const projection = projectModelRuntime([
      event(1, "model.call", { ...baseModel, recordingSequence: 0 }, "start"),
      event(2, "model.stream", {
        ...baseModel,
        recordingSequence: 1,
        delta: "Hello ",
      }),
      event(3, "model.stream", {
        ...baseModel,
        recordingSequence: 2,
        delta: "world",
      }),
      event(4, "model.usage", {
        ...baseModel,
        recordingSequence: 3,
        usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
        budget: { maxTotalTokens: 128 },
      }),
      event(5, "model.call", {
        ...baseModel,
        recordingSequence: 4,
        finishReason: "stop",
      }, "end"),
    ]);

    expect(projection.observedEventCount).toBe(5);
    expect(projection.activeInvocationId).toBe("invoke-1");
    expect(projection.invocations[0]).toMatchObject({
      status: "completed",
      output: "Hello world",
      finishReason: "stop",
      usage: { totalTokens: 14 },
      budget: { maxTotalTokens: 128 },
    });
    expect(projection.invocations[0].frames).toHaveLength(5);
  });

  it("time-slices recordings and preserves explicit cancellation", () => {
    const events = [
      event(1, "model.call", { ...baseModel, recordingSequence: 0 }, "start"),
      event(2, "model.stream", {
        ...baseModel,
        recordingSequence: 1,
        delta: "partial secret@example.com",
      }),
      event(3, "model.cancel", {
        ...baseModel,
        recordingSequence: 2,
        cancelReason: "user_stop",
      }),
      event(4, "model.call", {
        ...baseModel,
        recordingSequence: 3,
        finishReason: "cancelled",
      }, "end"),
    ];

    expect(projectModelRuntime(events, 2).invocations[0]).toMatchObject({
      status: "streaming",
      output: "partial secret@example.com",
    });
    expect(projectModelRuntime(events).invocations[0]).toMatchObject({
      status: "cancelled",
      cancelReason: "user_stop",
    });
  });
});
