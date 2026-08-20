import { describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_HOST_PLUGIN_ID,
  PluginHostClient,
} from "./client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const hostResponse = {
  apiVersion: "1.0.0",
  host: {
    mode: "local-loopback",
    storage: { engine: "sqlite", journalMode: "wal", schemaVersion: 1 },
    policies: {
      bundledTrust: "automatic",
      unsignedLocal: "developer-mode-path-scoped",
      secretExposure: "opaque-handle-only",
      readPermission: "install-time",
      networkPermission: "revocable",
      writePermission: "per-operation-approval",
      arbitraryPluginCode: "disabled-in-v1",
    },
    developerMode: {
      enabled: false,
      authorizedRoots: [],
      discoveryErrors: [],
    },
    plugins: [{
      id: OPENROUTER_HOST_PLUGIN_ID,
      name: "OpenRouter Provider",
      version: "1.0.0",
      description: "Host-owned adapter",
      group: "provider",
      capabilities: ["model.provider.openrouter.invoke"],
      defaultEnabled: true,
      requestedEnabled: true,
      status: "active",
      diagnostic: { code: "ready", message: "ready" },
      permissions: [{
        id: "network.openrouter.invoke",
        label: "Network",
        description: "OpenRouter only",
        kind: "network",
        grantMode: "interactive",
        granted: true,
        revocable: true,
        required: true,
      }],
      secretHandles: [{
        id: "openrouter.default",
        resolved: true,
        exposure: "opaque-handle-only",
        storage: "host-local-authority",
      }],
      trust: {
        level: "bundled-trusted",
        automatic: true,
        executable: true,
      },
      source: {
        kind: "bundled",
        identity: "local-service",
        integrity: "sha256:abc",
      },
      runtime: {
        mode: "builtin-adapter",
        processIsolation: "host-builtin-boundary",
      },
    }],
    audit: { count: 0, lastEventId: 0 },
  },
};

describe("Plugin Host client", () => {
  it("reads the local trust, permission, and opaque-handle registry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(hostResponse));
    const client = new PluginHostClient({ fetcher });

    const snapshot = await client.getSnapshot();

    expect(snapshot.plugins[0].trust.level).toBe("bundled-trusted");
    expect(snapshot.plugins[0].secretHandles[0].resolved).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/plugin-host",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("mutates only lifecycle and grants, never credential values", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(hostResponse))
      .mockResolvedValueOnce(jsonResponse(hostResponse));
    const client = new PluginHostClient({ fetcher });

    await client.setPluginEnabled(OPENROUTER_HOST_PLUGIN_ID, false);
    await client.setPermission(
      OPENROUTER_HOST_PLUGIN_ID,
      "network.openrouter.invoke",
      false,
    );

    expect(fetcher.mock.calls[0][0]).toContain("/state");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ enabled: false }));
    expect(fetcher.mock.calls[1][0]).toContain("/permissions/network.openrouter.invoke");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ granted: false }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("apiKey");
  });

  it("rejects malformed trust and permission claims", async () => {
    const malformed = structuredClone(hostResponse);
    malformed.host.plugins[0].trust.level = "self-asserted" as "bundled-trusted";
    const client = new PluginHostClient({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(malformed)),
    });

    await expect(client.getSnapshot()).rejects.toThrow(/invalid shape/);
  });
});
