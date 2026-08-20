import { describe, expect, it, vi } from "vitest";
import {
  DevelopmentSessionClient,
  DevelopmentSessionClientError,
} from "./client";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const session = {
  id: `dev_${"a".repeat(32)}`,
  label: "Development Session",
  intentPreview: "本机开发意图 · 24 字",
  repository: {
    name: "agent-core",
    owner: "agent-core",
    path: "C:\\workspace\\agent-core",
    branch: "develop",
    revision: "b".repeat(40),
    dirty: false,
  },
  engine: "deterministic-static",
  entryPlane: "runtime",
  counts: { evidence: 2, impacts: 4, changes: 2, tests: 3, patches: 2 },
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
  byteCount: 4096,
  contentSha256: "c".repeat(64),
  schemaVersion: 1,
  fullAnalysisStored: true,
} as const;

const storage = {
  engine: "sqlite",
  journalMode: "wal",
  schemaVersion: 1,
  databaseFile: "development-sessions.sqlite3",
  retentionDays: 30,
  maxBytes: 2_147_483_648,
  storedBytes: 4096,
  sessionCount: 1,
  oldestAt: session.createdAt,
  newestAt: session.updatedAt,
  fullAnalysisStored: true,
  fullReadPolicy: "restore-or-export",
  localOnly: true,
} as const;

const analysis = {
  intent: "FULL-LOCAL-INTENT",
  repository: { owner: "agent-core" },
  readOnly: true,
  repositoryWrite: false,
};

describe("DevelopmentSessionClient", () => {
  it("accepts only a credential-free loopback origin", () => {
    expect(() => new DevelopmentSessionClient({ baseUrl: "https://example.com" }))
      .toThrow(/loopback/);
    expect(new DevelopmentSessionClient({ baseUrl: "http://localhost:8765/" }).baseUrl)
      .toBe("http://localhost:8765");
  });

  it("lists metadata without reading full analysis", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => response({
      apiVersion: "1.0.0",
      storage,
      sessions: [session],
      pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      fullAnalysisIncluded: false,
    }));
    const client = new DevelopmentSessionClient({ fetcher: fetcher as typeof fetch });

    const listed = await client.listSessions();

    expect(listed.storage.journalMode).toBe("wal");
    expect(listed.sessions[0].counts.impacts).toBe(4);
    expect(String(fetcher.mock.calls[0][0])).not.toContain("/export");
  });

  it("creates, restores, exports and deletes through separate explicit routes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return response({
          apiVersion: "1.0.0",
          session,
          analysisStored: true,
          localOnly: true,
        }, 201);
      }
      if (init?.method === "DELETE") {
        return response({
          apiVersion: "1.0.0",
          deleted: true,
          deletedFullAnalysis: true,
        });
      }
      if (url.endsWith("/export")) {
        return response({
          apiVersion: "1.0.0",
          exportedAt: "2026-08-20T00:01:00Z",
          session,
          analysis,
          containsFullAnalysis: true,
          localSource: true,
        });
      }
      return response({
        apiVersion: "1.0.0",
        session,
        analysis,
        fullAnalysisIncluded: true,
        localOnly: true,
      });
    });
    const client = new DevelopmentSessionClient({ fetcher: fetcher as typeof fetch });

    const created = await client.createSession(analysis);
    const restored = await client.getSession(session.id);
    const exported = await client.exportSession(session.id);
    await client.deleteSession(session.id);

    expect(created.id).toBe(session.id);
    expect(restored.analysis.intent).toBe("FULL-LOCAL-INTENT");
    expect(exported.containsFullAnalysis).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8765/api/v1/development/sessions",
      `http://127.0.0.1:8765/api/v1/development/sessions/${session.id}`,
      `http://127.0.0.1:8765/api/v1/development/sessions/${session.id}/export`,
      `http://127.0.0.1:8765/api/v1/development/sessions/${session.id}`,
    ]);
  });

  it("surfaces stable service errors", async () => {
    const denied = vi.fn(async () => response({
      error: { code: "path_not_allowed", message: "Repository path is not allowed." },
    }, 403));
    const client = new DevelopmentSessionClient({ fetcher: denied as typeof fetch });

    await expect(client.createSession(analysis)).rejects.toMatchObject({
      status: 403,
      code: "path_not_allowed",
    } satisfies Partial<DevelopmentSessionClientError>);
  });
});
