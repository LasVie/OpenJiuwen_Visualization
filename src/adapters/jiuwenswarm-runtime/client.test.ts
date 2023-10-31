import { describe, expect, it, vi } from "vitest";
import { JiuwenSwarmRuntimeClient } from "./client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const runtimeResponse = {
  apiVersion: "1.0.0",
  runtime: {
    id: "jiuwenswarm-agent-team",
    label: "JiuwenSwarm · Agent Team",
    status: "ready",
    configured: true,
    protocol: "openjiuwen.jiuwenswarm.bridge/1.0",
    entrypoint: "jiuwenswarm.agents.swarm.enrich_team_spec_for_swarm",
    executionIsolation: "fixed-subprocess",
    credentialPolicy: "local-service-only",
    providerId: "openrouter",
    profile: "predefined-two-member",
    teamMode: "predefined",
    dispatchMode: "scheduled",
    spawnMode: "inprocess",
    swarmFlow: false,
    streaming: true,
    cancellation: true,
    contextOwnership: "per-member",
    tools: [
      { id: "team.create_task", label: "Create task", policy: "team-only" },
      { id: "team.member_complete_task", label: "Complete task", policy: "self-only" },
    ],
    models: [{ id: "openrouter/free", label: "openrouter/free", default: true }],
    defaultModelId: "openrouter/free",
    limits: {
      maxInputCharacters: 64_000,
      maxSystemCharacters: 32_000,
      minOutputTokens: 16,
      maxOutputTokens: 4_096,
      defaultOutputTokens: 512,
      maxIterations: 8,
      maxActiveInvocations: 1,
    },
    diagnostic: { code: "ready", message: "ready" },
    managedEnvironment: {
      id: "swarm-core-env",
      consumer: "jiuwenswarm",
      state: "ready",
      desiredFingerprint: "b".repeat(64),
      activeFingerprint: "b".repeat(64),
      pythonVersion: "3.11.9",
      uvVersion: "0.9.0",
      autoReconcile: "before-runtime-invocation",
      diagnostic: { code: "ready", message: "verified" },
    },
    frameworkVersion: "source-checkout",
  },
};

describe("JiuwenSwarm runtime client", () => {
  it("validates and refreshes the fixed Agent Team registry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(runtimeResponse));
    const client = new JiuwenSwarmRuntimeClient({ fetcher });

    const status = await client.getStatus(undefined, true);

    expect(status.profile).toBe("predefined-two-member");
    expect(status.swarmFlow).toBe(false);
    expect(status.contextOwnership).toBe("per-member");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/jiuwenswarm?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("starts and cancels with Trace authority without accepting provider credentials", async () => {
    const invocation = {
      apiVersion: "1.0.0",
      invocation: {
        id: "sw_test",
        traceId: "tr_test",
        runtimeId: "jiuwenswarm-agent-team",
        providerId: "openrouter",
        modelId: "openrouter/free",
        teamName: "visualization_sw_test",
        sessionId: "session_sw_test",
        status: "accepted",
        cancellationEndpoint: "/cancel",
      },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(invocation, 202))
      .mockResolvedValueOnce(jsonResponse({
        ...invocation,
        invocation: { ...invocation.invocation, status: "cancelling" },
      }, 202));
    const client = new JiuwenSwarmRuntimeClient({ fetcher });

    await client.startInvocation({
      traceId: "tr_test",
      writeToken: "tw_secret",
      modelId: "openrouter/free",
      input: "run the team",
      maxOutputTokens: 128,
    });
    await client.cancelInvocation("sw_test", "tw_secret");

    const startInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "X-Trace-Token": "tw_secret" });
    expect(String(startInit.body)).toContain("run the team");
    expect(String(startInit.body)).not.toContain("apiKey");
    expect(fetcher.mock.calls[1][0]).toContain("/sw_test/cancel");
  });

  it("rejects a registry that mislabels Agent Team execution as SwarmFlow", async () => {
    const client = new JiuwenSwarmRuntimeClient({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ...runtimeResponse,
        runtime: { ...runtimeResponse.runtime, swarmFlow: true },
      })),
    });

    await expect(client.getStatus()).rejects.toThrow(/invalid shape/);
  });
});
