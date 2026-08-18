import { describe, expect, it, vi } from "vitest";
import { CoreRuntimeClient } from "./client";

const trace = {
  id: "tr_client_001",
  owner: "agent-core",
  label: "Client trace",
  status: "open",
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
  eventCount: 0,
  lastSequence: 0,
  maxTokens: 8192,
  byteCount: 0,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CoreRuntimeClient", () => {
  it("allows only credential-free loopback origins", () => {
    expect(() => new CoreRuntimeClient({ baseUrl: "https://example.com" }))
      .toThrow(/loopback/);
    expect(() => new CoreRuntimeClient({ baseUrl: "http://user@127.0.0.1:8765" }))
      .toThrow(/loopback/);
    expect(new CoreRuntimeClient({ baseUrl: "http://localhost:8765/" }).baseUrl)
      .toBe("http://localhost:8765");
  });

  it("creates a memory-only trace and validates its protocol", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      apiVersion: "1.0.0",
      trace,
      writeToken: "tw_client_secret",
      endpoints: {
        events: `/api/v1/traces/${trace.id}/events`,
        snapshot: `/api/v1/traces/${trace.id}`,
        stream: `/api/v1/traces/${trace.id}/stream`,
      },
      storage: "memory-only",
    }, 201));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    const created = await client.createTrace({ label: "Client trace" });

    expect(created.trace.id).toBe(trace.id);
    expect(created.writeToken).toBe("tw_client_secret");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/traces",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });

  it("sends the scoped token when appending normalized events", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ accepted: 1 }, 202));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    await client.appendEvents(trace.id, "tw_client_secret", [
      {
        eventId: "event-1",
        kind: "agent.invoke",
        phase: "start",
        timestampMs: 0,
        spanId: "invoke",
      },
    ]);

    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ "X-Trace-Token": "tw_client_secret" });
    expect(JSON.parse(String(init.body)).events[0].kind).toBe("agent.invoke");
  });

  it("loads and validates incremental snapshots", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      apiVersion: "1.0.0",
      trace: { ...trace, eventCount: 1, lastSequence: 1 },
      events: [
        {
          eventId: "event-1",
          traceId: trace.id,
          sequence: 1,
          receivedAt: "2026-08-18T00:00:01Z",
          kind: "model.call",
          phase: "start",
          timestampMs: 10,
          spanId: "model-1",
        },
      ],
      storage: "memory-only",
    }));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    const result = await client.getSnapshot(trace.id, 0);

    expect(result.events[0]).toMatchObject({ sequence: 1, kind: "model.call" });
  });

  it("validates Swarm subjects and Context ownership frames", async () => {
    const swarmTrace = { ...trace, owner: "jiuwenswarm" };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      apiVersion: "1.0.0",
      trace: { ...swarmTrace, eventCount: 1, lastSequence: 1 },
      events: [
        {
          eventId: "swarm-context-1",
          traceId: trace.id,
          sequence: 1,
          receivedAt: "2026-08-18T00:00:01Z",
          kind: "context.delta",
          phase: "instant",
          timestampMs: 10,
          spanId: "member-1",
          subject: {
            id: "member:leader",
            kind: "member",
            label: "Leader",
            contextOwnerId: "ctx:leader",
          },
          context: {
            operation: "append",
            ownerId: "ctx:leader",
            messages: [],
          },
        },
      ],
      storage: "memory-only",
    }));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    const result = await client.getSnapshot(trace.id, 0);

    expect(result.events[0]).toMatchObject({
      subject: { id: "member:leader", kind: "member" },
      context: { ownerId: "ctx:leader" },
    });
  });

  it("rejects malformed nested Rail evidence before projection", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        apiVersion: "1.0.0",
        trace: { ...trace, eventCount: 1, lastSequence: 1 },
        events: [
          {
            eventId: "rail-1",
            traceId: trace.id,
            sequence: 1,
            receivedAt: "2026-08-18T00:00:01Z",
            kind: "rail.hook",
            phase: "end",
            timestampMs: 10,
            spanId: "model-1",
            hook: { rail: "ContextAssembleRail" },
          },
        ],
        storage: "memory-only",
      }));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    await expect(client.getSnapshot(trace.id)).rejects.toThrow(/Runtime Trace V1/);
  });

  it("validates structured recorded model frames before projection", async () => {
    const modelFrame = {
      invocationId: "invoke-1",
      providerId: "provider.demo",
      modelId: "model.demo",
      source: "recording",
      recordingId: "recording-1",
      recordingSequence: 0,
      delta: "recorded output",
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        apiVersion: "1.0.0",
        trace: { ...trace, eventCount: 1, lastSequence: 1 },
        events: [
          {
            eventId: "model-stream-1",
            traceId: trace.id,
            sequence: 1,
            receivedAt: "2026-08-18T00:00:01Z",
            kind: "model.stream",
            phase: "instant",
            timestampMs: 10,
            spanId: "model-1",
            model: modelFrame,
          },
        ],
        storage: "memory-only",
      }));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    await expect(client.getSnapshot(trace.id)).resolves.toMatchObject({
      events: [{ kind: "model.stream", model: { delta: "recorded output" } }],
    });

    fetcher.mockImplementationOnce(async () => jsonResponse({
      apiVersion: "1.0.0",
      trace: { ...trace, eventCount: 1, lastSequence: 1 },
      events: [
        {
          eventId: "model-stream-bad",
          traceId: trace.id,
          sequence: 1,
          receivedAt: "2026-08-18T00:00:01Z",
          kind: "model.stream",
          phase: "instant",
          timestampMs: 10,
          spanId: "model-1",
          model: { ...modelFrame, delta: undefined },
        },
      ],
      storage: "memory-only",
    }));
    await expect(client.getSnapshot(trace.id)).rejects.toThrow(/Runtime Trace V1/);
  });

  it("validates structured Subagent isolation evidence before projection", async () => {
    const swarmTrace = { ...trace, owner: "jiuwenswarm" };
    const subagent = {
      invocationId: "invoke:explore",
      subagentType: "explore_agent",
      dispatcher: "task-tool",
      runMode: "foreground",
      parentSessionId: "session:parent",
      sessionId: "session:child",
      contextOwnerId: "ctx:explore",
      sessionPolicy: "ephemeral",
      workspaceIsolation: "subdirectory",
      toolPolicy: "configured",
    };
    const response = (evidence: unknown) => jsonResponse({
      apiVersion: "1.0.0",
      trace: { ...swarmTrace, eventCount: 1, lastSequence: 1 },
      events: [{
        eventId: "subagent-start",
        traceId: trace.id,
        sequence: 1,
        receivedAt: "2026-08-18T00:00:01Z",
        kind: "swarm.subagent",
        phase: "start",
        timestampMs: 10,
        spanId: "subagent-1",
        subject: {
          id: "subagent:explore",
          kind: "subagent",
          label: "Explore",
          contextOwnerId: "ctx:explore",
        },
        subagent: evidence,
      }],
      storage: "memory-only",
    });
    const fetcher = vi.fn(async () => response(subagent));
    const client = new CoreRuntimeClient({ fetcher: fetcher as typeof fetch });

    await expect(client.getSnapshot(trace.id)).resolves.toMatchObject({
      events: [{ subagent: { sessionId: "session:child" } }],
    });

    fetcher.mockImplementationOnce(async () => response({
      ...subagent,
      contextOwnerId: "ctx:other",
    }));
    await expect(client.getSnapshot(trace.id)).rejects.toThrow(/Runtime Trace V1/);
  });
});
