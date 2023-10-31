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

function swarmCoreDependency() {
  return {
    apiVersion: "1.0.0",
    status: "ready",
    code: "git_core_dependency_locked",
    message: "locked",
    inspectedAt: "2026-08-20T00:00:00Z",
    swarmRoot: "C:\\workspace\\jiuwenswarm",
    source: {
      kind: "git",
      package: "openjiuwen",
      declaredRequirement: "openjiuwen",
      url: "https://gitcode.com/openJiuwen/agent-core.git",
      ref: { kind: "branch", value: "develop" },
      lockedUrl: "https://gitcode.com/openJiuwen/agent-core.git",
      lockedRevision: "a".repeat(40),
      lockStatus: "locked",
    },
    evidence: {
      pyproject: { path: "C:\\workspace\\jiuwenswarm\\pyproject.toml", sha256: "b".repeat(64) },
      uvLock: { path: "C:\\workspace\\jiuwenswarm\\uv.lock", sha256: "c".repeat(64) },
    },
  };
}

function repositoryConnection(slot: "agent-core" | "jiuwenswarm", mode: "local" | "github" = "local") {
  const label = slot === "agent-core" ? "Agent Core" : "JiuwenSwarm";
  return {
    slot,
    label,
    configured: true,
    mode,
    origin: mode === "github" ? "configured" : "default",
    path: `C:\\workspace\\${slot}`,
    managed: mode === "github",
    canReset: mode === "github",
    canSync: mode === "github",
    github: mode === "github" ? {
      url: `https://github.com/LasVie/${slot}.git`,
      repository: `LasVie/${slot}`,
      ref: "main",
      public: true,
    } : null,
    repository: {
      id: `${slot}-id`,
      name: slot,
      owner: slot,
      path: `C:\\workspace\\${slot}`,
      scanScope: `C:\\workspace\\${slot}`,
      revision: "a".repeat(40),
      branch: "main",
      dirty: false,
    },
    validation: { status: "ready", code: "ready", message: "ready" },
    coreDependency: slot === "jiuwenswarm" ? swarmCoreDependency() : null,
    createdAt: mode === "github" ? "2026-08-20T00:00:00Z" : null,
    updatedAt: mode === "github" ? "2026-08-20T00:00:00Z" : null,
    lastSyncedAt: mode === "github" ? "2026-08-20T00:00:00Z" : null,
  };
}

function repositories() {
  return {
    apiVersion: "1.0.0",
    storage: {
      id: "sqlite",
      journalMode: "wal",
      path: "C:\\workspace\\state.sqlite3",
    },
    policy: {
      allowedRoots: ["C:\\workspace"],
      githubPublicOnly: true,
      githubAuthentication: false,
      synchronization: "manual",
      managedCheckoutRoot: "C:\\workspace\\managed",
      swarmCoreGitHosts: ["github.com", "gitcode.com"],
    },
    slots: {
      agentCore: repositoryConnection("agent-core"),
      jiuwenSwarm: repositoryConnection("jiuwenswarm"),
    },
  };
}

describe("LocalSettingsClient", () => {
  it("reads a strict loopback settings snapshot", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response({
      apiVersion: "1.0.0",
      settings: {
        openRouter: credential(false),
        repositories: repositories(),
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
          repositories: repositories(),
          service: { transport: "loopback-http", remoteAccess: false },
        },
      }));
    const client = new LocalSettingsClient({ fetcher: fetcher as typeof fetch });

    const deleted = await client.deleteOpenRouterCredential();
    expect(deleted.configured).toBe(false);
    expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    await expect(client.getSettings()).rejects.toThrow("凭据状态格式无效");
  });

  it("binds local and public GitHub repositories through fixed slot routes", async () => {
    const fetcher = vi
      .fn((_input: RequestInfo | URL, _init?: RequestInit) => response({}))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        connection: repositoryConnection("agent-core"),
      }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        connection: repositoryConnection("jiuwenswarm", "github"),
      }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        connection: repositoryConnection("jiuwenswarm", "github"),
      }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        connection: repositoryConnection("agent-core"),
      }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        inspection: swarmCoreDependency(),
      }));
    const client = new LocalSettingsClient({ fetcher: fetcher as typeof fetch });

    await client.setLocalRepository("agent-core", " C:\\workspace\\agent-core ");
    await client.setGitHubRepository(
      "jiuwenswarm",
      " https://github.com/LasVie/jiuwenswarm ",
      " main ",
    );
    await client.syncRepository("jiuwenswarm");
    await client.resetRepository("agent-core");
    const dependency = await client.inspectSwarmCoreDependency();

    expect(fetcher.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8765/api/v1/settings/repositories/agent-core",
    );
    expect((fetcher.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({
      kind: "local",
      path: "C:\\workspace\\agent-core",
    }));
    expect((fetcher.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({
      kind: "github",
      url: "https://github.com/LasVie/jiuwenswarm",
      ref: "main",
    }));
    expect(fetcher.mock.calls[2][0]).toBe(
      "http://127.0.0.1:8765/api/v1/settings/repositories/jiuwenswarm/sync",
    );
    expect((fetcher.mock.calls[2][1] as RequestInit).body).toBe("{}");
    expect((fetcher.mock.calls[3][1] as RequestInit).method).toBe("DELETE");
    expect(fetcher.mock.calls[4][0]).toBe(
      "http://127.0.0.1:8765/api/v1/settings/repositories/jiuwenswarm/inspect-core-dependency",
    );
    expect(dependency.source?.kind).toBe("git");
  });
});
