import { describe, expect, it } from "vitest";
import { graphNodes, scenarios } from "../../data/scenarios";
import type { RailNodeDefinition } from "../../types/trace";
import { buildRailReviewFrames } from "./model";
import { buildRailDecisionGraph } from "./decision-graph";

const scenario = scenarios.find((item) => item.id === "tool-loop")!;
const contextRail = graphNodes.find(
  (node): node is RailNodeDefinition =>
    node.type === "rail" && node.id === "rail-context",
)!;

describe("Rail decision canvas graph", () => {
  it("collects every invocation of the selected Rail across the trace", () => {
    const frames = buildRailReviewFrames(
      contextRail,
      scenario,
      scenario.defaultInput,
    );

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.step.eventCode)).toEqual([
      "BEFORE_MODEL_CALL",
      "BEFORE_MODEL_CALL",
    ]);
    expect(frames[0].snapshot.invocation?.id).toBe("tl-h-before-model-1");
    expect(frames[1].snapshot.invocation?.id).toBe("tl-h-before-model-2");
  });

  it("expands an invocation into seven decision stages", () => {
    const frame = buildRailReviewFrames(
      contextRail,
      scenario,
      scenario.defaultInput,
    )[0];
    const graph = buildRailDecisionGraph(
      contextRail,
      frame.step,
      frame.snapshot,
    );

    expect(graph.nodes).toHaveLength(7);
    expect(graph.edges).toHaveLength(8);
    expect(graph.nodes.map((node) => node.data.phase)).toEqual([
      "READ",
      "DISPATCH",
      "CHECK",
      "CHECK",
      "CHECK",
      "APPLY",
      "EMIT",
    ]);
  });
});

