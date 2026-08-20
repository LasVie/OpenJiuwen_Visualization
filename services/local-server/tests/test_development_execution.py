from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.development_execution import (
    DevelopmentExecutionError,
    DevelopmentExecutionStore,
)
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.plugin_host import (
    DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class DevelopmentExecutionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="development-execution-",
            dir=runtime_temp,
        )
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        (self.repository / "sample.txt").write_text("hello\n", encoding="utf-8")
        runner = self.repository / "services" / "local-server" / "scripts"
        runner.mkdir(parents=True)
        (runner / "run_tests.py").write_text(
            "print('CONTROLLED-TEST-PASSED')\n",
            encoding="utf-8",
        )
        self._git("init", "-b", "main")
        self._git("config", "user.name", "Fixture")
        self._git("config", "user.email", "fixture@example.invalid")
        self._git("add", ".")
        self._git("commit", "-m", "initial fixture")
        self.config = LocalServiceConfig.create(
            allowed_roots=[self.root],
            development_execution_path=self.root / "state" / "executions.sqlite3",
            development_worktree_root=self.root / "state" / "worktrees",
        )
        self.identity = RepositoryResolver(self.config).resolve(self.repository)
        self.store = DevelopmentExecutionStore(
            self.config.development_execution_path,
            self.config.development_worktree_root,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.repository), *args],
            check=check,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )

    @staticmethod
    def _patch() -> str:
        return """diff --git a/sample.txt b/sample.txt
--- a/sample.txt
+++ b/sample.txt
@@ -1 +1 @@
-hello
+hello controlled
"""

    def _preview(self) -> dict:
        return self.store.create_preview(
            self.identity,
            expected_revision=self.identity.revision,
            intent="Update the sample in an isolated branch.",
            patch=self._patch(),
        )["execution"]

    def test_preview_is_read_only_bounded_and_persisted(self) -> None:
        branches_before = self._git("branch", "--format=%(refname:short)").stdout
        execution = self._preview()
        branches_after = self._git("branch", "--format=%(refname:short)").stdout
        reopened = DevelopmentExecutionStore(
            self.config.development_execution_path,
            self.config.development_worktree_root,
        ).get_execution(execution["id"])["execution"]

        self.assertEqual(branches_before, branches_after)
        self.assertEqual((self.repository / "sample.txt").read_text(encoding="utf-8"), "hello\n")
        self.assertEqual(execution["status"], "previewed")
        self.assertEqual(execution["files"][0]["path"], "sample.txt")
        self.assertEqual(execution["statistics"]["files"], 1)
        self.assertEqual(execution["testProfiles"][0]["id"], "local-server-tests")
        self.assertEqual(reopened["unifiedDiff"], self._patch())
        self.assertFalse(reopened["policy"]["sourceWorkingTreeWrite"])
        self.assertFalse(reopened["policy"]["automaticPush"])

    def test_applies_tests_commits_and_rolls_back_only_the_generated_branch(self) -> None:
        execution = self._preview()
        applied = self.store.apply(
            execution["id"],
            preview_sha256=execution["previewSha256"],
            identity=self.identity,
        )["execution"]
        worktree = Path(applied["worktreePath"])

        self.assertEqual(applied["status"], "applied")
        self.assertEqual((worktree / "sample.txt").read_text(encoding="utf-8"), "hello controlled\n")
        self.assertEqual((self.repository / "sample.txt").read_text(encoding="utf-8"), "hello\n")

        profile = applied["testProfiles"][0]
        tested = self.store.run_test(
            execution["id"],
            preview_sha256=execution["previewSha256"],
            profile_id=profile["id"],
            plan_sha256=profile["planSha256"],
        )["execution"]
        self.assertEqual(tested["status"], "tested")
        self.assertIn("CONTROLLED-TEST-PASSED", tested["lastTest"]["stdout"])

        commit_preview = self.store.preview_commit(
            execution["id"],
            preview_sha256=execution["previewSha256"],
            message="feat: update controlled sample",
        )["commitPreview"]
        committed = self.store.commit(
            execution["id"],
            preview_sha256=execution["previewSha256"],
            message=commit_preview["message"],
            approval_sha256=commit_preview["approvalSha256"],
        )["execution"]

        self.assertEqual(committed["status"], "committed")
        self.assertFalse(worktree.exists())
        self.assertTrue(committed["commitSha"])
        self.assertFalse(committed["policy"]["automaticPush"])
        branch = committed["branchName"]
        self.assertEqual(
            self._git("show", f"{branch}:sample.txt").stdout,
            "hello controlled\n",
        )

        rolled_back = self.store.rollback(
            execution["id"],
            preview_sha256=execution["previewSha256"],
            approval_sha256=committed["approvals"]["rollbackSha256"],
        )["execution"]
        self.assertEqual(rolled_back["status"], "rolled_back")
        self.assertNotEqual(
            self._git("show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode,
            0,
        )
        self.assertEqual((self.repository / "sample.txt").read_text(encoding="utf-8"), "hello\n")
        self.assertFalse(RepositoryResolver(self.config).resolve(self.repository).dirty)

    def test_rejects_stale_dirty_destructive_and_digest_changed_operations(self) -> None:
        with self.assertRaises(DevelopmentExecutionError) as destructive:
            self.store.create_preview(
                self.identity,
                expected_revision=self.identity.revision,
                intent="Delete the sample.",
                patch="""diff --git a/sample.txt b/sample.txt
deleted file mode 100644
--- a/sample.txt
+++ /dev/null
@@ -1 +0,0 @@
-hello
""",
            )
        self.assertEqual(destructive.exception.code, "unsupported_patch_operation")

        execution = self._preview()
        with self.assertRaises(DevelopmentExecutionError) as digest:
            self.store.apply(
                execution["id"],
                preview_sha256="0" * 64,
                identity=self.identity,
            )
        self.assertEqual(digest.exception.code, "execution_preview_changed")

        (self.repository / "sample.txt").write_text("dirty\n", encoding="utf-8")
        dirty_identity = RepositoryResolver(self.config).resolve(self.repository)
        with self.assertRaises(DevelopmentExecutionError) as dirty:
            self.store.apply(
                execution["id"],
                preview_sha256=execution["previewSha256"],
                identity=dirty_identity,
            )
        self.assertEqual(dirty.exception.code, "repository_changed")

    def test_api_requires_module_enablement_and_exact_confirmation_for_each_write(self) -> None:
        api = LocalRepositoryApi(
            self.config,
            development_execution_store=self.store,
        )
        unavailable = api.dispatch(
            "POST",
            "/api/v1/development/executions",
            body={
                "repositoryPath": str(self.repository),
                "baseRevision": self.identity.revision,
                "intent": "Controlled API flow.",
                "unifiedDiff": self._patch(),
            },
        )
        self.assertEqual(unavailable.status, 503)

        enabled = api.dispatch(
            "POST",
            f"/api/v1/plugin-host/plugins/{DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID}/state",
            body={"enabled": True},
        )
        preview = api.dispatch(
            "POST",
            "/api/v1/development/executions",
            body={
                "repositoryPath": str(self.repository),
                "baseRevision": self.identity.revision,
                "intent": "Controlled API flow.",
                "unifiedDiff": self._patch(),
            },
        )
        self.assertEqual(enabled.status, 200)
        self.assertEqual(preview.status, 201)
        execution = preview.body["execution"]

        denied = api.dispatch(
            "POST",
            f"/api/v1/development/executions/{execution['id']}/apply",
            body={
                "previewSha256": execution["previewSha256"],
                "confirmed": False,
            },
        )
        applied = api.dispatch(
            "POST",
            f"/api/v1/development/executions/{execution['id']}/apply",
            body={
                "previewSha256": execution["previewSha256"],
                "confirmed": True,
            },
        )
        self.assertEqual(denied.status, 409)
        self.assertEqual(denied.body["error"]["code"], "operation_confirmation_required")
        self.assertEqual(applied.status, 200)
        self.assertEqual(applied.body["execution"]["status"], "applied")

        applied_execution = applied.body["execution"]
        rollback_denied = api.dispatch(
            "POST",
            f"/api/v1/development/executions/{execution['id']}/rollback",
            body={
                "previewSha256": execution["previewSha256"],
                "approvalSha256": applied_execution["approvals"]["rollbackSha256"],
                "confirmed": False,
            },
        )
        rolled_back = api.dispatch(
            "POST",
            f"/api/v1/development/executions/{execution['id']}/rollback",
            body={
                "previewSha256": execution["previewSha256"],
                "approvalSha256": applied_execution["approvals"]["rollbackSha256"],
                "confirmed": True,
            },
        )
        self.assertEqual(rollback_denied.status, 409)
        self.assertEqual(rolled_back.status, 200)
        self.assertEqual(rolled_back.body["execution"]["status"], "rolled_back")
        self.assertEqual((self.repository / "sample.txt").read_text(encoding="utf-8"), "hello\n")


if __name__ == "__main__":
    unittest.main()
