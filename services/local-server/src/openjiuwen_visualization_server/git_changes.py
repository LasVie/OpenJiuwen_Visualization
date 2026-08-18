"""Read-only, bounded Git comparison for the Change Plane."""

from __future__ import annotations

import ast
import hashlib
import re
import subprocess
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path, PurePosixPath
from typing import Callable

from .repository import RepositoryIdentity


CHANGE_API_VERSION = "1.0.0"
HUNK_HEADER = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_lines>\d+))? "
    r"\+(?P<new_start>\d+)(?:,(?P<new_lines>\d+))? @@"
)
REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,239}$")


class GitChangeError(RuntimeError):
    """Stable, non-mutating comparison failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.UNPROCESSABLE_ENTITY,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class GitChangeOptions:
    mode: str = "working-tree"
    base: str | None = None
    head: str | None = None
    include_untracked: bool = True
    max_files: int = 500


GitRunner = Callable[[Path, tuple[str, ...]], str]


def _normalize_path(raw_path: str) -> str:
    path = raw_path.replace("\\", "/").strip()
    pure = PurePosixPath(path)
    if not path or pure.is_absolute() or ".." in pure.parts:
        raise GitChangeError("invalid_git_path", "Git returned an invalid repository-relative path.")
    return pure.as_posix()


def _change_type(status: str) -> str:
    code = status[:1]
    return {
        "A": "added",
        "D": "deleted",
        "R": "renamed",
        "C": "copied",
        "U": "conflicted",
        "T": "modified",
        "M": "modified",
    }.get(code, "modified")


def _decode_diff_path(raw_path: str) -> str | None:
    token = raw_path.strip()
    if token == "/dev/null":
        return None
    if token.startswith('"'):
        try:
            decoded = ast.literal_eval(token)
        except (SyntaxError, ValueError) as exc:
            raise GitChangeError("invalid_git_path", "Git returned an unreadable quoted path.") from exc
        if not isinstance(decoded, str):
            raise GitChangeError("invalid_git_path", "Git returned an unreadable quoted path.")
        token = decoded
    if token.startswith(("a/", "b/")):
        token = token[2:]
    return _normalize_path(token)


def _parse_name_status(raw: str) -> dict[str, dict[str, object]]:
    fields = raw.split("\0")
    changes: dict[str, dict[str, object]] = {}
    index = 0
    while index < len(fields):
        status = fields[index]
        index += 1
        if not status:
            continue
        if index >= len(fields):
            raise GitChangeError("invalid_git_output", "Git name-status output was truncated.")
        previous_path: str | None = None
        if status.startswith(("R", "C")):
            previous_path = _normalize_path(fields[index])
            index += 1
            if index >= len(fields):
                raise GitChangeError("invalid_git_output", "Git rename output was truncated.")
        path = _normalize_path(fields[index])
        index += 1
        changes[path] = {
            "path": path,
            "previousPath": previous_path,
            "status": _change_type(status),
            "statusCode": status,
        }
    return changes


def _parse_porcelain_status(raw: str) -> dict[str, dict[str, object]]:
    fields = raw.split("\0")
    changes: dict[str, dict[str, object]] = {}
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if not record:
            continue
        if len(record) < 4 or record[2] != " ":
            raise GitChangeError("invalid_git_output", "Git status output was not porcelain v1.")
        xy = record[:2]
        path = _normalize_path(record[3:])
        previous_path: str | None = None
        if "R" in xy or "C" in xy:
            if index >= len(fields):
                raise GitChangeError("invalid_git_output", "Git rename status was truncated.")
            previous_path = _normalize_path(fields[index])
            index += 1
        untracked = xy == "??"
        ignored = xy == "!!"
        if ignored:
            continue
        status_code = next((code for code in xy if code not in {" ", "?"}), "A" if untracked else "M")
        changes[path] = {
            "path": path,
            "previousPath": previous_path,
            "status": "untracked" if untracked else _change_type(status_code),
            "statusCode": xy,
            "staged": not untracked and xy[0] not in {" ", "?"},
            "unstaged": not untracked and xy[1] not in {" ", "?"},
            "untracked": untracked,
        }
    return changes


def _parse_numstat(raw: str) -> dict[str, tuple[int | None, int | None]]:
    fields = raw.split("\0")
    statistics: dict[str, tuple[int | None, int | None]] = {}
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if not record:
            continue
        columns = record.split("\t")
        if len(columns) != 3:
            raise GitChangeError("invalid_git_output", "Git numstat output was malformed.")
        additions_raw, deletions_raw, path_raw = columns
        if path_raw:
            path = _normalize_path(path_raw)
        else:
            if index + 1 >= len(fields):
                raise GitChangeError("invalid_git_output", "Git rename numstat was truncated.")
            index += 1  # previous path is represented separately but status output owns it.
            path = _normalize_path(fields[index])
            index += 1
        additions = None if additions_raw == "-" else int(additions_raw)
        deletions = None if deletions_raw == "-" else int(deletions_raw)
        statistics[path] = (additions, deletions)
    return statistics


def _parse_hunks(raw: str) -> dict[str, list[dict[str, int]]]:
    hunks: dict[str, list[dict[str, int]]] = {}
    old_path: str | None = None
    current_path: str | None = None
    for line in raw.splitlines():
        if line.startswith("--- "):
            old_path = _decode_diff_path(line[4:])
            continue
        if line.startswith("+++ "):
            new_path = _decode_diff_path(line[4:])
            current_path = new_path or old_path
            continue
        match = HUNK_HEADER.match(line)
        if not match or current_path is None:
            continue
        old_lines = int(match.group("old_lines") or "1")
        new_lines = int(match.group("new_lines") or "1")
        hunks.setdefault(current_path, []).append(
            {
                "oldStart": int(match.group("old_start")),
                "oldLines": old_lines,
                "newStart": int(match.group("new_start")),
                "newLines": new_lines,
            }
        )
    return hunks


class GitChangeInspector:
    def __init__(
        self,
        *,
        git_timeout_seconds: float = 15.0,
        max_git_output_bytes: int = 16_000_000,
        runner: GitRunner | None = None,
    ) -> None:
        self._git_timeout_seconds = git_timeout_seconds
        self._max_git_output_bytes = max_git_output_bytes
        self._runner = runner

    def inspect(
        self,
        identity: RepositoryIdentity,
        options: GitChangeOptions = GitChangeOptions(),
    ) -> dict[str, object]:
        if options.mode not in {"working-tree", "compare"}:
            raise GitChangeError("invalid_change_mode", "mode must be working-tree or compare.", status=400)
        if not 1 <= options.max_files <= 2_000:
            raise GitChangeError("invalid_file_limit", "maxFiles must be between 1 and 2000.", status=400)

        warnings: list[str] = []
        if options.mode == "working-tree":
            comparison, changes, numstat, hunks = self._working_tree(identity, options)
        else:
            comparison, changes, numstat, hunks = self._compare(identity, options)

        if not options.include_untracked:
            changes = {
                path: change
                for path, change in changes.items()
                if not change.get("untracked")
            }
        ordered_paths = sorted(changes, key=str.casefold)
        truncated = len(ordered_paths) > options.max_files
        if truncated:
            warnings.append(
                f"Changed file list truncated from {len(ordered_paths)} to {options.max_files}."
            )
            ordered_paths = ordered_paths[: options.max_files]

        files: list[dict[str, object]] = []
        for path in ordered_paths:
            change = changes[path]
            additions, deletions = numstat.get(path, (0, 0))
            file_id = hashlib.sha256(
                f"{identity.id}\0{options.mode}\0{path}".encode("utf-8")
            ).hexdigest()[:20]
            file_record: dict[str, object] = {
                "id": f"git-file:{file_id}",
                "path": path,
                "status": change["status"],
                "statusCode": change["statusCode"],
                "staged": bool(change.get("staged", False)),
                "unstaged": bool(change.get("unstaged", False)),
                "untracked": bool(change.get("untracked", False)),
                "binary": additions is None or deletions is None,
                "additions": additions,
                "deletions": deletions,
                "hunks": hunks.get(path, []),
            }
            previous_path = change.get("previousPath")
            if isinstance(previous_path, str):
                file_record["previousPath"] = previous_path
            files.append(file_record)

        known_additions = sum(int(file["additions"] or 0) for file in files)
        known_deletions = sum(int(file["deletions"] or 0) for file in files)
        return {
            "apiVersion": CHANGE_API_VERSION,
            "repository": identity.to_api_dict(),
            "comparison": comparison,
            "files": files,
            "statistics": {
                "files": len(files),
                "additions": known_additions,
                "deletions": known_deletions,
                "binaryFiles": sum(1 for file in files if file["binary"]),
                "truncated": truncated,
            },
            "warnings": warnings,
            "writeOperations": False,
        }

    def _working_tree(
        self,
        identity: RepositoryIdentity,
        options: GitChangeOptions,
    ) -> tuple[
        dict[str, object],
        dict[str, dict[str, object]],
        dict[str, tuple[int | None, int | None]],
        dict[str, list[dict[str, int]]],
    ]:
        status = self._git(
            identity.root,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all" if options.include_untracked else "--untracked-files=no",
        )
        changes = _parse_porcelain_status(status)
        diff_args = (identity.revision, "--")
        numstat = _parse_numstat(
            self._git(identity.root, "diff", "--numstat", "-z", "--find-renames", *diff_args)
        )
        hunks = _parse_hunks(
            self._git(
                identity.root,
                "diff",
                "--unified=0",
                "--no-color",
                "--no-ext-diff",
                "--find-renames",
                *diff_args,
            )
        )
        return (
            {
                "mode": "working-tree",
                "base": {"requested": "HEAD", "resolved": identity.revision},
                "head": {"requested": "WORKTREE", "resolved": None},
                "mergeBase": identity.revision,
            },
            changes,
            numstat,
            hunks,
        )

    def _compare(
        self,
        identity: RepositoryIdentity,
        options: GitChangeOptions,
    ) -> tuple[
        dict[str, object],
        dict[str, dict[str, object]],
        dict[str, tuple[int | None, int | None]],
        dict[str, list[dict[str, int]]],
    ]:
        base = self._validated_ref(options.base, "base")
        head = self._validated_ref(options.head or "HEAD", "head")
        resolved_base = self._resolve_ref(identity.root, base)
        resolved_head = self._resolve_ref(identity.root, head)
        merge_base = self._git(identity.root, "merge-base", resolved_base, resolved_head).strip()
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", merge_base):
            raise GitChangeError("merge_base_unavailable", "Git could not resolve a merge base.")
        diff_args = (merge_base, resolved_head, "--")
        changes = _parse_name_status(
            self._git(identity.root, "diff", "--name-status", "-z", "--find-renames", *diff_args)
        )
        for change in changes.values():
            change.update({"staged": False, "unstaged": False, "untracked": False})
        numstat = _parse_numstat(
            self._git(identity.root, "diff", "--numstat", "-z", "--find-renames", *diff_args)
        )
        hunks = _parse_hunks(
            self._git(
                identity.root,
                "diff",
                "--unified=0",
                "--no-color",
                "--no-ext-diff",
                "--find-renames",
                *diff_args,
            )
        )
        return (
            {
                "mode": "compare",
                "base": {"requested": base, "resolved": resolved_base},
                "head": {"requested": head, "resolved": resolved_head},
                "mergeBase": merge_base,
            },
            changes,
            numstat,
            hunks,
        )

    def _validated_ref(self, value: str | None, field_name: str) -> str:
        if not isinstance(value, str) or not REF_PATTERN.fullmatch(value):
            raise GitChangeError(
                "invalid_git_ref",
                f"{field_name} must be a non-option local Git revision expression.",
                status=400,
            )
        return value

    def _resolve_ref(self, cwd: Path, value: str) -> str:
        resolved = self._git(cwd, "rev-parse", "--verify", f"{value}^{{commit}}").strip()
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", resolved):
            raise GitChangeError("git_ref_unavailable", f"Git revision is not available locally: {value}")
        return resolved

    def _git(self, cwd: Path, *args: str) -> str:
        if self._runner is not None:
            return self._runner(cwd, args)
        try:
            completed = subprocess.run(
                ["git", "-c", "core.quotepath=false", "-C", str(cwd), *args],
                check=False,
                capture_output=True,
                timeout=self._git_timeout_seconds,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GitChangeError("git_command_failed", f"Read-only Git command failed: {args[0]}") from exc
        if completed.returncode != 0:
            raise GitChangeError("git_command_failed", f"Read-only Git command failed: {args[0]}")
        if len(completed.stdout) > self._max_git_output_bytes:
            raise GitChangeError(
                "git_output_limit",
                "Git comparison output exceeds the configured memory limit.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        return completed.stdout.decode("utf-8", errors="replace")
