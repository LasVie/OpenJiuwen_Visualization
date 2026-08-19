import type {
  ResolvedPluginStatus,
  WorkbenchSnapshot,
} from "../../kernel";

export const PLUGIN_STATE_STORAGE_KEY =
  "openjiuwen.visualization.plugin-states.v1";

export type PluginStatePreferences = Readonly<Record<string, boolean>>;

export interface PluginModuleModel extends ResolvedPluginStatus {
  ordinal: number;
  dependants: readonly string[];
}

export interface WorkbenchAvailability {
  runtime: boolean;
  definition: boolean;
  change: boolean;
  tools: boolean;
  modelRuntime: boolean;
  openRouter: boolean;
  subagentRuntime: boolean;
  railReview: boolean;
  runtimeSources: {
    fixture: boolean;
    core: boolean;
    swarm: boolean;
  };
}

export function parsePluginStatePreferences(
  raw: string | null,
  knownPluginIds: ReadonlySet<string>,
): PluginStatePreferences {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, enabled]) => knownPluginIds.has(id) && typeof enabled === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

export function serializePluginStatePreferences(
  preferences: PluginStatePreferences,
) {
  return JSON.stringify(preferences);
}

export function projectPluginModules(
  plugins: readonly ResolvedPluginStatus[],
): PluginModuleModel[] {
  const dependants = new Map<string, string[]>();
  plugins.forEach((plugin) => {
    plugin.dependencies.forEach((dependencyId) => {
      const current = dependants.get(dependencyId) ?? [];
      current.push(plugin.id);
      dependants.set(dependencyId, current);
    });
  });
  return plugins.map((plugin, index) => ({
    ...plugin,
    ordinal: index + 1,
    dependants: dependants.get(plugin.id) ?? [],
  }));
}

export function workbenchAvailability(
  workbench: WorkbenchSnapshot,
): WorkbenchAvailability {
  const fixture = workbench.scenarios.length > 0;
  const core = workbench.runtimeSources.some(
    (source) => source.owner === "agent-core",
  );
  const swarm = workbench.runtimeSources.some(
    (source) => source.owner === "jiuwenswarm",
  );
  return {
    runtime: fixture || core || swarm,
    definition: Boolean(workbench.capabilities["repository.local.read"]),
    change: workbench.changeSources.length > 0,
    tools: workbench.toolCatalogSources.length > 0,
    modelRuntime: workbench.modelProviders.length > 0,
    openRouter: Boolean(workbench.capabilities["runtime.model.openrouter.v1"]),
    subagentRuntime: Boolean(
      workbench.capabilities["runtime.subagent.execution.v1"],
    ),
    railReview: Boolean(workbench.capabilities["graph.rail"]),
    runtimeSources: { fixture, core, swarm },
  };
}

export function pluginStateLabel(state: ResolvedPluginStatus["state"]) {
  if (state === "enabled") return "运行中";
  if (state === "blocked") return "等待依赖";
  return "已关闭";
}
