from __future__ import annotations

import unittest
from pathlib import Path
from urllib.request import Request

from openjiuwen_visualization_server.github_pull_requests import (
    GITHUB_API_VERSION,
    GitHubPullRequestError,
    GitHubPullRequestInspector,
    GitHubPullRequestOptions,
    GitHubPullRequestReference,
    JsonHttpResponse,
)
from openjiuwen_visualization_server.repository import RepositoryIdentity


ROOT = Path(__file__).resolve().parents[3]
HEAD_SHA = "2" * 40
BASE_SHA = "1" * 40


def identity() -> RepositoryIdentity:
    return RepositoryIdentity(
        id="repository-test",
        name="agent-core",
        owner="agent-core",
        root=ROOT,
        scan_root=ROOT,
        revision=HEAD_SHA,
        branch="feature/pr",
        dirty=False,
    )


def pull_payload(*, changed_files: int = 2) -> dict[str, object]:
    return {
        "number": 42,
        "title": "Add observable rails",
        "state": "open",
        "draft": False,
        "merged": False,
        "changed_files": changed_files,
        "additions": 8,
        "deletions": 2,
        "user": {"login": "octocat"},
        "head": {
            "ref": "feature/pr",
            "sha": HEAD_SHA,
            "label": "octocat:feature/pr",
            "repo": {"full_name": "octocat/agent-core"},
        },
        "base": {
            "ref": "develop",
            "sha": BASE_SHA,
            "label": "LasVie:develop",
            "repo": {"full_name": "LasVie/agent-core"},
        },
    }


def file_payload(
    filename: str,
    *,
    status: str = "modified",
    patch: str | None = "@@ -10,2 +10,4 @@\n-old\n+new",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "sha": "3" * 40,
        "filename": filename,
        "status": status,
        "additions": 4,
        "deletions": 2,
        "changes": 6,
    }
    if patch is not None:
        payload["patch"] = patch
    return payload


class GitHubPullRequestInspectorTests(unittest.TestCase):
    def test_projects_metadata_files_hunks_and_required_headers(self) -> None:
        requests: list[Request] = []

        def requester(request: Request, _timeout: float, _limit: int) -> JsonHttpResponse:
            requests.append(request)
            headers = {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4998",
                "x-ratelimit-reset": "1770000000",
            }
            if request.full_url.endswith("/pulls/42"):
                return JsonHttpResponse(200, pull_payload(), headers)
            return JsonHttpResponse(
                200,
                [
                    file_payload("src/agent.py"),
                    file_payload("assets/model.bin", patch=None),
                ],
                headers,
            )

        result = GitHubPullRequestInspector(
            token="server-secret",
            requester=requester,
        ).inspect(
            identity(),
            GitHubPullRequestReference("LasVie", "agent-core", 42),
        )

        self.assertEqual(result["comparison"]["mode"], "github-pr")
        self.assertEqual(result["comparison"]["head"]["resolved"], HEAD_SHA)
        self.assertIsNone(result["comparison"]["mergeBase"])
        self.assertEqual(result["pullRequest"]["title"], "Add observable rails")
        self.assertEqual(result["pullRequest"]["rateLimit"]["remaining"], 4998)
        self.assertEqual(result["files"][0]["hunks"][0]["newLines"], 4)
        self.assertFalse(result["files"][1]["patchAvailable"])
        self.assertIn("file-level impact", result["warnings"][0])
        self.assertFalse(result["writeOperations"])
        self.assertFalse(result["remoteOperations"]["mutation"])

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].get_header("User-agent"), "OpenJiuwen-Visualization/0.2")
        self.assertEqual(requests[0].get_header("X-github-api-version"), GITHUB_API_VERSION)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer server-secret")
        self.assertTrue(requests[1].full_url.endswith("/files?per_page=100&page=1"))

    def test_bounds_pagination_and_reports_truncation(self) -> None:
        requested_urls: list[str] = []

        def requester(request: Request, _timeout: float, _limit: int) -> JsonHttpResponse:
            requested_urls.append(request.full_url)
            if request.full_url.endswith("/pulls/42"):
                return JsonHttpResponse(200, pull_payload(changed_files=205), {})
            page = int(request.full_url.rsplit("=", 1)[1])
            start = (page - 1) * 100
            return JsonHttpResponse(
                200,
                [file_payload(f"src/file_{index}.py") for index in range(start, start + 100)],
                {},
            )

        result = GitHubPullRequestInspector(requester=requester).inspect(
            identity(),
            GitHubPullRequestReference("LasVie", "agent-core", 42),
            GitHubPullRequestOptions(max_files=150),
        )

        self.assertEqual(len(result["files"]), 150)
        self.assertTrue(result["statistics"]["truncated"])
        self.assertEqual(len(requested_urls), 3)
        self.assertNotIn("Authorization", requested_urls)

    def test_rejects_untrusted_identifiers_before_network_access(self) -> None:
        requester_calls = 0

        def requester(_request: Request, _timeout: float, _limit: int) -> JsonHttpResponse:
            nonlocal requester_calls
            requester_calls += 1
            raise AssertionError("network should not be reached")

        inspector = GitHubPullRequestInspector(requester=requester)
        invalid_references = [
            GitHubPullRequestReference("LasVie/other", "agent-core", 42),
            GitHubPullRequestReference("LasVie", "../agent-core", 42),
            GitHubPullRequestReference("LasVie", "agent-core.git", 42),
            GitHubPullRequestReference("LasVie", "agent-core.GIT", 42),
            GitHubPullRequestReference("LasVie", "agent-core", 0),
        ]
        for reference in invalid_references:
            with self.subTest(reference=reference):
                with self.assertRaises(GitHubPullRequestError):
                    inspector.inspect(identity(), reference)
        self.assertEqual(requester_calls, 0)

    def test_maps_not_found_and_rate_limit_without_exposing_upstream_body(self) -> None:
        responses = iter(
            [
                JsonHttpResponse(404, {"message": "secret upstream detail"}, {}),
                JsonHttpResponse(403, {}, {"x-ratelimit-remaining": "0"}),
            ]
        )

        def requester(_request: Request, _timeout: float, _limit: int) -> JsonHttpResponse:
            return next(responses)

        inspector = GitHubPullRequestInspector(requester=requester)
        first = None
        try:
            inspector.inspect(identity(), GitHubPullRequestReference("LasVie", "agent-core", 42))
        except GitHubPullRequestError as exc:
            first = exc
        self.assertIsNotNone(first)
        self.assertEqual(first.code, "github_pull_request_not_found")
        self.assertNotIn("secret upstream detail", str(first))

        with self.assertRaises(GitHubPullRequestError) as context:
            inspector.inspect(identity(), GitHubPullRequestReference("LasVie", "agent-core", 42))
        self.assertEqual(context.exception.code, "github_rate_limited")
        self.assertEqual(context.exception.status, 429)


if __name__ == "__main__":
    unittest.main()
