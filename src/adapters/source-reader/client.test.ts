import { describe, expect, it, vi } from "vitest";
import {
  SourceReaderClient,
  SourceReaderClientError,
} from "./client";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const repository = {
  id: "repo-1",
  name: "agent-core",
  owner: "agent-core",
  path: "C:\\workspace\\agent-core",
  scanScope: "C:\\workspace\\agent-core",
  revision: "a".repeat(40),
  branch: "develop",
  dirty: false,
};

const payload = {
  apiVersion: "1.0.0",
  repository,
  source: {
    path: "src/agent.py",
    language: "python",
    encoding: "utf-8",
    contentSha256: "b".repeat(64),
    requestedRevision: repository.revision,
    currentRevision: repository.revision,
    revisionMatches: true,
    contentBasis: "working-tree",
  },
  range: {
    requestedStartLine: 10,
    requestedEndLine: 12,
    focusStartLine: 10,
    focusEndLine: 12,
    startLine: 8,
    endLine: 14,
    totalLines: 80,
    truncated: true,
    focusTruncated: false,
  },
  lines: [
    { number: 8, text: "class Agent:", focus: false },
    { number: 10, text: "    def run(self):", focus: true },
  ],
  readOnly: true,
  writeOperations: false,
};

describe("source reader adapter", () => {
  it("requests a bounded source reference through the loopback service", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => response(payload),
    );
    const client = new SourceReaderClient({ fetcher: fetcher as typeof fetch });
    const result = await client.read(repository.path, {
      path: "src/agent.py",
      revision: repository.revision,
      symbol: "Agent.run",
      startLine: 10,
      endLine: 12,
    }, { contextLines: 4, maxLines: 200 });

    expect(result.lines[1]).toEqual({
      number: 10,
      text: "    def run(self):",
      focus: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/v1/repositories/source",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      path: repository.path,
      relativePath: "src/agent.py",
      revision: repository.revision,
      startLine: 10,
      endLine: 12,
      options: { contextLines: 4, maxLines: 200 },
    });
  });

  it("rejects malformed responses and preserves structured server errors", async () => {
    const malformed = new SourceReaderClient({
      fetcher: vi.fn(async () => response({ ...payload, readOnly: false })) as typeof fetch,
    });
    await expect(malformed.read(repository.path, {
      path: "src/agent.py",
    })).rejects.toThrowError(/does not match/);

    const denied = new SourceReaderClient({
      fetcher: vi.fn(async () => response({
        error: { code: "source_outside_scope", message: "Outside scan scope." },
      }, 403)) as typeof fetch,
    });
    const error = await denied.read(repository.path, {
      path: "../secret.txt",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SourceReaderClientError);
    expect(error).toMatchObject({ status: 403, code: "source_outside_scope" });
  });
});
