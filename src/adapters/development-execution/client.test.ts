import { describe, expect, it, vi } from "vitest";
import {
  DevelopmentExecutionClient,
  type DevelopmentExecution,
} from "./client";

function execution(): DevelopmentExecution {
  return {
    id: "devexec_0123456789abcdef0123456789abcdef",
    repository: {
      id: "repo-1",
      name: "agent-core",
      path: "C:\\workspace\\agent-core",
      sourceBranch: "develop",
      baseRevision: "a".repeat(40),
    },
    branchName: "openjiuwen-visualization/0123456789ab",
    worktreePath: "C:\\workspace\\.openjiuwen-visualization\\development-worktrees\\devexec_0123456789abcdef0123456789abcdef",
    status: "previewed",
    patchSha256: "b".repeat(64),
    previewSha256: "c".repeat(64),
    files: [{ path: "openjiuwen/core.py", additions: 2, deletions: 1, added: false }],
    statistics: { files: 1, additions: 2, deletions: 1, bytes: 240 },
    testProfiles: [{
      id: "python-pytest",
      label: "Python focused test suite",
      command: "python -B -m pytest -q",
      workingDirectory: ".",
      timeoutSeconds: 180,
      planSha256: "d".repeat(64),
    }],
    lastTest: null,
    commitSha: null,
    lastErrorCode: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    policy: {
      sourceWorkingTreeWrite: false,
      isolatedWorktree: true,
      exactPathAllowlist: true,
      arbitraryCommands: false,
      perOperationConfirmation: true,
      automaticPush: false,
      rollbackAvailable: true,
    },
    approvals: {
      applySha256: "c".repeat(64),
      rollbackSha256: "e".repeat(64),
      commitPreviewRequired: true,
    },
    intent: "Review this patch",
    unifiedDiff: "diff --git a/openjiuwen/core.py b/openjiuwen/core.py\n",
    appliedDiff: null,
    appliedDiffSha256: null,
    events: [],
  };
}

function response(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("DevelopmentExecutionClient", () => {
  it("uses versioned routes and sends only exact reviewed approval fields", async () => {
    const item = execution();
    const commitPreview = {
      executionId: item.id,
      branchName: item.branchName,
      message: "feat: controlled change",
      stagedDiffSha256: "f".repeat(64),
      approvalSha256: "1".repeat(64),
      push: false as const,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => response({
        apiVersion: "1.0.0",
        executions: [item],
        total: 1,
        limit: 50,
        offset: 0,
      }))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", execution: item }, 201))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", execution: item }))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", execution: item }))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", commitPreview }))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", execution: item }))
      .mockImplementationOnce(() => response({ apiVersion: "1.0.0", execution: item }));
    const client = new DevelopmentExecutionClient({ fetcher });

    await client.list();
    await client.preview({
      repositoryPath: item.repository.path,
      baseRevision: item.repository.baseRevision,
      intent: "Review this patch",
      unifiedDiff: item.unifiedDiff!,
    });
    await client.apply(item, true);
    await client.runTest(item, item.testProfiles[0]!, true);
    const preview = await client.previewCommit(item, commitPreview.message);
    await client.commit(item, preview, true);
    await client.rollback(item, true);

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8765/api/v1/development/executions?limit=50&offset=0",
      "http://127.0.0.1:8765/api/v1/development/executions",
      `http://127.0.0.1:8765/api/v1/development/executions/${item.id}/apply`,
      `http://127.0.0.1:8765/api/v1/development/executions/${item.id}/tests`,
      `http://127.0.0.1:8765/api/v1/development/executions/${item.id}/commit-preview`,
      `http://127.0.0.1:8765/api/v1/development/executions/${item.id}/commit`,
      `http://127.0.0.1:8765/api/v1/development/executions/${item.id}/rollback`,
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({
      previewSha256: item.previewSha256,
      confirmed: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body))).toEqual({
      previewSha256: item.previewSha256,
      profileId: "python-pytest",
      planSha256: "d".repeat(64),
      confirmed: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[5]![1]?.body))).toEqual({
      previewSha256: item.previewSha256,
      approvalSha256: "1".repeat(64),
      message: "feat: controlled change",
      confirmed: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[6]![1]?.body))).toEqual({
      previewSha256: item.previewSha256,
      approvalSha256: "e".repeat(64),
      confirmed: true,
    });
  });

  it("rejects a response that claims source writes or automatic push", async () => {
    const unsafe = execution();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => response({
      apiVersion: "1.0.0",
      execution: {
        ...unsafe,
        policy: { ...unsafe.policy, automaticPush: true },
      },
    }));
    const client = new DevelopmentExecutionClient({ fetcher });

    await expect(client.get(unsafe.id)).rejects.toThrow(/does not match API/);
  });
});
