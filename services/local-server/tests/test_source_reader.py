from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.repository import RepositoryIdentity
from openjiuwen_visualization_server.source_reader import (
    SourceReadError,
    SourceReadOptions,
    SourceReader,
)


TESTS_ROOT = Path(__file__).resolve().parent
FIXTURE_ROOT = TESTS_ROOT / "fixtures" / "sample_project"
REVISION = "a" * 40


def identity(*, scan_root: Path = FIXTURE_ROOT) -> RepositoryIdentity:
    return RepositoryIdentity(
        id="source-reader-test",
        name="sample_project",
        owner="local-repository",
        root=TESTS_ROOT,
        scan_root=scan_root,
        revision=REVISION,
        branch="main",
        dirty=False,
    )


class SourceReaderTests(unittest.TestCase):
    def test_reads_numbered_focused_lines_from_the_current_worktree(self) -> None:
        result = SourceReader().read(
            identity(),
            "fixtures/sample_project/openjiuwen/deep_agent.py",
            start_line=10,
            end_line=13,
            requested_revision=REVISION,
            options=SourceReadOptions(context_lines=2, max_lines=20),
        )

        self.assertEqual(result["source"]["language"], "python")
        self.assertEqual(result["source"]["contentBasis"], "working-tree")
        self.assertTrue(result["source"]["revisionMatches"])
        self.assertEqual(result["range"]["startLine"], 8)
        self.assertEqual(result["range"]["focusStartLine"], 10)
        self.assertTrue(any(line["focus"] for line in result["lines"]))
        self.assertIn("class DeepAgent", "\n".join(line["text"] for line in result["lines"]))
        self.assertEqual(len(result["source"]["contentSha256"]), 64)
        self.assertTrue(result["readOnly"])
        self.assertFalse(result["writeOperations"])

    def test_enforces_scan_scope_paths_file_limits_and_ranges(self) -> None:
        reader = SourceReader()
        failures = [
            ("../test_api.py", {}, "invalid_source_path"),
            ("test_api.py", {}, "source_outside_scope"),
            ("fixtures/sample_project/openjiuwen", {}, "source_not_file"),
            (
                "fixtures/sample_project/openjiuwen/tooling.py",
                {"options": SourceReadOptions(max_file_bytes=1_024)},
                "source_file_limit",
            ),
            (
                "fixtures/sample_project/openjiuwen/deep_agent.py",
                {"start_line": 10_000},
                "source_range_unavailable",
            ),
        ]
        for relative_path, keyword_arguments, expected_code in failures:
            with self.subTest(relative_path=relative_path, expected_code=expected_code):
                with self.assertRaises(SourceReadError) as context:
                    reader.read(identity(), relative_path, **keyword_arguments)
                self.assertEqual(context.exception.code, expected_code)

    def test_marks_bounded_excerpts_and_revision_mismatches(self) -> None:
        result = SourceReader().read(
            identity(),
            "fixtures/sample_project/openjiuwen/deep_agent.py",
            start_line=4,
            end_line=12,
            requested_revision="b" * 40,
            options=SourceReadOptions(context_lines=0, max_lines=3),
        )

        self.assertFalse(result["source"]["revisionMatches"])
        self.assertTrue(result["range"]["truncated"])
        self.assertTrue(result["range"]["focusTruncated"])
        self.assertEqual([line["number"] for line in result["lines"]], [4, 5, 6])


if __name__ == "__main__":
    unittest.main()
