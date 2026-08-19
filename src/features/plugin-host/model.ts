import {
  OPENROUTER_HOST_PLUGIN_ID,
  TOOL_CATALOG_HOST_PLUGIN_ID,
  type PluginHostSnapshot,
} from "../../adapters/plugin-host";

const hostPluginByWorkbenchPlugin: Readonly<Record<string, string>> = {
  "openjiuwen.openrouter-provider": OPENROUTER_HOST_PLUGIN_ID,
  "openjiuwen.tool-catalog": TOOL_CATALOG_HOST_PLUGIN_ID,
};

export function hostPluginIdForWorkbench(pluginId: string) {
  return hostPluginByWorkbenchPlugin[pluginId] ?? null;
}

export function hostWorkbenchStateOverrides(
  snapshot: PluginHostSnapshot | null,
): Readonly<Record<string, boolean>> {
  if (!snapshot) return {};
  const stateByHostId = new Map(
    snapshot.plugins.map((plugin) => [plugin.id, plugin.requestedEnabled]),
  );
  return Object.fromEntries(
    Object.entries(hostPluginByWorkbenchPlugin).flatMap(
      ([workbenchId, hostId]) => {
        const enabled = stateByHostId.get(hostId);
        return enabled === undefined ? [] : [[workbenchId, enabled]];
      },
    ),
  );
}

