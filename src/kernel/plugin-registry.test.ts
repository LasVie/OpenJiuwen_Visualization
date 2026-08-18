import { describe, expect, it } from "vitest";
import {
  createDefaultPluginRegistry,
  defaultWorkbench,
} from "../workbench/default-workbench";
import { projectTraceGraph } from "../domain/trace/projection";
import { PLUGIN_API_VERSION, type VisualizationPlugin } from "./contracts/plugin";
import { PluginRegistryError, VisualizationPluginRegistry } from "./plugin-registry";

function plugin(
  id: string,
  overrides: Partial<VisualizationPlugin> = {},
): VisualizationPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "0.1.0",
      apiVersion: PLUGIN_API_VERSION,
      description: "test plugin",
      group: "workspace",
      defaultEnabled: true,
      capabilities: [],
    },
    contribute: () => ({}),
    ...overrides,
  };
}

describe("visualization plugin registry", () => {
  it("resolves the default workbench with attributed graph and scenarios", () => {
    expect(defaultWorkbench.graph.schemaVersion).toBe("1.0.0");
    expect(defaultWorkbench.graph.nodes).toHaveLength(15);
    expect(defaultWorkbench.graph.edges).toHaveLength(14);
    expect(defaultWorkbench.scenarios).toHaveLength(4);
    expect(defaultWorkbench.runtimeSources).toEqual([
      expect.objectContaining({
        id: "openjiuwen.agent-core.runtime",
        owner: "agent-core",
        contributedBy: "openjiuwen.agent-core",
      }),
      expect.objectContaining({
        id: "openjiuwen.jiuwenswarm.runtime",
        owner: "jiuwenswarm",
        contributedBy: "openjiuwen.jiuwenswarm",
      }),
    ]);
    expect(defaultWorkbench.runtimeRecordings).toEqual([
      expect.objectContaining({
        id: "swarm-subagent-delegation-v1",
        owner: "jiuwenswarm",
        contributedBy: "openjiuwen.jiuwenswarm",
      }),
    ]);
    expect(defaultWorkbench.modelProviders).toEqual([
      expect.objectContaining({
        id: "openjiuwen.recording-replay",
        mode: "recording-replay",
        credentialPolicy: "none",
        contributedBy: "openjiuwen.model-provider",
      }),
    ]);
    expect(defaultWorkbench.modelRecordings).toEqual([
      expect.objectContaining({
        id: "model-provider-v1-stream-and-cancel",
        contributedBy: "openjiuwen.model-provider",
      }),
    ]);
    expect(defaultWorkbench.changeSources).toEqual([
      expect.objectContaining({
        id: "openjiuwen.local-git-change",
        readOnly: true,
        remoteFetch: false,
        contributedBy: "openjiuwen.git-change",
      }),
      expect.objectContaining({
        id: "openjiuwen.github-pull-request",
        readOnly: true,
        remoteFetch: true,
        contributedBy: "openjiuwen.github-pull-request",
      }),
    ]);
    expect(defaultWorkbench.toolCatalogSources).toEqual([
      expect.objectContaining({
        id: "openjiuwen.local-tool-catalog",
        readOnly: true,
        importsTargetCode: false,
        contributedBy: "openjiuwen.tool-catalog",
      }),
    ]);
    expect(defaultWorkbench.plugins.map((item) => [item.id, item.state]))
      .toEqual([
        ["openjiuwen.agent-core", "enabled"],
        ["openjiuwen.model-provider", "enabled"],
        ["openjiuwen.jiuwenswarm", "enabled"],
        ["openjiuwen.integration", "enabled"],
        ["openjiuwen.deterministic-replay", "enabled"],
        ["openjiuwen.local-repository", "enabled"],
        ["openjiuwen.tool-catalog", "enabled"],
        ["openjiuwen.git-change", "enabled"],
        ["openjiuwen.github-pull-request", "enabled"],
      ]);
    expect(defaultWorkbench.plugins[0]).toMatchObject({
      id: "openjiuwen.agent-core",
      group: "agent-core",
      requestedEnabled: true,
      defaultEnabled: true,
      dependencies: [],
      description: expect.any(String),
    });
    expect(defaultWorkbench.capabilities["graph.rail"]).toEqual([
      "openjiuwen.agent-core",
    ]);
    expect(defaultWorkbench.capabilities["repository.source.read"]).toEqual([
      "openjiuwen.local-repository",
    ]);
    expect(defaultWorkbench.capabilities["graph.definition.relation-explorer.v1"])
      .toEqual(["openjiuwen.local-repository"]);
    expect(defaultWorkbench.capabilities["trace.context.ownership"]).toEqual([
      "openjiuwen.jiuwenswarm",
    ]);
    expect(defaultWorkbench.capabilities["runtime.subagent.execution.v1"]).toEqual([
      "openjiuwen.jiuwenswarm",
    ]);
    expect(defaultWorkbench.capabilities["runtime.model.recording.v1"]).toEqual([
      "openjiuwen.model-provider",
    ]);
    expect(defaultWorkbench.capabilities["graph.change.impact.v1"]).toEqual([
      "openjiuwen.git-change",
    ]);
    expect(defaultWorkbench.capabilities["graph.change.github-pr.v1"]).toEqual([
      "openjiuwen.github-pull-request",
    ]);
    expect(defaultWorkbench.capabilities["graph.definition.tool-registry.v1"])
      .toEqual(["openjiuwen.tool-catalog"]);
    expect(defaultWorkbench.graph.nodes.find((node) => node.id === "model"))
      .toMatchObject({
        contributedBy: "openjiuwen.agent-core",
        plane: "definition",
        level: 4,
      });
  });

  it("blocks dependants when a module is switched off", () => {
    const snapshot = createDefaultPluginRegistry().resolve({
      pluginStates: { "openjiuwen.agent-core": false },
    });
    const status = Object.fromEntries(
      snapshot.plugins.map((item) => [item.id, item.state]),
    );

    expect(status).toEqual({
      "openjiuwen.agent-core": "disabled",
      "openjiuwen.model-provider": "blocked",
      "openjiuwen.jiuwenswarm": "enabled",
      "openjiuwen.integration": "blocked",
      "openjiuwen.deterministic-replay": "blocked",
      "openjiuwen.local-repository": "enabled",
      "openjiuwen.tool-catalog": "enabled",
      "openjiuwen.git-change": "enabled",
      "openjiuwen.github-pull-request": "enabled",
    });
    expect(snapshot.graph.nodes.map((node) => node.id)).toEqual([
      "input",
      "output",
    ]);
    expect(snapshot.graph.edges).toEqual([]);
    expect(snapshot.scenarios).toEqual([]);

    const coreOnly = createDefaultPluginRegistry().resolve({
      pluginStates: { "openjiuwen.jiuwenswarm": false },
    });
    expect(coreOnly.graph.nodes).toHaveLength(13);
    expect(coreOnly.graph.edges).toHaveLength(11);
    expect(coreOnly.scenarios).toEqual([]);
    expect(coreOnly.runtimeRecordings).toEqual([]);
    expect(
      coreOnly.plugins.find((item) => item.id === "openjiuwen.integration")
        ?.state,
    ).toBe("blocked");

    const withoutLocalGit = createDefaultPluginRegistry().resolve({
      pluginStates: { "openjiuwen.local-repository": false },
    });
    expect(
      withoutLocalGit.plugins.find((item) => item.id === "openjiuwen.git-change")
        ?.state,
    ).toBe("blocked");
    expect(
      withoutLocalGit.plugins.find((item) => item.id === "openjiuwen.tool-catalog")
        ?.state,
    ).toBe("blocked");
    expect(
      withoutLocalGit.plugins.find((item) => item.id === "openjiuwen.github-pull-request")
        ?.state,
    ).toBe("blocked");
    expect(withoutLocalGit.changeSources).toEqual([]);
    expect(withoutLocalGit.toolCatalogSources).toEqual([]);
  });

  it("keeps the canonical graph independent from its ReactFlow projection", () => {
    const canonicalModel = defaultWorkbench.graph.nodes.find(
      (node) => node.id === "model",
    )!;
    const projectedModel = projectTraceGraph(defaultWorkbench.graph).nodes.find(
      (node) => node.id === "model",
    )!;

    expect(canonicalModel.views?.["trace-flow"]?.renderer).toBe("stage");
    expect(canonicalModel).not.toHaveProperty("position");
    expect(projectedModel).toMatchObject({
      type: "stage",
      sourceLocation: "openjiuwen/core/foundation/llm/model.py",
    });
  });

  it("rejects missing dependencies and duplicate graph ids", () => {
    const missingDependency = plugin("test.dependant", {
      manifest: {
        id: "test.dependant",
        name: "dependant",
        version: "0.1.0",
        apiVersion: PLUGIN_API_VERSION,
        description: "test plugin",
        group: "workspace",
        defaultEnabled: true,
        dependencies: ["test.missing"],
        capabilities: [],
      },
    });
    expect(() => new VisualizationPluginRegistry([missingDependency]).resolve())
      .toThrowError(PluginRegistryError);

    const node = {
      id: "same-node",
      kind: "agent",
      plane: "definition" as const,
      level: 2 as const,
      owner: "test",
      label: "same",
      summary: "same",
      evidence: [],
    };
    const first = plugin("test.first", {
      contribute: () => ({ graph: { nodes: [node] } }),
    });
    const second = plugin("test.second", {
      contribute: () => ({ graph: { nodes: [node] } }),
    });

    expect(() => new VisualizationPluginRegistry([first, second]).resolve())
      .toThrowError(/same-node/);
  });
});
