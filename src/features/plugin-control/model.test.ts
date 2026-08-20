import { describe, expect, it } from "vitest";
import { createDefaultPluginRegistry } from "../../workbench/default-workbench";
import {
  parsePluginStatePreferences,
  projectPluginModules,
  workbenchAvailability,
} from "./model";

describe("plugin control model", () => {
  it("keeps only known boolean preferences", () => {
    const known = new Set(["openjiuwen.agent-core", "openjiuwen.jiuwenswarm"]);
    expect(parsePluginStatePreferences(JSON.stringify({
      "openjiuwen.agent-core": false,
      "openjiuwen.jiuwenswarm": true,
      "unknown.module": false,
      invalid: "false",
    }), known)).toEqual({
      "openjiuwen.agent-core": false,
      "openjiuwen.jiuwenswarm": true,
    });
    expect(parsePluginStatePreferences("not-json", known)).toEqual({});
    expect(parsePluginStatePreferences("[]", known)).toEqual({});
  });

  it("projects direct dependants without flattening dependency levels", () => {
    const snapshot = createDefaultPluginRegistry().resolve();
    const modules = projectPluginModules(snapshot.plugins);
    expect(modules.find((plugin) => plugin.id === "openjiuwen.agent-core"))
      .toMatchObject({
        ordinal: 1,
        group: "agent-core",
        requestedEnabled: true,
        dependants: [
          "openjiuwen.model-provider",
          "openjiuwen.agent-core-executor",
          "openjiuwen.subagent-executor",
          "openjiuwen.swarmflow-executor",
          "openjiuwen.integration",
        ],
      });
    expect(modules.find((plugin) => plugin.id === "openjiuwen.integration")
      ?.dependants).toEqual(["openjiuwen.deterministic-replay"]);
    expect(modules.find((plugin) => plugin.id === "openjiuwen.model-provider")
      ?.dependants).toEqual(["openjiuwen.openrouter-provider"]);
    expect(modules.find((plugin) => plugin.id === "openjiuwen.local-repository")
      ?.dependants).toEqual([
        "openjiuwen.source-convergence",
        "openjiuwen.development-assistant",
        "openjiuwen.tool-catalog",
        "openjiuwen.git-change",
        "openjiuwen.github-pull-request",
      ]);
  });

  it("derives visible workbench surfaces from enabled contributions", () => {
    const registry = createDefaultPluginRegistry();
    expect(workbenchAvailability(registry.resolve())).toEqual({
      runtime: true,
      archive: true,
      definition: true,
      change: true,
      development: true,
      tools: true,
      modelRuntime: true,
      openRouter: true,
      agentCoreExecution: true,
      jiuwenSwarmExecution: true,
      swarmFlowExecution: true,
      subagentExecution: true,
      subagentRuntime: true,
      railReview: true,
      sourceConvergence: true,
      runtimeSources: { fixture: true, core: true, swarm: true },
    });

    const reduced = registry.resolve({
      pluginStates: {
        "openjiuwen.agent-core": false,
        "openjiuwen.local-repository": false,
      },
    });
    expect(workbenchAvailability(reduced)).toEqual({
      runtime: true,
      archive: true,
      definition: false,
      change: false,
      development: false,
      tools: false,
      modelRuntime: false,
      openRouter: false,
      agentCoreExecution: false,
      jiuwenSwarmExecution: false,
      swarmFlowExecution: false,
      subagentExecution: false,
      subagentRuntime: true,
      railReview: false,
      sourceConvergence: false,
      runtimeSources: { fixture: false, core: false, swarm: true },
    });

    const withoutOpenRouter = registry.resolve({
      pluginStates: { "openjiuwen.openrouter-provider": false },
    });
    expect(workbenchAvailability(withoutOpenRouter)).toMatchObject({
      modelRuntime: true,
      openRouter: false,
      agentCoreExecution: false,
      jiuwenSwarmExecution: false,
      swarmFlowExecution: false,
      subagentExecution: false,
    });
    expect(withoutOpenRouter.modelProviders.map((provider) => provider.id))
      .toEqual(["openjiuwen.recording-replay"]);

    const withoutSourceConvergence = registry.resolve({
      pluginStates: { "openjiuwen.source-convergence": false },
    });
    expect(workbenchAvailability(withoutSourceConvergence)).toMatchObject({
      definition: true,
      change: true,
      development: false,
      sourceConvergence: false,
    });

    const withoutArchive = registry.resolve({
      pluginStates: { "openjiuwen.trace-archive": false },
    });
    expect(workbenchAvailability(withoutArchive).archive).toBe(false);
  });
});
