import {
  GRAPH_SCHEMA_VERSION,
  type GraphEdgeRecord,
  type GraphNodeRecord,
  type RegisteredGraphEdge,
  type RegisteredGraphNode,
} from "./contracts/graph";
import {
  PLUGIN_API_VERSION,
  type RegisteredTraceScenario,
  type ResolvePluginOptions,
  type ResolvedPluginStatus,
  type VisualizationPlugin,
  type WorkbenchSnapshot,
} from "./contracts/plugin";
import type {
  RegisteredRuntimeSource,
  RegisteredRuntimeTraceRecording,
} from "./contracts/runtime";
import type {
  RegisteredModelProvider,
  RegisteredModelRuntimeRecording,
} from "./contracts/model-provider";
import type { RegisteredGitChangeSource } from "./contracts/change";
import type { RegisteredToolCatalogSource } from "./contracts/tool-catalog";

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PLUGIN_GROUPS = new Set([
  "agent-core",
  "jiuwenswarm",
  "integration",
  "workspace",
]);

export class PluginRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "duplicate-plugin"
      | "invalid-manifest"
      | "missing-dependency"
      | "dependency-cycle"
      | "duplicate-node"
      | "duplicate-edge"
      | "duplicate-scenario"
      | "duplicate-runtime-source"
      | "duplicate-runtime-recording"
      | "duplicate-model-provider"
      | "duplicate-model-recording"
      | "duplicate-change-source"
      | "duplicate-tool-catalog-source"
      | "dangling-edge"
      | "invalid-scenario-reference",
  ) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

export class VisualizationPluginRegistry {
  private readonly plugins = new Map<string, VisualizationPlugin>();

  constructor(plugins: readonly VisualizationPlugin[] = []) {
    plugins.forEach((plugin) => this.register(plugin));
  }

  register(plugin: VisualizationPlugin): this {
    const { manifest } = plugin;
    if (
      !PLUGIN_ID_PATTERN.test(manifest.id) ||
      !manifest.name.trim() ||
      !manifest.version.trim() ||
      !PLUGIN_GROUPS.has(manifest.group) ||
      manifest.apiVersion !== PLUGIN_API_VERSION
    ) {
      throw new PluginRegistryError(
        `Plugin "${manifest.id}" has an invalid manifest or unsupported API version.`,
        "invalid-manifest",
      );
    }
    if (this.plugins.has(manifest.id)) {
      throw new PluginRegistryError(
        `Plugin "${manifest.id}" is already registered.`,
        "duplicate-plugin",
      );
    }
    this.plugins.set(manifest.id, plugin);
    return this;
  }

