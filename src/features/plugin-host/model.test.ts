import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
  OPENROUTER_HOST_PLUGIN_ID,
  TOOL_CATALOG_HOST_PLUGIN_ID,
  type PluginHostSnapshot,
} from "../../adapters/plugin-host";
import {
  hostPluginIdForWorkbench,
  hostWorkbenchStateOverrides,
} from "./model";

describe("Plugin Host workbench mapping", () => {
  it("maps all Host-owned browser modules and preserves requested state", () => {
    const snapshot = {
      plugins: [
        { id: OPENROUTER_HOST_PLUGIN_ID, requestedEnabled: true },
        { id: TOOL_CATALOG_HOST_PLUGIN_ID, requestedEnabled: false },
        { id: DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID, requestedEnabled: true },
      ],
    } as PluginHostSnapshot;

    expect(hostPluginIdForWorkbench("openjiuwen.development-executor"))
      .toBe(DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID);
    expect(hostWorkbenchStateOverrides(snapshot)).toEqual({
      "openjiuwen.openrouter-provider": true,
      "openjiuwen.tool-catalog": false,
      "openjiuwen.development-executor": true,
    });
  });
});
