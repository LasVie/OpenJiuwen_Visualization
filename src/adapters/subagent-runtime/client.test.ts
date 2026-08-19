import { describe, expect, it, vi } from "vitest";
import { SubagentRuntimeClient } from "./client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const runtimeResponse = {
  apiVersion: "1.0.0",
  runtime: {
    id: "agent-core-task-tool-subagent",
    label: "Agent Core · TaskTool Subagent",
    status: "ready",
    configured: true,
    protocol: "openjiuwen.subagent.bridge/1.0",
    entrypoint: "openjiuwen.harness.tools.subagent.task_tool.TaskTool.invoke",
    executionIsolation: "fixed-subprocess",
    credentialPolicy: "local-service-only",
    providerId: "openrouter",
    profile: "fixed-single-child",
    dispatcher: "task-tool",
    runMode: "foreground",
    sessionPolicy: "ephemeral",
    workspaceIsolation: "subdirectory",
    contextOwnership: "per-agent",
    swarmFlow: false,
    streaming: true,
    cancellation: true,
    childType: "analysis_subagent",
    tools: [
      { id: "task_tool", role: "parent", policy: "delegate-only" },
      { id: "inspect_delegated_task", role: "child", policy: "read-only" },
    ],
    models: [{ id: "openrouter/free", label: "openrouter/free", default: true }],
    defaultModelId: "openrouter/free",
    limits: {
      maxInputCharacters: 64_000,
      maxSystemCharacters: 32_000,
      minOutputTokens: 16,
      maxOutputTokens: 4_096,
      defaultOutputTokens: 512,
      maxIterations: 6,
      maxDepth: 1,
      maxChildren: 1,
      maxActiveInvocations: 1,
    },
    diagnostic: { code: "ready", message: "ready" },
    frameworkVersion: "source-checkout",
  },
};

describe("Subagent runtime client", () => {
  it("validates and refreshes the fixed single-child registry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(runtimeResponse));
    const client = new SubagentRuntimeClient({ fetcher });

    const status = await client.getStatus(undefined, true);

    expect(status.profile).toBe("fixed-single-child");
    expect(status.dispatcher).toBe("task-tool");
    expect(status.limits.maxDepth).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/subagents?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("starts and cancels with Trace authority and no provider credential field", async () => {
    const response = {
      apiVersion: "1.0.0",
      invocation: {
        id: "sub_test",
        traceId: "tr_test",
        runtimeId: "agent-core-task-tool-subagent",
        providerId: "openrouter",
        modelId: "openrouter/free",
        parentSessionId: "session_sub_test",
        childType: "analysis_subagent",
        childSubjectId: "subagent:sub_test:analysis",
        status: "accepted",
        cancellationEndpoint: "/cancel",
      },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(response, 202))
      .mockResolvedValueOnce(jsonResponse({
        ...response,
        invocation: { ...response.invocation, status: "cancelling" },
      }, 202));
    const client = new SubagentRuntimeClient({ fetcher });

    await client.startInvocation({
      traceId: "tr_test",
      writeToken: "tw_secret",
      modelId: "openrouter/free",
      input: "delegate this task",
      maxOutputTokens: 128,
    });
    await client.cancelInvocation("sub_test", "tw_secret");

    const startInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "X-Trace-Token": "tw_secret" });
    expect(String(startInit.body)).toContain("delegate this task");
    expect(String(startInit.body)).not.toContain("apiKey");
    expect(fetcher.mock.calls[1][0]).toContain("/sub_test/cancel");
  });

  it("rejects a registry that expands the fixed depth", async () => {
    const client = new SubagentRuntimeClient({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ...runtimeResponse,
        runtime: {
          ...runtimeResponse.runtime,
          limits: { ...runtimeResponse.runtime.limits, maxDepth: 2 },
        },
      })),
    });

    await expect(client.getStatus()).rejects.toThrow(/invalid shape/);
  });
});
