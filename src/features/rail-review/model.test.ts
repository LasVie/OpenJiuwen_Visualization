import { describe, expect, it } from "vitest";
import { graphNodes, scenarios } from "../../data/scenarios";
import type { RailNodeDefinition } from "../../types/trace";
import { buildRailReviewSnapshot } from "./model";

const scenario = scenarios.find((item) => item.id === "tool-loop")!;
const safetyRail = graphNodes.find(
  (node): node is RailNodeDefinition =>
    node.type === "rail" && node.id === "rail-safety",
)!;

describe("rail review visualization model", () => {
  it("describes what a Rail inspects before it is triggered", () => {
    const snapshot = buildRailReviewSnapshot(
      safetyRail,
      scenario.steps[0],
      scenario.defaultInput,
    );

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.profile.targetPath).toBe("request.message");
    expect(snapshot.checks).toHaveLength(3);
  });

  it("shows the inspected payload, mutation, checks, and control signal", () => {
    const snapshot = buildRailReviewSnapshot(
      safetyRail,
      scenario.steps[2],
      "检查这条输入",
    );

    expect(snapshot.status).toBe("changed");
    expect(snapshot.payload).toBe("检查这条输入");
    expect(snapshot.checks[1].status).toBe("changed");
    expect(snapshot.outcome).toContain("safety_policy");
    expect(snapshot.outcome).toContain("signal=continue");
  });
});
