"""Bounded, read-only GitHub pull-request inspection for the Change Plane."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from http import HTTPStatus
from typing import Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .git_changes import HUNK_HEADER
from .repository import RepositoryIdentity


GITHUB_API_VERSION = "2026-03-10"
GITHUB_API_ORIGIN = "https://api.github.com"
OWNER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class GitHubPullRequestError(RuntimeError):
    """Stable error raised by the remote read-only adapter."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.BAD_GATEWAY,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class GitHubPullRequestReference:
    owner: str
    repository: str
    number: int


@dataclass(frozen=True, slots=True)
class GitHubPullRequestOptions:
    max_files: int = 500


@dataclass(frozen=True, slots=True)
class JsonHttpResponse:
    status: int
    body: object
    headers: Mapping[str, str]


JsonRequester = Callable[[Request, float, int], JsonHttpResponse]


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(  # type: ignore[no-untyped-def]
        self,
        req,
        fp,
        code,
        msg,
        headers,
        newurl,
    ):
        return None


def _response_headers(headers: object) -> dict[str, str]:
    if not hasattr(headers, "items"):
        return {}
    return {str(key).lower(): str(value) for key, value in headers.items()}  # type: ignore[union-attr]


def _decode_json(raw: bytes) -> object:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GitHubPullRequestError(
            "github_invalid_response",
            "GitHub returned an unreadable JSON response.",
        ) from exc


