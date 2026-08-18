from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.git_changes import (
    GitChangeError,
    GitChangeInspector,
    GitChangeOptions,
)
from openjiuwen_visualization_server.repository import RepositoryIdentity


ROOT = Path(__file__).resolve().parents[3]
BASE_SHA = "1" * 40
HEAD_SHA = "2" * 40
MERGE_BASE_SHA = "3" * 40


def identity() -> RepositoryIdentity:
    return RepositoryIdentity(
        id="repository-test",
        name="sample",
        owner="local-repository",
        root=ROOT,
        scan_root=ROOT,
        revision=HEAD_SHA,
        branch="main",
        dirty=True,
    )


class GitChangeInspectorTests(unittest.TestCase):
    def test_projects_worktree_status_stats_and_zero_context_hunks(self) -> None:
        def runner(_cwd: Path, args: tuple[str, ...]) -> str:
            if args[0] == "status":
                return " M src/main.py\0R  src/new.py\0src/old.py\0?? notes.txt\0"
            if "--numstat" in args:
                return "3\t1\tsrc/main.py\x002\t0\t\x00src/old.py\x00src/new.py\x00"
            if "--unified=0" in args:
                return (
                    "--- a/src/main.py\n+++ b/src/main.py\n@@ -10,2 +10,4 @@\n"
                    "--- a/src/old.py\n+++ b/src/new.py\n@@ -1 +1,2 @@\n"
                )
            raise AssertionError(args)

        result = GitChangeInspector(runner=runner).inspect(identity())
        files = {item["path"]: item for item in result["files"]}

        self.assertEqual(result["comparison"]["mode"], "working-tree")
        self.assertFalse(result["writeOperations"])
        self.assertEqual(files["src/main.py"]["status"], "modified")
        self.assertTrue(files["src/main.py"]["unstaged"])
        self.assertEqual(files["src/main.py"]["hunks"][0]["newStart"], 10)
        self.assertEqual(files["src/new.py"]["previousPath"], "src/old.py")
        self.assertEqual(files["src/new.py"]["additions"], 2)
        self.assertTrue(files["notes.txt"]["untracked"])

    def test_resolves_compare_refs_through_merge_base_and_rejects_options(self) -> None:
        def runner(_cwd: Path, args: tuple[str, ...]) -> str:
            if args[0] == "rev-parse":
                return BASE_SHA if args[-1].startswith("main") else HEAD_SHA
            if args[0] == "merge-base":
                return MERGE_BASE_SHA
            if "--name-status" in args:
                return "M\0src/main.py\0R100\0src/old.py\0src/new.py\0"
            if "--numstat" in args:
                return "4\t2\tsrc/main.py\x001\t0\t\x00src/old.py\x00src/new.py\x00"
            if "--unified=0" in args:
                return "--- a/src/main.py\n+++ b/src/main.py\n@@ -3 +3,2 @@\n"
            raise AssertionError(args)

        inspector = GitChangeInspector(runner=runner)
        result = inspector.inspect(
            identity(),
            GitChangeOptions(mode="compare", base="main", head="feature/change"),
        )

        self.assertEqual(result["comparison"]["mergeBase"], MERGE_BASE_SHA)
        self.assertEqual(result["comparison"]["base"]["resolved"], BASE_SHA)
        self.assertEqual(result["comparison"]["head"]["resolved"], HEAD_SHA)
        self.assertEqual(result["statistics"]["files"], 2)

        with self.assertRaisesRegex(GitChangeError, "non-option"):
            inspector.inspect(
                identity(),
                GitChangeOptions(mode="compare", base="--output=/tmp/file", head="HEAD"),
            )


if __name__ == "__main__":
    unittest.main()
