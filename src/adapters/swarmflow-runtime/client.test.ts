import { describe, expect, it, vi } from "vitest";
import {
  SwarmFlowRuntimeClient,
} from "./client";

const runtime = {
  id: "agent-core-swarmflow",
  label: "Agent Core · SwarmFlow",
  status: "ready",
  configured: true,
  protocol: "openjiuwen.swarmflow.bridge/1.0",
  entrypoint: "openjiuwen.agent_teams.workflow.run_swarmflow",
  executionIsolation: "fixed-subprocess",
  credentialPolicy: "local-service-only",
  providerId: "openrouter",
  profile: "fixed-two-phase",
  teamMode: "workflow",
  dispatchMode: "sequential",
  workerMode: "ephemeral-team-harness",
  swarmFlow: true,
  streaming: true,
  cancellation: true,
  humanInLoop: false,
  parallel: false,
  contextOwnership: "per-agent",
  tools: [],
  phases: [
    { id: "understand-input", label: "Understand Input", agent: "Analysis Worker" },
    { id: "synthesize-response", label: "Synthesize Response", agent: "Response Worker" },
  ],
  models: [{ id: "test/model", label: "test/model", default: true }],
  defaultModelId: "test/model",
  limits: {
    maxInputCharacters: 120000,
    maxSystemCharacters: 32000,
    minOutputTokens: 16,
    maxOutputTokens: 16384,
    defaultOutputTokens: 512,
    maxIterations: 8,
    maxActiveInvocations: 1,
    maxPhases: 2,
    maxAgents: 2,
  },
  diagnostic: { code: "ready", message: "ready" },
  managedEnvironment: {
    id: "swarm-core-env",
    consumer: "swarmflow",
    state: "ready",
    desiredFingerprint: "b".repeat(64),
    activeFingerprint: "b".repeat(64),
    pythonVersion: "3.11.9",
    uvVersion: "0.9.0",
    autoReconcile: "before-runtime-invocation",
    diagnostic: { code: "ready", message: "verified" },
  },
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("SwarmFlowRuntimeClient", () => {
  it("validates the fixed runtime profile", async () => {
    const fetcher = vi.fn(() => response({ apiVersion: "1.0.0", runtime }));
    const client = new SwarmFlowRuntimeClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: fetcher as typeof fetch,
    });

    await expect(client.getStatus(undefined, true)).resolves.toEqual(runtime);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/swarmflows?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("starts and cancels with trace authority while omitting undefined fields", async () => {
    const invocation = {
      id: "wf_1",
      traceId: "trace_1",
      runtimeId: "agent-core-swarmflow",
      providerId: "openrouter",
      modelId: "test/model",
      teamName: "visualization_swarmflow_wf_1",
      sessionId: "session_wf_1",
      runId: "workflow_wf_1",
      status: "accepted",
      cancellationEndpoint: "/api/v1/swarmflows/invocations/wf_1/cancel",
    };
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", invocation }))
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        invocation: { ...invocation, status: "cancelling", cancellationEndpoint: undefined },
      }));
    const client = new SwarmFlowRuntimeClient({ fetcher: fetcher as typeof fetch });

    await client.startInvocation({
      traceId: "trace_1",
      writeToken: "write-secret",
      modelId: "test/model",
      input: "run this flow",
      maxOutputTokens: 256,
    });
    await client.cancelInvocation("wf_1", "write-secret");

    const startInit = fetcher.mock.calls[0]![1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "X-Trace-Token": "write-secret" });
    expect(JSON.parse(String(startInit.body))).toEqual({
      traceId: "trace_1",
      modelId: "test/model",
      input: "run this flow",
      maxOutputTokens: 256,
    });
    expect(fetcher.mock.calls[1]![0]).toContain("/api/v1/swarmflows/invocations/wf_1/cancel");
  });

  it("rejects malformed profiles and surfaces stable server errors", async () => {
    const malformed = vi.fn(() => response({
      apiVersion: "1.0.0",
      runtime: { ...runtime, parallel: true },
    }));
    await expect(new SwarmFlowRuntimeClient({
      fetcher: malformed as typeof fetch,
    }).getStatus()).rejects.toThrow("invalid shape");

    const failed = vi.fn(() => response({
      error: { code: "swarmflow_capacity_reached", message: "busy" },
    }, 429));
    await expect(new SwarmFlowRuntimeClient({
      fetcher: failed as typeof fetch,
    }).getStatus()).rejects.toMatchObject({
      code: "swarmflow_capacity_reached",
      status: 429,
      message: "busy",
    });
  });
});
