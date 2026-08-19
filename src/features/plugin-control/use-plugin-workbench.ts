import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createDefaultPluginRegistry,
  defaultWorkbench,
} from "../../workbench/default-workbench";
import {
  PLUGIN_STATE_STORAGE_KEY,
  parsePluginStatePreferences,
  serializePluginStatePreferences,
  type PluginStatePreferences,
} from "./model";

const knownPluginIds = new Set(
  defaultWorkbench.plugins.map((plugin) => plugin.id),
);

function initialPluginStates(): PluginStatePreferences {
  if (typeof window === "undefined") return {};
  try {
    return parsePluginStatePreferences(
      window.localStorage.getItem(PLUGIN_STATE_STORAGE_KEY),
      knownPluginIds,
    );
  } catch {
    return {};
  }
}

export function usePluginWorkbench(
  externalPluginStates: PluginStatePreferences = {},
) {
  const registry = useMemo(() => createDefaultPluginRegistry(), []);
  const [pluginStates, setPluginStates] = useState<PluginStatePreferences>(
    initialPluginStates,
  );
  const workbench = useMemo(
    () => registry.resolve({
      pluginStates: { ...pluginStates, ...externalPluginStates },
    }),
    [externalPluginStates, pluginStates, registry],
  );

  useEffect(() => {
    try {
      if (Object.keys(pluginStates).length === 0) {
        window.localStorage.removeItem(PLUGIN_STATE_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(
        PLUGIN_STATE_STORAGE_KEY,
        serializePluginStatePreferences(pluginStates),
      );
    } catch {
      // Storage can be unavailable in locked-down browsers; the session state remains valid.
    }
  }, [pluginStates]);

  const setPluginEnabled = useCallback((id: string, enabled: boolean) => {
    const defaultEnabled = defaultWorkbench.plugins.find(
      (plugin) => plugin.id === id,
    )?.defaultEnabled;
    if (defaultEnabled === undefined) return;
    setPluginStates((current) => {
      const next = { ...current };
      if (enabled === defaultEnabled) delete next[id];
      else next[id] = enabled;
      return next;
    });
  }, []);

  const resetPluginStates = useCallback(() => setPluginStates({}), []);

  return {
    workbench,
    pluginStates,
    hasOverrides: Object.keys(pluginStates).length > 0,
    setPluginEnabled,
    resetPluginStates,
  };
}