  resolve(options: ResolvePluginOptions = {}): WorkbenchSnapshot {
    const orderedPlugins = this.topologicalOrder();
    const statuses = this.resolveStatuses(orderedPlugins, options);
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    const nodes: RegisteredGraphNode[] = [];
    const edges: RegisteredGraphEdge[] = [];
    const scenarios: RegisteredTraceScenario[] = [];
    const runtimeSources: RegisteredRuntimeSource[] = [];
    const runtimeRecordings: RegisteredRuntimeTraceRecording[] = [];
    const modelProviders: RegisteredModelProvider[] = [];
    const modelRecordings: RegisteredModelRuntimeRecording[] = [];
    const changeSources: RegisteredGitChangeSource[] = [];
    const toolCatalogSources: RegisteredToolCatalogSource[] = [];
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const scenarioIds = new Set<string>();
    const runtimeSourceIds = new Set<string>();
    const runtimeRecordingIds = new Set<string>();
    const modelProviderIds = new Set<string>();
    const modelRecordingIds = new Set<string>();
    const changeSourceIds = new Set<string>();
    const toolCatalogSourceIds = new Set<string>();
    const capabilities = new Map<string, string[]>();

    orderedPlugins.forEach((plugin) => {
      const pluginId = plugin.manifest.id;
      if (statusById.get(pluginId)?.state !== "enabled") return;

      plugin.manifest.capabilities.forEach((capability) => {
        const providers = capabilities.get(capability) ?? [];
        providers.push(pluginId);
        capabilities.set(capability, providers);
      });

      const contribution = plugin.contribute();
      (contribution.graph?.nodes ?? []).forEach((node) => {
        this.assertUnique(nodeIds, node.id, "node", pluginId);
        nodes.push(this.registerNode(node, pluginId));
      });
      (contribution.graph?.edges ?? []).forEach((edge) => {
        this.assertUnique(edgeIds, edge.id, "edge", pluginId);
        edges.push(this.registerEdge(edge, pluginId));
      });
      (contribution.scenarios ?? []).forEach((scenario) => {
        this.assertUnique(scenarioIds, scenario.id, "scenario", pluginId);
        scenarios.push({ ...scenario, contributedBy: pluginId });
      });
      (contribution.runtimeSources ?? []).forEach((source) => {
        this.assertUnique(runtimeSourceIds, source.id, "runtime-source", pluginId);
        runtimeSources.push({ ...source, contributedBy: pluginId });
      });
      (contribution.runtimeRecordings ?? []).forEach((recording) => {
        this.assertUnique(
          runtimeRecordingIds,
          recording.id,
          "runtime-recording",
          pluginId,
        );
        runtimeRecordings.push({ ...recording, contributedBy: pluginId });
      });
      (contribution.modelProviders ?? []).forEach((provider) => {
        this.assertUnique(modelProviderIds, provider.id, "model-provider", pluginId);
        modelProviders.push({ ...provider, contributedBy: pluginId });
      });
      (contribution.modelRecordings ?? []).forEach((recording) => {
        this.assertUnique(modelRecordingIds, recording.id, "model-recording", pluginId);
        modelRecordings.push({ ...recording, contributedBy: pluginId });
      });
      (contribution.changeSources ?? []).forEach((source) => {
        this.assertUnique(changeSourceIds, source.id, "change-source", pluginId);
        changeSources.push({ ...source, contributedBy: pluginId });
      });
      (contribution.toolCatalogSources ?? []).forEach((source) => {
        this.assertUnique(
          toolCatalogSourceIds,
          source.id,
          "tool-catalog-source",
          pluginId,
        );
        toolCatalogSources.push({ ...source, contributedBy: pluginId });
      });
    });

    this.validateEdges(edges, nodeIds);
    this.validateScenarios(scenarios, nodeIds, edgeIds);

    return {
      pluginApiVersion: PLUGIN_API_VERSION,
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes,
        edges,
      },
      scenarios,
      runtimeSources,
      runtimeRecordings,
      modelProviders,
      modelRecordings,
      changeSources,
      toolCatalogSources,
      plugins: statuses,
      capabilities: Object.fromEntries(capabilities),
    };
  }

  private topologicalOrder(): VisualizationPlugin[] {
    const ordered: VisualizationPlugin[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (plugin: VisualizationPlugin) => {
      const pluginId = plugin.manifest.id;
      if (visited.has(pluginId)) return;
      if (visiting.has(pluginId)) {
        throw new PluginRegistryError(
          `Plugin dependency cycle includes "${pluginId}".`,
          "dependency-cycle",
        );
      }

      visiting.add(pluginId);
      (plugin.manifest.dependencies ?? []).forEach((dependencyId) => {
        const dependency = this.plugins.get(dependencyId);
        if (!dependency) {
          throw new PluginRegistryError(
            `Plugin "${pluginId}" requires missing plugin "${dependencyId}".`,
            "missing-dependency",
          );
        }
        visit(dependency);
      });
      visiting.delete(pluginId);
      visited.add(pluginId);
      ordered.push(plugin);
    };

    this.plugins.forEach(visit);
    return ordered;
  }

  private resolveStatuses(
    plugins: readonly VisualizationPlugin[],
    options: ResolvePluginOptions,
  ): ResolvedPluginStatus[] {
    const statuses = new Map<string, ResolvedPluginStatus>();

    plugins.forEach((plugin) => {
      const { manifest } = plugin;
      const requested =
        options.pluginStates?.[manifest.id] ?? manifest.defaultEnabled;
      const unavailableDependency = (manifest.dependencies ?? []).find(
        (dependencyId) => statuses.get(dependencyId)?.state !== "enabled",
      );

      let state: ResolvedPluginStatus["state"] = "enabled";
      let reason: string | undefined;
      if (!requested) {
        state = "disabled";
        reason = "disabled by configuration";
      } else if (unavailableDependency) {
        state = "blocked";
        reason = `dependency "${unavailableDependency}" is not enabled`;
      }

      statuses.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        group: manifest.group,
        state,
        requestedEnabled: requested,
        defaultEnabled: manifest.defaultEnabled,
        dependencies: manifest.dependencies ?? [],
        reason,
        capabilities: manifest.capabilities,
      });
    });

    return plugins.map((plugin) => statuses.get(plugin.manifest.id)!);
  }

  private assertUnique(
    ids: Set<string>,
    id: string,
    entity:
      | "node"
      | "edge"
      | "scenario"
      | "runtime-source"
      | "runtime-recording"
      | "model-provider"
      | "model-recording"
      | "change-source"
      | "tool-catalog-source",
    pluginId: string,
  ) {
    if (ids.has(id)) {
      const code = `duplicate-${entity}` as
        | "duplicate-node"
        | "duplicate-edge"
        | "duplicate-scenario"
        | "duplicate-runtime-source"
        | "duplicate-runtime-recording"
        | "duplicate-model-provider"
        | "duplicate-model-recording"
        | "duplicate-change-source"
        | "duplicate-tool-catalog-source";
      throw new PluginRegistryError(
        `${entity} "${id}" contributed by "${pluginId}" is duplicated.`,
        code,
      );
    }
    ids.add(id);
  }

  private registerNode(
    node: GraphNodeRecord,
    contributedBy: string,
  ): RegisteredGraphNode {
    return { ...node, contributedBy };
  }

  private registerEdge(
    edge: GraphEdgeRecord,
    contributedBy: string,
  ): RegisteredGraphEdge {
    return { ...edge, contributedBy };
  }

  private validateEdges(
    edges: readonly RegisteredGraphEdge[],
    nodeIds: ReadonlySet<string>,
  ) {
    edges.forEach((edge) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new PluginRegistryError(
          `Edge "${edge.id}" references missing endpoint "${edge.source}" or "${edge.target}".`,
          "dangling-edge",
        );
      }
    });
  }

  private validateScenarios(
    scenarios: readonly RegisteredTraceScenario[],
    nodeIds: ReadonlySet<string>,
    edgeIds: ReadonlySet<string>,
  ) {
    scenarios.forEach((scenario) => {
      const referencedNodeIds = [
        ...scenario.railNodeIds,
        ...(scenario.mutedNodeIds ?? []),
        ...scenario.steps.flatMap((step) => step.activeNodeIds),
      ];
      const missingNodeId = referencedNodeIds.find((id) => !nodeIds.has(id));
      const missingEdgeId = scenario.steps
        .flatMap((step) => step.activeEdgeIds)
        .find((id) => !edgeIds.has(id));

      if (missingNodeId || missingEdgeId) {
        throw new PluginRegistryError(
          `Scenario "${scenario.id}" references missing ${
            missingNodeId ? `node "${missingNodeId}"` : `edge "${missingEdgeId}"`
          }.`,
          "invalid-scenario-reference",
        );
      }
    });
  }
}
