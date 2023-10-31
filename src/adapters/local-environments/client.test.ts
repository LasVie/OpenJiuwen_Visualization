import { describe, expect, it, vi } from "vitest";
import {
  ManagedEnvironmentClient,
  ManagedEnvironmentClientError,
} from "./client";

const SHA = "a".repeat(64);

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function environment(id: "core-env" | "swarm-core-env") {
  const core = id === "core-env";
  return {
    id,
    label: core ? "Agent Core Environment" : "JiuwenSwarm + Core Environment",
    consumers: core ? ["agent-core", "subagent"] : ["jiuwenswarm", "swarmflow"],
    state: "planned",
    message: "Desired state is ready.",
    desired: {
      fingerprint: SHA,
      manager: "uv",
      python: {
        implementation: "cpython",
        requested: "3.11",
        requiresPython: ">=3.11,<3.14",
        projectPin: core ? "3.11" : null,
        provisioning: "uv-managed",
      },
      project: {
        slot: core ? "agent-core" : "jiuwenswarm",
        source: {
          kind: "local",
          path: core ? "C:\\workspace\\agent-core" : "C:\\workspace\\jiuwenswarm",
          revision: "abc123",
          branch: "develop",
          dirty: false,
        },
        metadata: { status: "ready", name: core ? "openjiuwen" : "workswarm" },
      },
      sync: {
        strategy: "project-lock",
        frozen: true,
        projectRoot: core ? "C:\\workspace\\agent-core" : "C:\\workspace\\jiuwenswarm",
        python: "3.11",
        extras: core ? ["observability", "sqlite"] : [],
      },
      resolution: { status: "ready", code: "desired_spec_ready", message: "ready" },
    },
    generated: {
      path: `C:\\state\\${id}.json`,
      fingerprint: SHA,
      generatedAt: "2026-08-20T00:00:00Z",
      matchesDesired: true,
    },
    active: null,
    paths: {
      spec: `C:\\state\\${id}.json`,
      generations: `C:\\state\\${id}\\generations`,
      activeManifest: `C:\\state\\${id}\\active.json`,
    },
  };
}

function snapshot() {
  return {
    apiVersion: "1.0.0",
    storage: { root: "C:\\state", specFormat: "json", localOnly: true },
    policy: {
      manager: "uv",
      python: "3.11",
      lockAuthority: "uv.lock",
      autoReconcile: "before-runtime-invocation",
      upstreamWrites: false,
      activation: "atomic-generation",
    },
    environments: {
      coreEnv: environment("core-env"),
      swarmCoreEnv: environment("swarm-core-env"),
    },
  };
}

describe("ManagedEnvironmentClient", () => {
  it("loads and validates both isolated environment states", async () => {
    const fetcher = vi.fn(() => response(snapshot()));
    const client = new ManagedEnvironmentClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const value = await client.getEnvironments();

    expect(value.environments.coreEnv.consumers).toEqual(["agent-core", "subagent"]);
    expect(value.environments.swarmCoreEnv.desired.project.slot).toBe("jiuwenswarm");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/environments",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reconciles only the selected environment with an empty body", async () => {
    const baseSnapshot = snapshot();
    const reconciledSnapshot = {
      ...baseSnapshot,
      environments: {
        ...baseSnapshot.environments,
        coreEnv: {
          ...baseSnapshot.environments.coreEnv,
          state: "ready",
          active: {
            environmentId: "core-env",
            fingerprint: SHA,
            activatedAt: "2026-08-20T00:00:00Z",
            generationPath: "C:\\state\\core-env\\generations\\aaaaaaaaaaaaaaaaaaaaaaaa",
            venvPath: "C:\\state\\core-env\\generations\\aaaaaaaaaaaaaaaaaaaaaaaa\\venv",
            pythonExecutable: "C:\\state\\core-env\\generations\\aaaaaaaaaaaaaaaaaaaaaaaa\\venv\\Scripts\\python.exe",
            pythonVersion: "3.11.9",
            uvVersion: "0.10.6",
            validation: { status: "passed", checks: ["python-3.11", "runtime-probes"] },
          },
        },
      },
    };
    const fetcher = vi.fn(() => response({
      apiVersion: "1.0.0",
      result: {
        apiVersion: "1.0.0",
        environmentId: "core-env",
        outcome: "reused",
        fingerprint: SHA,
        pythonVersion: "3.11.9",
        activatedAt: "2026-08-20T00:00:00Z",
        removedGenerations: [],
      },
      environments: reconciledSnapshot,
    }));
    const client = new ManagedEnvironmentClient({
      fetcher: fetcher as unknown as typeof fetch,
    });

    const value = await client.reconcile("core-env");

    expect(value.result.outcome).toBe("reused");
    expect(value.environments.environments.coreEnv.active?.pythonVersion).toBe("3.11.9");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/environments/core-env/reconcile",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("preserves the backend diagnostic code without accepting malformed state", async () => {
    const failed = new ManagedEnvironmentClient({
      fetcher: vi.fn(() => response({
        error: { code: "system_clock_invalid", message: "Correct Windows time." },
      }, 409)) as unknown as typeof fetch,
    });
    await expect(failed.reconcile("core-env")).rejects.toEqual(
      expect.objectContaining<Partial<ManagedEnvironmentClientError>>({
        code: "system_clock_invalid",
        status: 409,
      }),
    );

    const malformed = new ManagedEnvironmentClient({
      fetcher: vi.fn(() => response({ ...snapshot(), policy: { manager: "pip" } })) as unknown as typeof fetch,
    });
    await expect(malformed.getEnvironments()).rejects.toThrow(
      "受管环境响应与 API 1.0.0 不匹配",
    );
  });
});
