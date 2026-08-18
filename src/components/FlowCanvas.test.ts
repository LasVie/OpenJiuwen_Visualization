import { describe, expect, it } from "vitest";
import { graphEdges, scenarios } from "../data/scenarios";
import { collapsedEdges } from "./FlowCanvas";

describe("collapsed trace graph", () => {
  it("only creates macro bridge edges when the integration contribution exists", () => {
    const scenario = scenarios[0]!;
    const complete = collapsedEdges(graphEdges, scenario);
    expect(complete.map((edge) => edge.id)).toContain("e-input-deep");
    expect(complete.map((edge) => edge.id)).toContain("e-deep-output-macro");

    const withoutIntegration = collapsedEdges(
      graphEdges.filter(
        (edge) => edge.id !== "e-input-deep" && edge.id !== "e-decision-output",
      ),
      scenario,
    );
    expect(withoutIntegration.map((edge) => edge.id)).not.toContain("e-input-deep");
    expect(withoutIntegration.map((edge) => edge.id))
      .not.toContain("e-deep-output-macro");
  });
});
