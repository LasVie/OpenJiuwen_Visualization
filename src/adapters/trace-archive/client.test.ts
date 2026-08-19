import { describe, expect, it, vi } from "vitest";
import { TraceArchiveClient, TraceArchiveClientError } from "./client";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const session = {
  id: "tr_archive_1",
  owner: "agent-core",
  label: "Archived run",
  status: "completed",
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T00:00:01Z",
  archivedAt: "2026-08-19T00:00:01Z",
  eventCount: 1,
  lastSequence: 1,
  maxTokens: 8192,
  byteCount: 420,
  storedRawBytes: 520,
  totalTokens: 12,
  inputTokens: 9,
  outputTokens: 3,
  costMicros: 20,
  contextMessageCount: 1,
  schemaVersion: 1,
  rawTextStored: true,
} as const;

const storage = {
  engine: "sqlite",
  journalMode: "wal",
  schemaVersion: 1,
  databaseFile: "runtime-archive.sqlite3",
  retentionDays: 30,
  maxBytes: 2_147_483_648,
  storedBytes: 520,
  sessionCount: 1,
  oldestAt: "2026-08-19T00:00:01Z",
  newestAt: "2026-08-19T00:00:01Z",
  rawTextStored: true,
  rawReadPolicy: "explicit-only",
  localOnly: true,
} as const;

const preview = {
  eventId: "event-1",
  traceId: session.id,
  sequence: 1,
  receivedAt: "2026-08-19T00:00:01Z",
  kind: "context.delta",
  phase: "instant",
  timestampMs: 1,
  summary: "用户输入（已脱敏）",
  rawAvailable: true,
};

describe("TraceArchiveClient", () => {
  it("accepts only credential-free loopback origins", () => {
    expect(() => new TraceArchiveClient({ baseUrl: "https://example.com" }))
      .toThrow(/loopback/);
    expect(new TraceArchiveClient({ baseUrl: "http://localhost:8765/" }).baseUrl)
      .toBe("http://localhost:8765");
  });

  it("lists and loads only redacted preview routes by default", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?after=")) {
        return response({
          apiVersion: "1.0.0",
          session,
          events: [preview],
          page: { after: 0, lastSequence: 1, hasMore: false },
          rawIncluded: false,
        });
      }
      return response({
        apiVersion: "1.0.0",
        storage,
        sessions: [session],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      });
    });
    const client = new TraceArchiveClient({ fetcher: fetcher as typeof fetch });

    const listed = await client.listSessions();
    const loaded = await client.getSession(session.id);

    expect(listed.storage.journalMode).toBe("wal");
    expect(loaded.events[0].summary).toContain("已脱敏");
    expect(fetcher.mock.calls.map(([url]) => String(url)).join("\n"))
      .not.toContain("/raw");
  });

  it("reads raw events and continuous Context only through explicit POST calls", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.mode === "events") {
        return response({
          apiVersion: "1.0.0",
          traceId: session.id,
          events: [{ ...preview, context: { messages: [{ raw: "FULL-RAW" }] } }],
          rawIncluded: true,
          localOnly: true,
        });
      }
      return response({
        apiVersion: "1.0.0",
        traceId: session.id,
        frames: [{
          sequence: 1,
          operation: "append",
          messages: [{
            id: "message-1",
            role: "user",
            label: "User",
            raw: "FULL-RAW",
            preview: "已脱敏",
            tokens: 3,
            source: "runtime.input",
          }],
          removeMessageIds: [],
        }],
        rawIncluded: true,
        localOnly: true,
      });
    });
    const client = new TraceArchiveClient({ fetcher: fetcher as typeof fetch });

    const event = await client.revealEvents(session.id, [1]);
    const context = await client.revealContext(session.id);

    expect(JSON.stringify(event)).toContain("FULL-RAW");
    expect(context.frames[0].messages[0].raw).toBe("FULL-RAW");
    expect(fetcher.mock.calls).toHaveLength(2);
    fetcher.mock.calls.forEach(([, init]) => expect(init?.method).toBe("POST"));
  });

  it("surfaces stable service errors and validates delete confirmation", async () => {
    const denied = vi.fn(async () => response({
      error: { code: "archive_session_open", message: "Run is still open." },
    }, 409));
    const client = new TraceArchiveClient({ fetcher: denied as typeof fetch });

    await expect(client.deleteSession(session.id)).rejects.toMatchObject({
      status: 409,
      code: "archive_session_open",
    } satisfies Partial<TraceArchiveClientError>);
  });
});
