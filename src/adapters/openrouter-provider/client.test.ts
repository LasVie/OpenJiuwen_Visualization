import { describe, expect, it, vi } from "vitest";
import { OpenRouterProviderClient } from "./client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const providerResponse = {
  apiVersion: "1.0.0",
  provider: {
    id: "openrouter",
    label: "OpenRouter",
    status: "ready",
    configured: true,
    protocol: "openrouter.chat-completions",
    credentialPolicy: "local-service-only",
    streaming: true,
    cancellation: true,
    usage: true,
    models: [{ id: "openrouter/free", label: "openrouter/free", default: true }],
    defaultModelId: "openrouter/free",
    limits: {
      maxInputCharacters: 64_000,
      maxSystemCharacters: 32_000,
      minOutputTokens: 16,
      maxOutputTokens: 4_096,
      defaultOutputTokens: 512,
      maxActiveInvocations: 4,
    },
    network: {
      origin: "https://openrouter.ai",
      endpoint: "/api/v1/chat/completions",
    },
  },
};

describe("OpenRouter provider client", () => {
  it("reads only the public provider registry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(providerResponse));
    const client = new OpenRouterProviderClient({ fetcher });

    const status = await client.getStatus();

    expect(status.defaultModelId).toBe("openrouter/free");
    expect(status.credentialPolicy).toBe("local-service-only");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/model-providers/openrouter",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("starts and cancels through Trace authority without a provider key", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        apiVersion: "1.0.0",
        invocation: {
          id: "or_test",
          traceId: "tr_test",
          providerId: "openrouter",
          modelId: "openrouter/free",
          status: "accepted",
          cancellationEndpoint: "/cancel",
        },
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        apiVersion: "1.0.0",
        invocation: {
          id: "or_test",
          traceId: "tr_test",
          providerId: "openrouter",
          modelId: "openrouter/free",
          status: "cancelling",
        },
      }, 202));
    const client = new OpenRouterProviderClient({ fetcher });

    await client.startInvocation({
      traceId: "tr_test",
      writeToken: "tw_secret",
      modelId: "openrouter/free",
      input: "hello",
      maxOutputTokens: 128,
    });
    await client.cancelInvocation("or_test", "tw_secret");

    const startInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "X-Trace-Token": "tw_secret" });
    expect(startInit.body).toBe(JSON.stringify({
      traceId: "tr_test",
      modelId: "openrouter/free",
      input: "hello",
      maxOutputTokens: 128,
    }));
    expect(String(startInit.body)).not.toContain("apiKey");
    expect(fetcher.mock.calls[1][0]).toContain("/or_test/cancel");
  });

  it("rejects malformed registry responses", async () => {
    const client = new OpenRouterProviderClient({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ...providerResponse,
        provider: { ...providerResponse.provider, models: [] },
      })),
    });

    await expect(client.getStatus()).rejects.toThrow(/invalid shape/);
  });
});
