import { describe, expect, it } from "vitest";
import type {
  ArchivedEventPreview,
  ArchivedSessionDetail,
  ArchivedTraceSession,
} from "../../adapters/trace-archive";
import { compareArchivedRuns } from "./model";

function session(id: string, overrides: Partial<ArchivedTraceSession> = {}): ArchivedTraceSession {
  return {
    id,
    owner: "agent-core",
    label: id,
    status: "completed",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:01Z",
    archivedAt: "2026-08-19T00:00:01Z",
    eventCount: 0,
    lastSequence: 0,
    maxTokens: 8192,
    byteCount: 0,
    storedRawBytes: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    contextMessageCount: 0,
    schemaVersion: 1,
    rawTextStored: true,
    ...overrides,
  };
}

function event(
  traceId: string,
  sequence: number,
  overrides: Partial<ArchivedEventPreview> = {},
): ArchivedEventPreview {
  return {
    eventId: `${traceId}-${sequence}`,
    traceId,
    sequence,
    receivedAt: "2026-08-19T00:00:01Z",
    kind: "agent.invoke",
    phase: "start",
    timestampMs: sequence,
    rawAvailable: true,
    ...overrides,
  };
}

function detail(
  archivedSession: ArchivedTraceSession,
  events: ArchivedEventPreview[],
): ArchivedSessionDetail {
  return {
    apiVersion: "1.0.0",
    session: archivedSession,
    events,
    page: { after: 0, lastSequence: events.at(-1)?.sequence ?? 0, hasMore: false },
    rawIncluded: false,
  };
}

describe("compareArchivedRuns", () => {
  it("matches source-backed events across trace ids and ignores revision drift", () => {
    const leftSession = session("left", {
      eventCount: 1,
      totalTokens: 10,
      contextMessageCount: 2,
    });
    const rightSession = session("right", {
      eventCount: 2,
      totalTokens: 18,
      contextMessageCount: 5,
    });
    const source = {
      repository: "agent-core",
      path: "openjiuwen/core/agent.py",
      symbol: "DeepAgent.run",
    };
    const comparison = compareArchivedRuns(
      detail(leftSession, [event("left", 1, { definition: { ...source, revision: "aaa" } })]),
      detail(rightSession, [
        event("right", 1, { definition: { ...source, revision: "bbb" } }),
        event("right", 2, { definition: { ...source, revision: "bbb" }, phase: "end" }),
      ]),
    );

    expect(comparison.rows).toHaveLength(1);
    expect(comparison.rows[0]).toMatchObject({
      label: "DeepAgent.run",
      status: "changed",
      sourceBacked: true,
      left: { count: 1 },
      right: { count: 2, lastPhase: "end" },
    });
    expect(comparison.metrics.totalTokens.delta).toBe(8);
    expect(comparison.metrics.contextMessages.delta).toBe(3);
  });

  it("falls back to runtime kind and subject identity", () => {
    const comparison = compareArchivedRuns(
      detail(session("left"), [event("left", 1, {
        kind: "swarm.member",
        subject: { id: "member:leader", label: "Leader" },
      })]),
      detail(session("right"), [
        event("right", 1, {
          kind: "swarm.member",
          subject: { id: "member:leader", label: "Leader" },
        }),
        event("right", 2, {
          kind: "swarm.subagent",
          subject: { id: "subagent:explore", label: "Explore" },
        }),
      ]),
    );

    expect(comparison.summary.unchanged).toBe(1);
    expect(comparison.summary.added).toBe(1);
    expect(comparison.rows.find((row) => row.label === "Explore")?.status).toBe("added");
  });
});
