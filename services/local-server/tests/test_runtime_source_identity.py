from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from openjiuwen_visualization_server.runtime_source_identity import (
    git_head_revision,
    runtime_source_revisions,
)


class RuntimeSourceIdentityTests(unittest.TestCase):
    @patch("openjiuwen_visualization_server.runtime_source_identity.subprocess.run")
    def test_reads_a_bounded_head_revision_without_git_mutation(self, run) -> None:
        revision = "A" * 40
        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=revision + "\n",
            stderr="",
        )

        result = git_head_revision(Path(__file__).resolve().parent)

        self.assertEqual(result, revision.lower())
        command = run.call_args.args[0]
        self.assertEqual(command[-3:], ["rev-parse", "--verify", "HEAD"])
        self.assertEqual(run.call_args.kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")

    @patch("openjiuwen_visualization_server.runtime_source_identity.subprocess.run")
    def test_rejects_failed_or_unbounded_revision_output(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="HEAD\n",
            stderr="",
        )

        self.assertIsNone(git_head_revision(Path(__file__).resolve().parent))

    @patch("openjiuwen_visualization_server.runtime_source_identity.git_head_revision")
    def test_omits_unavailable_repositories_from_runtime_map(self, revision) -> None:
        revision.side_effect = ["a" * 40, None]

        result = runtime_source_revisions(
            (("agent-core", Path("core")), ("jiuwenswarm", Path("swarm")))
        )

        self.assertEqual(result, {"agent-core": "a" * 40})


if __name__ == "__main__":
    unittest.main()
