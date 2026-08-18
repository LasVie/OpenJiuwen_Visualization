import { describe, expect, it, vi } from "vitest";
import {
  LocalRepositoryClient,
  LocalRepositoryClientError,
} from "./client";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const scanPayload = {
  apiVersion: "1.0.0",
  repository: {
    id: "repo-1",
    name: "agent-core",
    owner: "agent-core",
    path: "C:\\workspace\\agent-core",
    scanScope: "C:\\workspace\\agent-core",
    revision: "abc123",
    branch: "develop",
    dirty: false,
  },
  graph: {
    schemaVersion: "1.0.0",
    nodes: [],
    edges: [],
  },
  statistics: {
    pythonFiles: 1,
    symbols: 1,
    nodes: 2,
    edges: 1,
    durationMs: 4,
    truncated: false,
  },
  warnings: [],
};

describe("local repository client", () => {
  it("accepts only loopback origins", () => {
    expect(() => new LocalRepositoryClient({ baseUrl: "https://example.com" }))
      .toThrowError(/loopback/);
    expect(() => new LocalRepositoryClient({ baseUrl: "http://user@localhost:8765" }))
      .toThrowError(/credential-free/);
    expect(new LocalRepositoryClient().baseUrl).toBe("http://127.0.0.1:8765");
  });

  it("binds the browser fetch implementation to the global object", async () => {
    const browserFetch = vi.fn(async function (this: unknown) {
      expect(this).toBe(globalThis);
      return response({ status: "ok", apiVersion: "1.0.0", mode: "read-only" });
    });
    vi.stubGlobal("fetch", browserFetch);
    try {
      const client = new LocalRepositoryClient();
      await expect(client.health()).resolves.toMatchObject({ mode: "read-only" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests a typed read-only repository scan", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(scanPayload),
    );
    const client = new LocalRepositoryClient({
      fetcher: fetcher as typeof fetch,
    });
    const result = await client.scan("C:\\workspace\\agent-core", {
      includeTests: false,
    });

    expect(result.repository.name).toBe("agent-core");
    expect(result.graph.schemaVersion).toBe("1.0.0");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/repositories/scan",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      path: "C:\\workspace\\agent-core",
      options: { includeTests: false },
    });
  });

  it("lists discovered repositories without write capabilities", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response({
          allowedRoots: ["C:\\workspace"],
          repositories: [scanPayload.repository],
          writeOperations: false,
        }),
    );
    const client = new LocalRepositoryClient({
      fetcher: fetcher as typeof fetch,
    });

    const catalog = await client.listRepositories();

    expect(catalog.repositories[0].name).toBe("agent-core");
    expect(catalog.writeOperations).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/repositories",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("requests and validates a read-only Git comparison", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response({
          apiVersion: "1.0.0",
          repository: scanPayload.repository,
          comparison: {
            mode: "compare",
            base: { requested: "main", resolved: "a".repeat(40) },
            head: { requested: "HEAD", resolved: "b".repeat(40) },
            mergeBase: "a".repeat(40),
          },
          files: [
            {
              id: "git-file:one",
              path: "src/main.py",
              status: "modified",
              statusCode: "M",
              staged: false,
              unstaged: false,
              untracked: false,
              binary: false,
              additions: 3,
              deletions: 1,
              hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 3 }],
            },
          ],
          statistics: { files: 1, additions: 3, deletions: 1, binaryFiles: 0, truncated: false },
          warnings: [],
          writeOperations: false,
        }),
    );
    const client = new LocalRepositoryClient({ fetcher: fetcher as typeof fetch });

    const result = await client.changes("C:\\workspace\\agent-core", {
      mode: "compare",
      base: "main",
      head: "HEAD",
    });

    expect(result.files[0]).toMatchObject({ path: "src/main.py", additions: 3 });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/repositories/changes",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      path: "C:\\workspace\\agent-core",
      mode: "compare",
      base: "main",
      head: "HEAD",
    });
  });

  it("preserves structured service errors", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(
          { error: { code: "path_not_allowed", message: "Outside allowed roots." } },
          403,
        ),
    );
    const client = new LocalRepositoryClient({
      fetcher: fetcher as typeof fetch,
    });

    const error = await client.scan("C:\\outside").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalRepositoryClientError);
    expect(error).toMatchObject({
      status: 403,
      code: "path_not_allowed",
      message: "Outside allowed roots.",
    });
  });
});
