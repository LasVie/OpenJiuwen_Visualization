import { describe, expect, it, vi } from "vitest";
import { LocalSettingsClient } from "./client";

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function credential(configured = false) {
  return {
    handleId: "openrouter.default",
    configured,
    source: configured ? "system-credential" : "none",
    writable: true,
    canDelete: configured,
    exposure: "write-only",
    environmentFallback: false,
    storage: {
      id: "windows-credential-manager",
      available: true,
      writable: true,
      persistence: "current-user",
    },
  };
}

describe("LocalSettingsClient", () => {
  it("reads a strict loopback settings snapshot", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response({
      apiVersion: "1.0.0",
      settings: {
        openRouter: credential(false),
        service: { transport: "loopback-http", remoteAccess: false },
      },
    }));
    const client = new LocalSettingsClient({ fetcher: fetcher as typeof fetch });

    const snapshot = await client.getSettings();

    expect(snapshot.settings.openRouter.source).toBe("none");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/settings",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("writes the key once and never expects it in the response", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response({
      apiVersion: "1.0.0",
      credential: credential(true),
    }));
    const client = new LocalSettingsClient({ fetcher: fetcher as typeof fetch });

    const saved = await client.setOpenRouterCredential("  sk-or-browser-secret  ");

    expect(saved.configured).toBe(true);
    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.body).toBe(JSON.stringify({ apiKey: "sk-or-browser-secret" }));
    expect(JSON.stringify(saved)).not.toContain("sk-or-browser-secret");
  });

  it("deletes only the host-managed credential and rejects malformed state", async () => {
    const fetcher = vi
      .fn((_input: RequestInfo | URL, _init?: RequestInit) => response({}))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        credential: credential(false),
      }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        settings: {
          openRouter: { ...credential(false), configured: true },
          service: { transport: "loopback-http", remoteAccess: false },
        },
      }));
    const client = new LocalSettingsClient({ fetcher: fetcher as typeof fetch });

    const deleted = await client.deleteOpenRouterCredential();
    expect(deleted.configured).toBe(false);
    expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    await expect(client.getSettings()).rejects.toThrow("凭据状态格式无效");
  });
});
