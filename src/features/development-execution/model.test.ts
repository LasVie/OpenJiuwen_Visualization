import { describe, expect, it } from "vitest";
import type { DevelopmentExecution } from "../../adapters/development-execution";
import { projectDevelopmentExecutionFlow } from "./model";

function execution(overrides: Partial<DevelopmentExecution> = {}): DevelopmentExecution {
  return {
    id: "devexec_0123456789abcdef0123456789abcdef",
    repository: {
      id: "repo",
      name: "agent-core",
      path: "C:\\workspace\\agent-core",
      sourceBranch: "develop",
      baseRevision: "a".repeat(40),
    },
    branchName: "openjiuwen-visualization/0123456789ab",
    worktreePath: "C:\\workspace\\worktrees\\one",
    status: "previewed",
    patchSha256: "b".repeat(64),
    previewSha256: "c".repeat(64),
    files: [{ path: "core.py", additions: 1, deletions: 1, added: false }],
    statistics: { files: 1, additions: 1, deletions: 1, bytes: 100 },
    testProfiles: [{
      id: "python-pytest",
      label: "Python tests",
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
    ...overrides,
  };
}

describe("controlled execution graph", () => {
  it("keeps the source checkout as a protected invariant and writes on a separate chain", () => {
    const projection = projectDevelopmentExecutionFlow(execution(), "review");
    expect(projection.nodes.map((node) => [node.data.step, node.data.state])).toEqual([
      ["review", "success"],
      ["apply", "waiting"],
      ["test", "waiting"],
      ["commit", "waiting"],
      ["source", "protected"],
      ["rollback", "available"],
    ]);
    expect(projection.edges.map((edge) => [edge.source, edge.target])).toContainEqual([
      "execution:review",
      "execution:source",
    ]);
  });

  it("shows test failure without claiming a commit, then records rollback separately", () => {
    const failed = projectDevelopmentExecutionFlow(execution({
      status: "test_failed",
      appliedDiffSha256: "f".repeat(64),
      lastTest: {
        profileId: "python-pytest",
        label: "Python tests",
        command: "python -B -m pytest -q",
        planSha256: "d".repeat(64),
        status: "failed",
        exitCode: 1,
        durationMs: 22,
        stdout: "",
        stderr: "failure",
        trackedSideEffects: [],
      },
    }), "test");
    expect(failed.nodes.find((node) => node.data.step === "test")?.data.state).toBe("error");
    expect(failed.nodes.find((node) => node.data.step === "commit")?.data.state).toBe("waiting");

    const rolledBack = projectDevelopmentExecutionFlow(execution({
      status: "rolled_back",
      appliedDiffSha256: "f".repeat(64),
      policy: { ...execution().policy, rollbackAvailable: false },
    }), "rollback");
    expect(rolledBack.nodes.find((node) => node.data.step === "rollback")?.data.state).toBe("success");
    expect(rolledBack.nodes.find((node) => node.data.step === "source")?.data.state).toBe("protected");
  });
});