def _default_requester(
    request: Request,
    timeout_seconds: float,
    max_response_bytes: int,
) -> JsonHttpResponse:
    opener = build_opener(_NoRedirectHandler())
    try:
        response = opener.open(request, timeout=timeout_seconds)
    except HTTPError as exc:
        raw = exc.read(max_response_bytes + 1)
        if len(raw) > max_response_bytes:
            raise GitHubPullRequestError(
                "github_response_limit",
                "GitHub error response exceeded the configured memory limit.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            ) from exc
        body: object
        try:
            body = _decode_json(raw)
        except GitHubPullRequestError:
            body = {}
        return JsonHttpResponse(exc.code, body, _response_headers(exc.headers))
    except (OSError, URLError) as exc:
        raise GitHubPullRequestError(
            "github_unavailable",
            "GitHub could not be reached from the local companion service.",
        ) from exc

    with response:
        final_url = response.geturl()
        if not final_url.startswith(f"{GITHUB_API_ORIGIN}/"):
            raise GitHubPullRequestError(
                "github_untrusted_redirect",
                "GitHub returned a redirect outside the allowed API origin.",
            )
        raw = response.read(max_response_bytes + 1)
        if len(raw) > max_response_bytes:
            raise GitHubPullRequestError(
                "github_response_limit",
                "GitHub response exceeded the configured memory limit.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        return JsonHttpResponse(
            response.status,
            _decode_json(raw),
            _response_headers(response.headers),
        )


def _non_negative_integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GitHubPullRequestError(
            "github_invalid_response",
            f"GitHub returned an invalid {field_name} field.",
        )
    return value


def _required_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise GitHubPullRequestError(
            "github_invalid_response",
            f"GitHub returned an invalid {field_name} field.",
        )
    return value


def _record(value: object, field_name: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise GitHubPullRequestError(
            "github_invalid_response",
            f"GitHub returned an invalid {field_name} object.",
        )
    return value


def _normalize_path(raw_path: object) -> str:
    path = _required_string(raw_path, "filename").replace("\\", "/").strip("/")
    parts = path.split("/")
    if not path or any(part in {"", ".", ".."} for part in parts):
        raise GitHubPullRequestError(
            "github_invalid_response",
            "GitHub returned an invalid repository-relative filename.",
        )
    return path


def _parse_patch_hunks(patch: object) -> list[dict[str, int]]:
    if not isinstance(patch, str):
        return []
    hunks: list[dict[str, int]] = []
    for line in patch.splitlines():
        match = HUNK_HEADER.match(line)
        if not match:
            continue
        hunks.append(
            {
                "oldStart": int(match.group("old_start")),
                "oldLines": int(match.group("old_lines") or "1"),
                "newStart": int(match.group("new_start")),
                "newLines": int(match.group("new_lines") or "1"),
            }
        )
    return hunks


def _status(value: object) -> tuple[str, str]:
    raw = _required_string(value, "file status")
    return {
        "added": ("added", "A"),
        "removed": ("deleted", "D"),
        "renamed": ("renamed", "R"),
        "copied": ("copied", "C"),
        "modified": ("modified", "M"),
        "changed": ("modified", "M"),
        "unchanged": ("modified", "M"),
    }.get(raw, ("modified", "M"))


def _optional_rate_integer(headers: Mapping[str, str], name: str) -> int | None:
    value = headers.get(name)
    if value is None:
        return None
    try:
        return max(0, int(value))
    except ValueError:
        return None


class GitHubPullRequestInspector:
    """Read public or server-token-authorized GitHub PR metadata and files."""

    def __init__(
        self,
        *,
        token: str | None = None,
        timeout_seconds: float = 15.0,
        max_response_bytes: int = 8_000_000,
        requester: JsonRequester | None = None,
    ) -> None:
        self._token = (
            token
            if token is not None
            else os.environ.get("OPENJIUWEN_GITHUB_TOKEN")
        )
        self._timeout_seconds = timeout_seconds
        self._max_response_bytes = max_response_bytes
        self._requester = requester or _default_requester

    def inspect(
        self,
        identity: RepositoryIdentity,
        reference: GitHubPullRequestReference,
        options: GitHubPullRequestOptions = GitHubPullRequestOptions(),
    ) -> dict[str, object]:
        owner, repository, number = self._validate_reference(reference)
        if not 1 <= options.max_files <= 1_000:
            raise GitHubPullRequestError(
                "invalid_file_limit",
                "maxFiles must be between 1 and 1000.",
                status=HTTPStatus.BAD_REQUEST,
            )

        pull_response = self._get(f"/repos/{owner}/{repository}/pulls/{number}")
        pull = _record(pull_response.body, "pull request")
        changed_files = _non_negative_integer(pull.get("changed_files"), "changed_files")

        files: list[dict[str, object]] = []
        last_headers = pull_response.headers
        page = 1
        while len(files) < min(changed_files, options.max_files):
            response = self._get(
                f"/repos/{owner}/{repository}/pulls/{number}/files?per_page=100&page={page}"
            )
            last_headers = response.headers
            if not isinstance(response.body, list):
                raise GitHubPullRequestError(
                    "github_invalid_response",
                    "GitHub returned an invalid pull-request file list.",
                )
            if not response.body:
                break
            for raw_file in response.body:
                if len(files) >= options.max_files:
                    break
                files.append(self._project_file(owner, repository, number, raw_file))
            if len(response.body) < 100:
                break
            page += 1

        truncated = changed_files > len(files)
        missing_patches = sum(1 for file in files if not file["patchAvailable"])
        warnings: list[str] = []
        if truncated:
            warnings.append(
                f"Pull-request file list truncated from {changed_files} to {len(files)}."
            )
        if missing_patches:
            warnings.append(
                f"GitHub omitted patch text for {missing_patches} file(s); "
                "those files use file-level impact only."
            )

        head = self._project_branch(pull.get("head"), "head")
        base = self._project_branch(pull.get("base"), "base")
        title = _required_string(pull.get("title"), "title")
        state = _required_string(pull.get("state"), "state")
        if state not in {"open", "closed"}:
            raise GitHubPullRequestError(
                "github_invalid_response",
                "GitHub returned an unsupported pull-request state.",
            )
        draft = pull.get("draft", False)
        merged = pull.get("merged", False)
        if not isinstance(draft, bool) or not isinstance(merged, bool):
            raise GitHubPullRequestError(
                "github_invalid_response",
                "GitHub returned invalid pull-request flags.",
            )
        user = _record(pull.get("user"), "user")
        author = _required_string(user.get("login"), "user.login")
        additions = sum(int(file["additions"]) for file in files)
        deletions = sum(int(file["deletions"]) for file in files)
        rate_limit = {
            "limit": _optional_rate_integer(last_headers, "x-ratelimit-limit"),
            "remaining": _optional_rate_integer(last_headers, "x-ratelimit-remaining"),
            "resetEpoch": _optional_rate_integer(last_headers, "x-ratelimit-reset"),
        }

        return {
            "apiVersion": "1.0.0",
            "repository": identity.to_api_dict(),
            "comparison": {
                "mode": "github-pr",
                "base": {"requested": base["ref"], "resolved": base["sha"]},
                "head": {"requested": head["ref"], "resolved": head["sha"]},
                "mergeBase": None,
            },
            "pullRequest": {
                "provider": "github",
                "owner": owner,
                "repository": repository,
                "number": number,
                "title": title,
                "state": state,
                "draft": draft,
                "merged": merged,
                "author": author,
                "htmlUrl": f"https://github.com/{owner}/{repository}/pull/{number}",
                "head": head,
                "base": base,
                "changedFiles": changed_files,
                "additions": _non_negative_integer(pull.get("additions"), "additions"),
                "deletions": _non_negative_integer(pull.get("deletions"), "deletions"),
                "rateLimit": rate_limit,
            },
            "files": files,
            "statistics": {
                "files": len(files),
                "additions": additions,
                "deletions": deletions,
                "binaryFiles": sum(1 for file in files if file["binary"]),
                "truncated": truncated,
            },
            "warnings": warnings,
            "remoteOperations": {
                "networkRead": True,
                "mutation": False,
                "authenticated": bool(self._token),
            },
            "writeOperations": False,
        }

    def _validate_reference(
        self,
        reference: GitHubPullRequestReference,
    ) -> tuple[str, str, int]:
        owner = reference.owner.strip()
        repository = reference.repository.strip()
        number = reference.number
        if not OWNER_PATTERN.fullmatch(owner):
            raise GitHubPullRequestError(
                "invalid_github_owner",
                "owner is not a valid GitHub organization or account name.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if (
            not REPOSITORY_PATTERN.fullmatch(repository)
            or repository in {".", ".."}
            or repository.lower().endswith(".git")
        ):
            raise GitHubPullRequestError(
                "invalid_github_repository",
                "repository is not a valid GitHub repository name.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if (
            isinstance(number, bool)
            or not isinstance(number, int)
            or not 1 <= number <= 2_147_483_647
        ):
            raise GitHubPullRequestError(
                "invalid_pull_request_number",
                "pullNumber must be a positive integer.",
                status=HTTPStatus.BAD_REQUEST,
            )
        return owner, repository, number

    def _get(self, path: str) -> JsonHttpResponse:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "OpenJiuwen-Visualization/0.2",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        request = Request(f"{GITHUB_API_ORIGIN}{path}", headers=headers, method="GET")
        response = self._requester(
            request,
            self._timeout_seconds,
            self._max_response_bytes,
        )
        if 200 <= response.status < 300:
            return response
        remaining = _optional_rate_integer(response.headers, "x-ratelimit-remaining")
        if response.status == HTTPStatus.FORBIDDEN and remaining == 0:
            raise GitHubPullRequestError(
                "github_rate_limited",
                "GitHub API rate limit is exhausted; retry after the reported reset time.",
                status=HTTPStatus.TOO_MANY_REQUESTS,
            )
        if response.status == HTTPStatus.NOT_FOUND:
            raise GitHubPullRequestError(
                "github_pull_request_not_found",
                "GitHub pull request was not found or is not visible to the server token.",
                status=HTTPStatus.NOT_FOUND,
            )
        if response.status == HTTPStatus.UNAUTHORIZED:
            raise GitHubPullRequestError(
                "github_authentication_failed",
                "The server-side GitHub token was rejected.",
                status=HTTPStatus.BAD_GATEWAY,
            )
        raise GitHubPullRequestError(
            "github_request_failed",
            f"GitHub API request failed with HTTP {response.status}.",
        )

    def _project_branch(self, value: object, field_name: str) -> dict[str, str | None]:
        branch = _record(value, field_name)
        raw_repository = branch.get("repo")
        repository = (
            _record(raw_repository, f"{field_name}.repo")
            if raw_repository is not None
            else None
        )
        return {
            "ref": _required_string(branch.get("ref"), f"{field_name}.ref"),
            "sha": _required_string(branch.get("sha"), f"{field_name}.sha"),
            "label": _required_string(branch.get("label"), f"{field_name}.label"),
            "repository": (
                _required_string(
                    repository.get("full_name"),
                    f"{field_name}.repo.full_name",
                )
                if repository is not None
                else None
            ),
        }

    def _project_file(
        self,
        owner: str,
        repository: str,
        number: int,
        value: object,
    ) -> dict[str, object]:
        raw_file = _record(value, "pull-request file")
        path = _normalize_path(raw_file.get("filename"))
        status, status_code = _status(raw_file.get("status"))
        additions = _non_negative_integer(raw_file.get("additions"), "file additions")
        deletions = _non_negative_integer(raw_file.get("deletions"), "file deletions")
        changes = _non_negative_integer(raw_file.get("changes"), "file changes")
        patch_available = isinstance(raw_file.get("patch"), str)
        file_id = hashlib.sha256(
            f"github\0{owner}/{repository}\0{number}\0{path}".encode("utf-8")
        ).hexdigest()[:20]
        result: dict[str, object] = {
            "id": f"git-file:{file_id}",
            "path": path,
            "status": status,
            "statusCode": status_code,
            "staged": False,
            "unstaged": False,
            "untracked": False,
            "binary": not patch_available and changes == 0,
            "patchAvailable": patch_available,
            "additions": additions,
            "deletions": deletions,
            "hunks": _parse_patch_hunks(raw_file.get("patch")),
        }
        previous_path = raw_file.get("previous_filename")
        if previous_path is not None:
            result["previousPath"] = _normalize_path(previous_path)
        return result
