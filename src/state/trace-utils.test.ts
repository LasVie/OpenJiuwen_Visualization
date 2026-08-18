import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes, scenarios } from "../data/scenarios";
import {
  clampStepIndex,
  maskSensitiveText,
  materializeText,
  shouldExpandDeepAgent,
  validateScenarios,
  visibleContextMessages,
} from "./trace-utils";

describe("trace scenario invariants", () => {
  it("keeps every trajectory reference inside the declared graph", () => {
    expect(validateScenarios(scenarios, graphNodes, graphEdges)).toEqual([]);
  });

  it("keeps scenario ids and step ids deterministic and unique", () => {
    const scenarioIds = scenarios.map((scenario) => scenario.id);
    const stepIds = scenarios.flatMap((scenario) =>
      scenario.steps.map((step) => step.id),
    );

    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    scenarios.forEach((scenario) => {
      expect(scenario.steps[0].activeNodeIds).toContain("input");
      expect(scenario.steps.at(-1)?.activeNodeIds).toContain("output");
    });
  });
});

describe("context replay helpers", () => {
  it("materializes the simulated input without changing the fixture", () => {
    const template = "request={{input}}";
    expect(materializeText(template, "hello")).toBe("request=hello");
    expect(template).toBe("request={{input}}");
  });

  it("masks email, credentials, and phone-like values in preview mode", () => {
    const value =
      "send to chen@example.com with sk-demo-9A31F2x7, call +65 9123 4567";
    const masked = maskSensitiveText(value);

    expect(masked).not.toContain("chen@example.com");
    expect(masked).not.toContain("sk-demo-9A31F2x7");
    expect(masked).not.toContain("+65 9123 4567");
    expect(masked).toContain("[邮箱已隐藏]");
    expect(masked).toContain("[凭据已隐藏]");
    expect(masked).toContain("[号码已隐藏]");
  });

  it("replaces compressed history exactly at the completion step", () => {
    const scenario = scenarios.find(
      (item) => item.id === "context-compression",
    )!;
    const before = visibleContextMessages(scenario.messages, 3);
    const after = visibleContextMessages(scenario.messages, 4);

    expect(before.map((message) => message.id)).toContain("cp-old-assistant");
    expect(after.map((message) => message.id)).not.toContain("cp-old-assistant");
    expect(after.map((message) => message.id)).toContain("cp-summary");
  });

  it("clamps timeline navigation to valid deterministic steps", () => {
    expect(clampStepIndex(-3, 10)).toBe(0);
    expect(clampStepIndex(4, 10)).toBe(4);
    expect(clampStepIndex(14, 10)).toBe(9);
    expect(clampStepIndex(3, 0)).toBe(0);
  });

  it("expands DeepAgent only on demand in macro mode and always in micro mode", () => {
    expect(shouldExpandDeepAgent("macro", false, 0)).toBe(false);
    expect(shouldExpandDeepAgent("macro", true, 0)).toBe(true);
    expect(shouldExpandDeepAgent("macro", false, 1)).toBe(true);
    expect(shouldExpandDeepAgent("micro", false, 0)).toBe(true);
  });

  it("keeps the continuous context fixture as full multiline source text", () => {
    const scenario = scenarios.find((item) => item.id === "tool-loop")!;
    const system = scenario.messages.find((message) => message.id === "tl-system")!;

    expect(system.raw.split("\n").length).toBeGreaterThan(20);
    expect(system.raw).toContain("REGISTERED TOOL SCHEMA");
    expect(system.raw).toContain("ToolCallResilienceRail");
  });
});
