import { describe, expect, it, vi } from "vitest";
import { AgentCoreRuntimeClient } from "./client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const runtimeResponse = {
  apiVersion: "1.0.0",
  runtime: {
    id: "agent-core-deep-agent",
    label: "Agent Core · DeepAgent",
    status: "ready",
    configured: true,
    protocol: "openjiuwen.agent-core.bridge/1.0",
    entrypoint: "openjiuwen.harness.create_deep_agent",
    executionIsolation: "fixed-subprocess",
    credentialPolicy: "local-service-only",
    providerId: "openrouter",
    streaming: true,
    cancellation: true,
    reactLoop: true,
    rails: true,
    tools: [{ id: "inspect_input", label: "Inspect input", policy: "read-only-allowlist" }],
    models: [{ id: "openrouter/free", label: "openrouter/free", default: true }],
    defaultModelId: "openrouter/free",
    limits: {
      maxInputCharacters: 64_000,
      maxSystemCharacters: 32_000,
      minOutputTokens: 16,
      maxOutputTokens: 4_096,
      defaultOutputTokens: 512,
      maxIterations: 6,
      maxActiveInvocations: 2,
    },
    diagnostic: { code: "ready", message: "ready" },
    managedEnvironment: {
      id: "core-env",
      consumer: "agent-core",
      state: "ready",
      desiredFingerprint: "a".repeat(64),
      activeFingerprint: "a".repeat(64),
      pythonVersion: "3.11.9",
      uvVersion: "0.9.0",
      autoReconcile: "before-runtime-invocation",
      diagnostic: { code: "ready", message: "verified" },
    },
    frameworkVersion: "source-checkout",
  },
};

describe("Agent Core runtime client", () => {
  it("reads and explicitly refreshes the bridge registry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(runtimeResponse));
    const client = new AgentCoreRuntimeClient({ fetcher });

    const status = await client.getStatus(undefined, true);

    expect(status.entrypoint).toBe("openjiuwen.harness.create_deep_agent");
    expect(status.tools[0].id).toBe("inspect_input");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/agent-core?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("starts and cancels with Trace authority but never accepts a key", async () => {
    const invocation = {
      apiVersion: "1.0.0",
      invocation: {
        id: "ac_test",
        traceId: "tr_test",
        runtimeId: "agent-core-deep-agent",
        providerId: "openrouter",
        modelId: "openrouter/free",
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
    const client = new AgentCoreRuntimeClient({ fetcher });

    await client.startInvocation({
      traceId: "tr_test",
      writeToken: "tw_secret",
      modelId: "openrouter/free",
      input: "run the agent",
      maxOutputTokens: 128,
    });
    await client.cancelInvocation("ac_test", "tw_secret");

    const startInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "X-Trace-Token": "tw_secret" });
    expect(String(startInit.body)).toContain("run the agent");
    expect(String(startInit.body)).not.toContain("apiKey");
    expect(fetcher.mock.calls[1][0]).toContain("/ac_test/cancel");
  });

  it("rejects a registry that claims ready without configured", async () => {
    const client = new AgentCoreRuntimeClient({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ...runtimeResponse,
        runtime: { ...runtimeResponse.runtime, configured: false },
      })),
    });

    await expect(client.getStatus()).rejects.toThrow(/invalid shape/);
  });
});
