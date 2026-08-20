"""Controlled patch, test, and Git branch execution for Development sessions.

The executor never mutates the selected repository's checked-out working tree and
never pushes. A reviewed unified diff is first validated against an isolated Git
index. Only a one-time, digest-bound approval may create a dedicated worktree and
branch. Tests and commits are separate approved operations.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path, PurePosixPath
from typing import Iterator

from .repository import RepositoryIdentity


DEVELOPMENT_EXECUTION_API_VERSION = "1.0.0"
MAX_PATCH_BYTES = 512 * 1024
MAX_PATCH_FILES = 12
MAX_INTENT_CHARACTERS = 8_000
MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_TEST_OUTPUT_BYTES = 256 * 1024
MAX_TEST_SECONDS = 180
MAX_EXECUTION_EVENTS = 5_000

_EXECUTION_ID = re.compile(r"^devexec_[0-9a-f]{32}$")
_REVISION = re.compile(r"^[0-9a-fA-F]{40,64}$")
_PREVIEW_SHA = re.compile(r"^[0-9a-f]{64}$")
_DIFF_HEADER = re.compile(r"^diff --git a/([^\r\n]+) b/([^\r\n]+)$")
_SAFE_PATH_CHARACTER = re.compile(r"^[A-Za-z0-9._@+\-/]+$")


class DevelopmentExecutionError(RuntimeError):
    """Stable, HTTP-safe controlled execution failure."""

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
class PatchFile:
    path: str
    additions: int
    deletions: int
    added: bool


@dataclass(frozen=True, slots=True)
class TestProfile:
    id: str
    label: str
    argv: tuple[str, ...]
    timeout_seconds: int

    def to_api_dict(self) -> dict[str, object]:
        command = " ".join(self.argv)
        return {
            "id": self.id,
            "label": self.label,
            "command": command,
            "workingDirectory": ".",
            "timeoutSeconds": self.timeout_seconds,
            "planSha256": _sha256(
                _canonical_json(
                    {
                        "id": self.id,
                        "argv": self.argv,
                        "workingDirectory": ".",
                        "timeoutSeconds": self.timeout_seconds,
                    }
                )
            ),
        }


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _safe_relative_path(raw_path: str) -> str:
    value = raw_path.replace("\\", "/").strip()
    pure = PurePosixPath(value)
    if (
        not value
        or not _SAFE_PATH_CHARACTER.fullmatch(value)
        or pure.is_absolute()
        or value.startswith("-")
        or any(part in {"", ".", "..", ".git", ".openjiuwen-visualization"} for part in pure.parts)
    ):
        raise DevelopmentExecutionError(
            "invalid_patch_path",
            "Patch paths must be portable repository-relative paths without traversal or control directories.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return pure.as_posix()


def _parse_patch(patch: str) -> tuple[PatchFile, ...]:
    if not isinstance(patch, str) or not patch.strip():
        raise DevelopmentExecutionError(
            "invalid_patch",
            "unifiedDiff must be a non-empty string.",
            status=HTTPStatus.BAD_REQUEST,
        )
    encoded = patch.encode("utf-8")
    if len(encoded) > MAX_PATCH_BYTES:
        raise DevelopmentExecutionError(
            "patch_too_large",
            f"Unified diff exceeds the {MAX_PATCH_BYTES}-byte limit.",
            status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
        )
    if "\x00" in patch:
        raise DevelopmentExecutionError(
            "invalid_patch",
            "Unified diff cannot contain NUL bytes.",
            status=HTTPStatus.BAD_REQUEST,
        )
    forbidden_markers = (
        "GIT binary patch",
        "Binary files ",
        "deleted file mode ",
        "rename from ",
        "rename to ",
        "copy from ",
        "copy to ",
        "old mode ",
        "new mode ",
        "new file mode 160000",
    )
    if any(marker in patch for marker in forbidden_markers):
        raise DevelopmentExecutionError(
            "unsupported_patch_operation",
            "V1 accepts text additions and modifications only; binary, delete, rename, copy, mode, and submodule changes are blocked.",
            status=HTTPStatus.BAD_REQUEST,
        )

    records: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for line in patch.splitlines():
        match = _DIFF_HEADER.fullmatch(line)
        if match:
            left = _safe_relative_path(match.group(1))
            right = _safe_relative_path(match.group(2))
            if left != right:
                raise DevelopmentExecutionError(
                    "unsupported_patch_operation",
                    "V1 does not accept renamed or copied paths.",
                    status=HTTPStatus.BAD_REQUEST,
                )
            if any(item["path"] == right for item in records):
                raise DevelopmentExecutionError(
                    "duplicate_patch_path",
                    "Each patch path may appear only once.",
                    status=HTTPStatus.BAD_REQUEST,
                )
            current = {"path": right, "additions": 0, "deletions": 0, "added": False}
            records.append(current)
            continue
        if current is None:
            if line.strip():
                raise DevelopmentExecutionError(
                    "invalid_patch",
                    "Unified diff must begin with a diff --git header.",
                    status=HTTPStatus.BAD_REQUEST,
                )
            continue
        if line.startswith("new file mode "):
            if line != "new file mode 100644":
                raise DevelopmentExecutionError(
                    "unsupported_patch_operation",
                    "New files must use regular non-executable mode 100644.",
                    status=HTTPStatus.BAD_REQUEST,
                )
            current["added"] = True
        elif line.startswith("+") and not line.startswith("+++"):
            current["additions"] = int(current["additions"]) + 1
        elif line.startswith("-") and not line.startswith("---"):
            current["deletions"] = int(current["deletions"]) + 1

    if not records:
        raise DevelopmentExecutionError(
            "invalid_patch",
            "Unified diff does not contain any file changes.",
            status=HTTPStatus.BAD_REQUEST,
        )
    if len(records) > MAX_PATCH_FILES:
        raise DevelopmentExecutionError(
            "patch_file_limit",
            f"Unified diff exceeds the {MAX_PATCH_FILES}-file limit.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return tuple(
        PatchFile(
            str(item["path"]),
            int(item["additions"]),
            int(item["deletions"]),
            bool(item["added"]),
        )
        for item in records
    )


class DevelopmentExecutionStore:
    """Persistent metadata and local audit for controlled execution operations."""

    def __init__(self, database_path: Path, worktree_root: Path) -> None:
        self.database_path = database_path.resolve(strict=False)
        self.worktree_root = worktree_root.resolve(strict=False)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.worktree_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._mutation_lock = threading.RLock()
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize_database(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS development_execution (
                    id TEXT PRIMARY KEY,
                    repository_id TEXT NOT NULL,
                    repository_name TEXT NOT NULL,
                    repository_path TEXT NOT NULL,
                    source_branch TEXT NOT NULL,
                    base_revision TEXT NOT NULL,
                    branch_name TEXT NOT NULL,
                    worktree_path TEXT NOT NULL,
                    intent TEXT NOT NULL,
                    patch_text TEXT NOT NULL,
                    patch_sha256 TEXT NOT NULL,
                    preview_sha256 TEXT NOT NULL,
                    files_json TEXT NOT NULL,
                    statistics_json TEXT NOT NULL,
                    test_profiles_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    applied_diff TEXT,
                    applied_diff_sha256 TEXT,
                    last_test_json TEXT,
                    commit_sha TEXT,
                    last_error_code TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS development_execution_event (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    execution_id TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    detail_code TEXT NOT NULL,
                    FOREIGN KEY(execution_id) REFERENCES development_execution(id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS development_execution_updated
                    ON development_execution(updated_at_ms DESC);
                CREATE INDEX IF NOT EXISTS development_execution_event_execution
                    ON development_execution_event(execution_id, id ASC);
                """
            )
            if connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 1"
            ).fetchone() is None:
                connection.execute(
                    "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(1, ?)",
                    (self._now_ms(),),
                )

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1_000)

    def descriptor(self) -> dict[str, object]:
        with self._lock, self._connection() as connection:
            counts = connection.execute(
                "SELECT COUNT(*) AS total, SUM(status = 'committed') AS committed "
                "FROM development_execution"
            ).fetchone()
        return {
            "engine": "sqlite",
            "journalMode": "wal",
            "schemaVersion": 1,
            "databasePath": str(self.database_path),
            "worktreeRoot": str(self.worktree_root),
            "total": int(counts["total"] or 0),
            "committed": int(counts["committed"] or 0),
        }

    def create_preview(
        self,
        identity: RepositoryIdentity,
        *,
        expected_revision: str,
        intent: str,
        patch: str,
    ) -> dict[str, object]:
        if not isinstance(expected_revision, str) or not _REVISION.fullmatch(expected_revision):
            raise DevelopmentExecutionError(
                "invalid_base_revision",
                "baseRevision must be a full local commit SHA.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if expected_revision.casefold() != identity.revision.casefold():
            raise DevelopmentExecutionError(
                "revision_changed",
                "Repository HEAD no longer matches the analyzed revision.",
                status=HTTPStatus.CONFLICT,
            )
        if identity.dirty:
            raise DevelopmentExecutionError(
                "repository_dirty",
                "Controlled execution V1 requires a clean source working tree.",
                status=HTTPStatus.CONFLICT,
            )
        if not isinstance(intent, str) or not intent.strip():
            raise DevelopmentExecutionError(
                "invalid_execution_intent",
                "intent must be a non-empty string.",
                status=HTTPStatus.BAD_REQUEST,
            )
        normalized_intent = intent.strip()[:MAX_INTENT_CHARACTERS]
        files = _parse_patch(patch)
        patch_bytes = patch.encode("utf-8")
        self._validate_patch_against_revision(identity.root, expected_revision, patch_bytes)
        self._validate_patch_paths(identity.root, files)
        profiles = self._detect_test_profiles(
            identity.root,
            blocked_paths={item.path for item in files},
        )
        execution_id = f"devexec_{uuid.uuid4().hex}"
        branch_name = f"openjiuwen-visualization/{execution_id[8:20]}"
        worktree_path = (self.worktree_root / execution_id).resolve(strict=False)
        if not worktree_path.is_relative_to(self.worktree_root):
            raise DevelopmentExecutionError(
                "invalid_worktree_path",
                "Controlled worktree path escaped its configured root.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
        file_payload = [
            {
                "path": item.path,
                "additions": item.additions,
                "deletions": item.deletions,
                "added": item.added,
            }
            for item in files
        ]
        statistics = {
            "files": len(files),
            "additions": sum(item.additions for item in files),
            "deletions": sum(item.deletions for item in files),
            "bytes": len(patch_bytes),
        }
        profile_payload = [profile.to_api_dict() for profile in profiles]
        patch_sha256 = _sha256(patch_bytes)
        preview_sha256 = _sha256(
            _canonical_json(
                {
                    "repositoryId": identity.id,
                    "repositoryPath": str(identity.root),
                    "baseRevision": expected_revision.lower(),
                    "patchSha256": patch_sha256,
                    "files": file_payload,
                    "statistics": statistics,
                    "testProfiles": profile_payload,
                    "branchName": branch_name,
                }
            )
        )
        now_ms = self._now_ms()
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO development_execution(
                    id, repository_id, repository_name, repository_path,
                    source_branch, base_revision, branch_name, worktree_path,
                    intent, patch_text, patch_sha256, preview_sha256,
                    files_json, statistics_json, test_profiles_json,
                    status, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    execution_id,
                    identity.id,
                    identity.name,
                    str(identity.root),
                    identity.branch,
                    expected_revision.lower(),
                    branch_name,
                    str(worktree_path),
                    normalized_intent,
                    patch,
                    patch_sha256,
                    preview_sha256,
                    json.dumps(file_payload, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(statistics, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(profile_payload, ensure_ascii=False, separators=(",", ":")),
                    "previewed",
                    now_ms,
                    now_ms,
                ),
            )
            self._event(connection, execution_id, "execution.preview.created", "allowed", "patch_validated")
        return self.get_execution(execution_id)

    def list_executions(self, *, limit: int = 50, offset: int = 0) -> dict[str, object]:
        if not 1 <= limit <= 100 or offset < 0:
            raise DevelopmentExecutionError(
                "invalid_pagination",
                "limit must be between 1 and 100 and offset must be non-negative.",
                status=HTTPStatus.BAD_REQUEST,
            )
        with self._lock, self._connection() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM development_execution").fetchone()[0])
            rows = connection.execute(
                """
                SELECT * FROM development_execution
                ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return {
            "apiVersion": DEVELOPMENT_EXECUTION_API_VERSION,
            "executions": [self._serialize(row, include_raw=False, events=()) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def get_execution(self, execution_id: str) -> dict[str, object]:
        self._validate_execution_id(execution_id)
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM development_execution WHERE id = ?",
                (execution_id,),
            ).fetchone()
            if row is None:
                raise DevelopmentExecutionError(
                    "execution_not_found",
                    "Controlled Development execution was not found.",
                    status=HTTPStatus.NOT_FOUND,
                )
            events = connection.execute(
                """
                SELECT id, timestamp_ms, action, outcome, detail_code
                FROM development_execution_event
                WHERE execution_id = ? ORDER BY id ASC
                """,
                (execution_id,),
            ).fetchall()
        return {
            "apiVersion": DEVELOPMENT_EXECUTION_API_VERSION,
            "execution": self._serialize(row, include_raw=True, events=events),
        }

    def apply(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        identity: RepositoryIdentity,
    ) -> dict[str, object]:
        with self._mutation_lock:
            return self._apply(
                execution_id,
                preview_sha256=preview_sha256,
                identity=identity,
            )

    def _apply(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        identity: RepositoryIdentity,
    ) -> dict[str, object]:
        row = self._load_for_action(execution_id, preview_sha256, {"previewed", "failed"})
        if identity.revision.casefold() != str(row["base_revision"]).casefold() or identity.dirty:
            raise DevelopmentExecutionError(
                "repository_changed",
                "Source repository must remain clean at the previewed base revision.",
                status=HTTPStatus.CONFLICT,
            )
        repository = Path(str(row["repository_path"])).resolve(strict=True)
        if repository != identity.root:
            raise DevelopmentExecutionError(
                "repository_changed",
                "Resolved repository identity no longer matches the preview.",
                status=HTTPStatus.CONFLICT,
            )
        worktree = self._validated_worktree_path(row)
        branch = str(row["branch_name"])
        if worktree.exists():
            raise DevelopmentExecutionError(
                "worktree_exists",
                "The isolated worktree path already exists; rollback is required before retrying.",
                status=HTTPStatus.CONFLICT,
            )
        self._set_status(execution_id, "applying", "execution.patch.apply", "started", "approval_consumed")
        try:
            self._ensure_checkout_has_no_external_filters(repository, str(row["base_revision"]))
            self._git(
                repository,
                "worktree",
                "add",
                "-b",
                branch,
                str(worktree),
                str(row["base_revision"]),
                timeout=60,
            )
            self._git(
                worktree,
                "apply",
                "--index",
                "--whitespace=error-all",
                "-",
                input_bytes=str(row["patch_text"]).encode("utf-8"),
            )
            self._git(worktree, "diff", "--cached", "--check")
            expected_paths = self._stored_paths(row)
            staged_paths = self._git(
                worktree,
                "diff",
                "--cached",
                "--name-only",
                "-z",
            ).decode("utf-8", errors="strict").split("\0")
            actual_paths = {path for path in staged_paths if path}
            if actual_paths != expected_paths:
                raise DevelopmentExecutionError(
                    "unexpected_patch_paths",
                    "Applied patch changed paths outside the reviewed allowlist.",
                    status=HTTPStatus.CONFLICT,
                )
            applied_diff_bytes = self._git(
                worktree,
                "diff",
                "--cached",
                "--no-color",
                "--no-ext-diff",
                "--binary",
            )
            applied_diff = applied_diff_bytes.decode("utf-8", errors="replace")
            self._set_applied(execution_id, applied_diff, _sha256(applied_diff_bytes))
        except Exception as exc:
            self._cleanup_failed_worktree(repository, worktree, branch)
            if isinstance(exc, DevelopmentExecutionError):
                code = exc.code
            else:
                code = "patch_apply_failed"
            self._set_failure(execution_id, code, "execution.patch.apply")
            if isinstance(exc, DevelopmentExecutionError):
                raise
            raise DevelopmentExecutionError(
                "patch_apply_failed",
                "Patch could not be applied in the isolated worktree.",
            ) from exc
        return self.get_execution(execution_id)

    def run_test(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        profile_id: str,
        plan_sha256: str,
    ) -> dict[str, object]:
        with self._mutation_lock:
            return self._run_test(
                execution_id,
                preview_sha256=preview_sha256,
                profile_id=profile_id,
                plan_sha256=plan_sha256,
            )

    def _run_test(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        profile_id: str,
        plan_sha256: str,
    ) -> dict[str, object]:
        row = self._load_for_action(
            execution_id,
            preview_sha256,
            {"applied", "tested", "test_failed"},
        )
        profile = self._stored_test_profile(row, profile_id, plan_sha256)
        worktree = self._validated_worktree_path(row, must_exist=True)
        self._set_status(execution_id, "testing", "execution.test.run", "started", profile.id)
        started = time.monotonic()
        timed_out = False
        try:
            executable = self._test_executable(profile.argv[0])
            completed = subprocess.run(
                [executable, *profile.argv[1:]],
                cwd=worktree,
                check=False,
                capture_output=True,
                timeout=profile.timeout_seconds,
                shell=False,
                env={
                    **os.environ,
                    "CI": "1",
                    "NO_COLOR": "1",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "GIT_TERMINAL_PROMPT": "0",
                },
            )
            exit_code: int | None = completed.returncode
            stdout = self._bounded_output(completed.stdout)
            stderr = self._bounded_output(completed.stderr)
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = None
            stdout = self._bounded_output(exc.stdout or b"")
            stderr = self._bounded_output(exc.stderr or b"")
        except OSError as exc:
            exit_code = None
            stdout = ""
            stderr = str(exc)[:1_000]
        duration_ms = int((time.monotonic() - started) * 1_000)
        unstaged = self._git(
            worktree,
            "diff",
            "--name-only",
            "-z",
        ).decode("utf-8", errors="replace").split("\0")
        tracked_side_effects = sorted(path for path in unstaged if path)
        passed = exit_code == 0 and not timed_out and not tracked_side_effects
        result = {
            "profileId": profile.id,
            "label": profile.label,
            "command": " ".join(profile.argv),
            "planSha256": plan_sha256,
            "status": "passed" if passed else "timed-out" if timed_out else "failed",
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "stdout": stdout,
            "stderr": stderr,
            "trackedSideEffects": tracked_side_effects,
        }
        self._set_test_result(execution_id, result, passed)
        return self.get_execution(execution_id)

    def commit(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        message: str,
        approval_sha256: str,
    ) -> dict[str, object]:
        with self._mutation_lock:
            return self._commit(
                execution_id,
                preview_sha256=preview_sha256,
                message=message,
                approval_sha256=approval_sha256,
            )

    def _commit(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        message: str,
        approval_sha256: str,
    ) -> dict[str, object]:
        row = self._load_for_action(
            execution_id,
            preview_sha256,
            {"applied", "tested", "test_failed"},
        )
        normalized_message = self._commit_message(message)
        expected_approval = self._commit_approval_sha256(row, normalized_message)
        if approval_sha256 != expected_approval:
            raise DevelopmentExecutionError(
                "commit_preview_changed",
                "Commit approval digest does not match the reviewed message and staged diff.",
                status=HTTPStatus.CONFLICT,
            )
        profiles = json.loads(str(row["test_profiles_json"]))
        last_test = json.loads(str(row["last_test_json"])) if row["last_test_json"] else None
        if profiles and (not isinstance(last_test, dict) or last_test.get("status") != "passed"):
            raise DevelopmentExecutionError(
                "passing_test_required",
                "At least one detected allowlisted test must pass before commit.",
                status=HTTPStatus.CONFLICT,
            )
        worktree = self._validated_worktree_path(row, must_exist=True)
        expected_paths = self._stored_paths(row)
        staged = self._git(worktree, "diff", "--cached", "--name-only", "-z")
        staged_paths = {path for path in staged.decode("utf-8", errors="strict").split("\0") if path}
        if staged_paths != expected_paths:
            raise DevelopmentExecutionError(
                "staged_patch_changed",
                "Staged paths no longer match the reviewed patch allowlist.",
                status=HTTPStatus.CONFLICT,
            )
        unstaged = self._git(worktree, "diff", "--name-only", "-z")
        if any(unstaged.split(b"\0")):
            raise DevelopmentExecutionError(
                "tracked_side_effects",
                "Tracked files changed after patch application; rollback or re-preview is required.",
                status=HTTPStatus.CONFLICT,
            )
        current_diff = self._git(
            worktree,
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--binary",
        )
        if _sha256(current_diff) != str(row["applied_diff_sha256"]):
            raise DevelopmentExecutionError(
                "staged_patch_changed",
                "Staged patch no longer matches the applied reviewed diff.",
                status=HTTPStatus.CONFLICT,
            )
        self._set_status(execution_id, "committing", "execution.git.commit", "started", "approval_consumed")
        try:
            self._git(
                worktree,
                "-c",
                "user.name=OpenJiuwen Visualization",
                "-c",
                "user.email=openjiuwen-visualization@localhost",
                "commit",
                "--no-verify",
                "-m",
                normalized_message,
                timeout=60,
            )
            commit_sha = self._git(worktree, "rev-parse", "HEAD").decode("ascii").strip()
            if not _REVISION.fullmatch(commit_sha):
                raise DevelopmentExecutionError(
                    "commit_failed",
                    "Git did not return a valid commit SHA.",
                )
            repository = Path(str(row["repository_path"])).resolve(strict=True)
            self._git(repository, "worktree", "remove", "--force", str(worktree), timeout=60)
            self._set_committed(execution_id, commit_sha.lower())
        except Exception as exc:
            self._set_failure(execution_id, "commit_failed", "execution.git.commit")
            if isinstance(exc, DevelopmentExecutionError):
                raise
            raise DevelopmentExecutionError(
                "commit_failed",
                "Git commit failed inside the isolated branch.",
            ) from exc
        return self.get_execution(execution_id)

    def preview_commit(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        message: str,
    ) -> dict[str, object]:
        row = self._load_for_action(
            execution_id,
            preview_sha256,
            {"applied", "tested", "test_failed"},
        )
        normalized_message = self._commit_message(message)
        profiles = json.loads(str(row["test_profiles_json"]))
        last_test = json.loads(str(row["last_test_json"])) if row["last_test_json"] else None
        if profiles and (not isinstance(last_test, dict) or last_test.get("status") != "passed"):
            raise DevelopmentExecutionError(
                "passing_test_required",
                "At least one detected allowlisted test must pass before commit.",
                status=HTTPStatus.CONFLICT,
            )
        return {
            "apiVersion": DEVELOPMENT_EXECUTION_API_VERSION,
            "commitPreview": {
                "executionId": execution_id,
                "branchName": str(row["branch_name"]),
                "message": normalized_message,
                "stagedDiffSha256": str(row["applied_diff_sha256"]),
                "approvalSha256": self._commit_approval_sha256(row, normalized_message),
                "push": False,
            },
        }

    def rollback(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        approval_sha256: str,
    ) -> dict[str, object]:
        with self._mutation_lock:
            return self._rollback(
                execution_id,
                preview_sha256=preview_sha256,
                approval_sha256=approval_sha256,
            )

    def _rollback(
        self,
        execution_id: str,
        *,
        preview_sha256: str,
        approval_sha256: str,
    ) -> dict[str, object]:
        row = self._load_for_action(
            execution_id,
            preview_sha256,
            {
                "previewed",
                "failed",
                "applying",
                "applied",
                "testing",
                "tested",
                "test_failed",
                "committing",
                "committed",
            },
        )
        if approval_sha256 != self._rollback_approval_sha256(row):
            raise DevelopmentExecutionError(
                "rollback_preview_changed",
                "Rollback approval digest does not match the current execution state.",
                status=HTTPStatus.CONFLICT,
            )
        repository = Path(str(row["repository_path"])).resolve(strict=True)
        worktree = self._validated_worktree_path(row)
        branch = str(row["branch_name"])
        expected_head = str(row["commit_sha"] or row["base_revision"])
        branch_head = self._git(
            repository,
            "rev-parse",
            "--verify",
            f"refs/heads/{branch}^{{commit}}",
            acceptable_codes={0, 128},
        ).decode("ascii", errors="ignore").strip()
        if branch_head and branch_head.casefold() != expected_head.casefold():
            raise DevelopmentExecutionError(
                "branch_diverged",
                "Generated branch advanced outside this execution and will not be deleted automatically.",
                status=HTTPStatus.CONFLICT,
            )
        if worktree.exists():
            tracked = self._git(
                worktree,
                "status",
                "--porcelain=v1",
                "--untracked-files=no",
                "-z",
            ).decode("utf-8", errors="replace").split("\0")
            allowed = self._stored_paths(row)
            unexpected = []
            for item in tracked:
                if not item:
                    continue
                path = item[3:] if len(item) > 3 else ""
                if path and path not in allowed:
                    unexpected.append(path)
            if unexpected:
                raise DevelopmentExecutionError(
                    "unexpected_worktree_changes",
                    "Isolated worktree contains tracked changes outside the approved paths.",
                    status=HTTPStatus.CONFLICT,
                )
            self._git(repository, "worktree", "remove", "--force", str(worktree), timeout=60)
        if branch_head:
            self._git(repository, "branch", "-D", branch)
        self._set_status(execution_id, "rolled_back", "execution.rollback", "allowed", "isolated_state_removed")
        return self.get_execution(execution_id)

    def _validate_patch_against_revision(
        self,
        repository: Path,
        revision: str,
        patch: bytes,
    ) -> None:
        descriptor, raw_index = tempfile.mkstemp(
            prefix="development-index-",
            dir=self.worktree_root,
        )
        os.close(descriptor)
        index_path = Path(raw_index)
        index_path.unlink(missing_ok=True)
        try:
            env = {"GIT_INDEX_FILE": str(index_path)}
            self._git(repository, "read-tree", revision, extra_env=env)
            self._git(
                repository,
                "apply",
                "--cached",
                "--check",
                "--whitespace=error-all",
                "-",
                input_bytes=patch,
                extra_env=env,
            )
        except DevelopmentExecutionError as exc:
            raise DevelopmentExecutionError(
                "patch_check_failed",
                "Unified diff does not apply cleanly to the analyzed base revision.",
                status=HTTPStatus.CONFLICT,
            ) from exc
        finally:
            index_path.unlink(missing_ok=True)

    def _validate_patch_paths(self, repository: Path, files: tuple[PatchFile, ...]) -> None:
        for item in files:
            target = (repository / Path(*PurePosixPath(item.path).parts)).resolve(strict=False)
            if not target.is_relative_to(repository):
                raise DevelopmentExecutionError(
                    "invalid_patch_path",
                    "Patch target escaped the repository root.",
                    status=HTTPStatus.BAD_REQUEST,
                )
            parent = target.parent
            while parent != repository:
                if parent.exists() and (parent.is_symlink() or self._is_junction(parent)):
                    raise DevelopmentExecutionError(
                        "linked_patch_path",
                        "Patch targets beneath links or junctions are blocked.",
                        status=HTTPStatus.BAD_REQUEST,
                    )
                parent = parent.parent
            if target.exists() and (target.is_symlink() or self._is_junction(target)):
                raise DevelopmentExecutionError(
                    "linked_patch_path",
                    "Patch targets that are links or junctions are blocked.",
                    status=HTTPStatus.BAD_REQUEST,
                )

    @staticmethod
    def _is_junction(path: Path) -> bool:
        checker = getattr(path, "is_junction", None)
        return bool(checker and checker())

    def _detect_test_profiles(
        self,
        repository: Path,
        *,
        blocked_paths: set[str] | None = None,
    ) -> tuple[TestProfile, ...]:
        blocked = blocked_paths or set()
        profiles: list[TestProfile] = []
        local_runner = repository / "services" / "local-server" / "scripts" / "run_tests.py"
        if (
            "services/local-server/scripts/run_tests.py" not in blocked
            and local_runner.is_file()
            and not local_runner.is_symlink()
        ):
            profiles.append(
                TestProfile(
                    "local-server-tests",
                    "Local service contract tests",
                    ("python", "-B", "services/local-server/scripts/run_tests.py"),
                    MAX_TEST_SECONDS,
                )
            )
        elif (
            not blocked.intersection({"pyproject.toml", "pytest.ini", "tox.ini"})
            and any(
                (repository / name).exists()
                for name in ("pyproject.toml", "pytest.ini", "tox.ini")
            )
        ):
            profiles.append(
                TestProfile(
                    "python-pytest",
                    "Python focused test suite",
                    ("python", "-B", "-m", "pytest", "-q"),
                    MAX_TEST_SECONDS,
                )
            )
        package_path = repository / "package.json"
        if (
            "package.json" not in blocked
            and package_path.is_file()
            and not package_path.is_symlink()
            and package_path.stat().st_size <= 512 * 1024
        ):
            try:
                package = json.loads(package_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                package = None
            scripts = package.get("scripts") if isinstance(package, dict) else None
            if isinstance(scripts, dict):
                if isinstance(scripts.get("test"), str):
                    profiles.append(
                        TestProfile("npm-test", "Package test script", ("npm", "test"), MAX_TEST_SECONDS)
                    )
                if isinstance(scripts.get("check"), str):
                    profiles.append(
                        TestProfile("npm-check", "Package check script", ("npm", "run", "check"), MAX_TEST_SECONDS)
                    )
        return tuple(profiles[:4])

    def _ensure_checkout_has_no_external_filters(self, repository: Path, revision: str) -> None:
        listed = self._git(repository, "ls-tree", "-r", "-z", revision)
        attribute_paths: list[str] = []
        for raw_record in listed.split(b"\0"):
            if not raw_record:
                continue
            metadata, separator, raw_path = raw_record.partition(b"\t")
            columns = metadata.split(b" ")
            if not separator or len(columns) != 3:
                raise DevelopmentExecutionError(
                    "invalid_git_tree",
                    "Repository tree could not be validated for isolated checkout.",
                    status=HTTPStatus.CONFLICT,
                )
            mode = columns[0].decode("ascii", errors="ignore")
            if mode in {"120000", "160000"}:
                raise DevelopmentExecutionError(
                    "linked_tree_entry_blocked",
                    "Repositories containing symlink or submodule entries are blocked in controlled execution V1.",
                    status=HTTPStatus.CONFLICT,
                )
            path = raw_path.decode("utf-8", errors="replace")
            if PurePosixPath(path).name == ".gitattributes":
                attribute_paths.append(path)
        if len(attribute_paths) > 200:
            raise DevelopmentExecutionError(
                "attribute_file_limit",
                "Repository contains too many .gitattributes files for bounded checkout validation.",
                status=HTTPStatus.CONFLICT,
            )
        pattern = re.compile(r"(?:^|\s)(?:filter=|working-tree-encoding=)", re.IGNORECASE)
        for path in attribute_paths:
            content = self._git(repository, "show", f"{revision}:{path}")
            if pattern.search(content.decode("utf-8", errors="replace")):
                raise DevelopmentExecutionError(
                    "external_checkout_filter_blocked",
                    "Repositories with checkout filter or working-tree-encoding attributes are blocked in V1.",
                    status=HTTPStatus.CONFLICT,
                )
        common_dir_raw = self._git(
            repository,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ).decode("utf-8", errors="strict").strip()
        common_dir = Path(common_dir_raw).resolve(strict=True)
        local_attributes = common_dir / "info" / "attributes"
        if local_attributes.exists():
            if (
                not local_attributes.is_file()
                or local_attributes.is_symlink()
                or self._is_junction(local_attributes)
                or local_attributes.stat().st_size > 256 * 1024
            ):
                raise DevelopmentExecutionError(
                    "external_checkout_filter_blocked",
                    "Repository-local Git attributes are not a bounded regular file.",
                    status=HTTPStatus.CONFLICT,
                )
            try:
                local_attribute_text = local_attributes.read_text(
                    encoding="utf-8",
                    errors="replace",
                )
            except OSError as exc:
                raise DevelopmentExecutionError(
                    "external_checkout_filter_blocked",
                    "Repository-local Git attributes could not be verified.",
                    status=HTTPStatus.CONFLICT,
                ) from exc
            if pattern.search(local_attribute_text):
                raise DevelopmentExecutionError(
                    "external_checkout_filter_blocked",
                    "Repository-local checkout filters are blocked in V1.",
                    status=HTTPStatus.CONFLICT,
                )

    def _git(
        self,
        cwd: Path,
        *args: str,
        input_bytes: bytes | None = None,
        timeout: int = 30,
        acceptable_codes: set[int] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> bytes:
        command = [
            "git",
            "-c",
            f"core.hooksPath={os.devnull}",
            "-c",
            f"core.attributesFile={os.devnull}",
            "-c",
            "core.quotepath=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.fsmonitor=false",
            "-C",
            str(cwd),
            *args,
        ]
        environment = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            **(extra_env or {}),
        }
        try:
            completed = subprocess.run(
                command,
                input=input_bytes,
                check=False,
                capture_output=True,
                timeout=timeout,
                shell=False,
                env=environment,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise DevelopmentExecutionError(
                "git_command_failed",
                f"Controlled Git command failed to start: {args[0] if args else 'unknown'}.",
            ) from exc
        allowed = acceptable_codes or {0}
        if completed.returncode not in allowed:
            raise DevelopmentExecutionError(
                "git_command_failed",
                f"Controlled Git command failed: {args[0] if args else 'unknown'}.",
            )
        if len(completed.stdout) > MAX_GIT_OUTPUT_BYTES or len(completed.stderr) > MAX_GIT_OUTPUT_BYTES:
            raise DevelopmentExecutionError(
                "git_output_limit",
                "Controlled Git output exceeded the local memory limit.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        return completed.stdout

    @staticmethod
    def _test_executable(name: str) -> str:
        if name == "python":
            return sys.executable
        if name == "npm":
            executable = shutil.which("npm")
            if executable:
                return executable
        raise DevelopmentExecutionError(
            "test_runtime_unavailable",
            f"Allowlisted test runtime is unavailable: {name}.",
            status=HTTPStatus.SERVICE_UNAVAILABLE,
        )

    @staticmethod
    def _bounded_output(raw: bytes) -> str:
        if len(raw) <= MAX_TEST_OUTPUT_BYTES:
            return raw.decode("utf-8", errors="replace")
        tail = raw[-MAX_TEST_OUTPUT_BYTES:]
        return "[earlier output truncated]\n" + tail.decode("utf-8", errors="replace")

    @staticmethod
    def _commit_message(value: str) -> str:
        if not isinstance(value, str):
            raise DevelopmentExecutionError(
                "invalid_commit_message",
                "message must be a string.",
                status=HTTPStatus.BAD_REQUEST,
            )
        message = value.strip()
        if not 5 <= len(message) <= 120 or "\n" in message or "\r" in message:
            raise DevelopmentExecutionError(
                "invalid_commit_message",
                "Commit message must be one line between 5 and 120 characters.",
                status=HTTPStatus.BAD_REQUEST,
            )
        return message

    def _stored_test_profile(
        self,
        row: sqlite3.Row,
        profile_id: str,
        plan_sha256: str,
    ) -> TestProfile:
        if not isinstance(plan_sha256, str) or not _PREVIEW_SHA.fullmatch(plan_sha256):
            raise DevelopmentExecutionError(
                "invalid_test_plan",
                "planSha256 must be the exact test preview digest.",
                status=HTTPStatus.BAD_REQUEST,
            )
        profiles = json.loads(str(row["test_profiles_json"]))
        profile = next(
            (item for item in profiles if isinstance(item, dict) and item.get("id") == profile_id),
            None,
        )
        if not isinstance(profile, dict) or profile.get("planSha256") != plan_sha256:
            raise DevelopmentExecutionError(
                "test_plan_changed",
                "Selected test profile does not match the reviewed test preview.",
                status=HTTPStatus.CONFLICT,
            )
        command = profile.get("command")
        if not isinstance(command, str):
            raise DevelopmentExecutionError("invalid_test_plan", "Stored test profile is invalid.")
        known = {
            item.id: item
            for item in self._detect_test_profiles(
                Path(str(row["repository_path"])),
                blocked_paths=self._stored_paths(row),
            )
        }
        current = known.get(profile_id)
        if current is None or current.to_api_dict().get("planSha256") != plan_sha256:
            raise DevelopmentExecutionError(
                "test_plan_changed",
                "Repository test allowlist changed after preview.",
                status=HTTPStatus.CONFLICT,
            )
        return current

    def _load_for_action(
        self,
        execution_id: str,
        preview_sha256: str,
        allowed_statuses: set[str],
    ) -> sqlite3.Row:
        self._validate_execution_id(execution_id)
        if not isinstance(preview_sha256, str) or not _PREVIEW_SHA.fullmatch(preview_sha256):
            raise DevelopmentExecutionError(
                "invalid_execution_preview",
                "previewSha256 must be a lowercase SHA-256 digest.",
                status=HTTPStatus.BAD_REQUEST,
            )
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM development_execution WHERE id = ?",
                (execution_id,),
            ).fetchone()
        if row is None:
            raise DevelopmentExecutionError(
                "execution_not_found",
                "Controlled Development execution was not found.",
                status=HTTPStatus.NOT_FOUND,
            )
        if str(row["preview_sha256"]) != preview_sha256:
            raise DevelopmentExecutionError(
                "execution_preview_changed",
                "Approval digest does not match the reviewed execution preview.",
                status=HTTPStatus.CONFLICT,
            )
        if str(row["status"]) not in allowed_statuses:
            raise DevelopmentExecutionError(
                "invalid_execution_state",
                f"Operation is not allowed while execution status is {row['status']}.",
                status=HTTPStatus.CONFLICT,
            )
        return row

    def _validated_worktree_path(self, row: sqlite3.Row, *, must_exist: bool = False) -> Path:
        execution_id = str(row["id"])
        expected = (self.worktree_root / execution_id).resolve(strict=False)
        stored = Path(str(row["worktree_path"])).resolve(strict=False)
        if stored != expected or not stored.is_relative_to(self.worktree_root):
            raise DevelopmentExecutionError(
                "invalid_worktree_path",
                "Stored worktree path no longer matches the controlled root.",
                status=HTTPStatus.CONFLICT,
            )
        if must_exist and (not stored.is_dir() or stored.is_symlink() or self._is_junction(stored)):
            raise DevelopmentExecutionError(
                "worktree_unavailable",
                "Isolated worktree is unavailable or linked.",
                status=HTTPStatus.CONFLICT,
            )
        return stored

    @staticmethod
    def _validate_execution_id(execution_id: str) -> None:
        if not isinstance(execution_id, str) or not _EXECUTION_ID.fullmatch(execution_id):
            raise DevelopmentExecutionError(
                "invalid_execution_id",
                "Execution id is invalid.",
                status=HTTPStatus.BAD_REQUEST,
            )

    @staticmethod
    def _stored_paths(row: sqlite3.Row) -> set[str]:
        values = json.loads(str(row["files_json"]))
        return {str(item["path"]) for item in values if isinstance(item, dict) and "path" in item}

    def _serialize(
        self,
        row: sqlite3.Row,
        *,
        include_raw: bool,
        events: object,
    ) -> dict[str, object]:
        value: dict[str, object] = {
            "id": str(row["id"]),
            "repository": {
                "id": str(row["repository_id"]),
                "name": str(row["repository_name"]),
                "path": str(row["repository_path"]),
                "sourceBranch": str(row["source_branch"]),
                "baseRevision": str(row["base_revision"]),
            },
            "branchName": str(row["branch_name"]),
            "worktreePath": str(row["worktree_path"]),
            "status": str(row["status"]),
            "patchSha256": str(row["patch_sha256"]),
            "previewSha256": str(row["preview_sha256"]),
            "files": json.loads(str(row["files_json"])),
            "statistics": json.loads(str(row["statistics_json"])),
            "testProfiles": json.loads(str(row["test_profiles_json"])),
            "lastTest": json.loads(str(row["last_test_json"])) if row["last_test_json"] else None,
            "commitSha": row["commit_sha"],
            "lastErrorCode": row["last_error_code"],
            "createdAtMs": int(row["created_at_ms"]),
            "updatedAtMs": int(row["updated_at_ms"]),
            "policy": {
                "sourceWorkingTreeWrite": False,
                "isolatedWorktree": True,
                "exactPathAllowlist": True,
                "arbitraryCommands": False,
                "perOperationConfirmation": True,
                "automaticPush": False,
                "rollbackAvailable": str(row["status"]) != "rolled_back",
            },
            "approvals": {
                "applySha256": str(row["preview_sha256"]),
                "rollbackSha256": self._rollback_approval_sha256(row),
                "commitPreviewRequired": True,
            },
        }
        if include_raw:
            value.update(
                {
                    "intent": str(row["intent"]),
                    "unifiedDiff": str(row["patch_text"]),
                    "appliedDiff": row["applied_diff"],
                    "appliedDiffSha256": row["applied_diff_sha256"],
                    "events": [
                        {
                            "id": int(event["id"]),
                            "timestampMs": int(event["timestamp_ms"]),
                            "action": str(event["action"]),
                            "outcome": str(event["outcome"]),
                            "detailCode": str(event["detail_code"]),
                        }
                        for event in events
                    ],
                }
            )
        return value

    @staticmethod
    def _commit_approval_sha256(row: sqlite3.Row, message: str) -> str:
        return _sha256(
            _canonical_json(
                {
                    "action": "commit",
                    "executionId": str(row["id"]),
                    "previewSha256": str(row["preview_sha256"]),
                    "appliedDiffSha256": str(row["applied_diff_sha256"]),
                    "branchName": str(row["branch_name"]),
                    "message": message,
                    "push": False,
                }
            )
        )

    @staticmethod
    def _rollback_approval_sha256(row: sqlite3.Row) -> str:
        return _sha256(
            _canonical_json(
                {
                    "action": "rollback",
                    "executionId": str(row["id"]),
                    "previewSha256": str(row["preview_sha256"]),
                    "status": str(row["status"]),
                    "branchName": str(row["branch_name"]),
                    "commitSha": row["commit_sha"],
                }
            )
        )

    def _event(
        self,
        connection: sqlite3.Connection,
        execution_id: str,
        action: str,
        outcome: str,
        detail_code: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO development_execution_event(
                execution_id, timestamp_ms, action, outcome, detail_code
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (execution_id, self._now_ms(), action, outcome, detail_code[:160]),
        )
        connection.execute(
            """
            DELETE FROM development_execution_event
            WHERE id <= COALESCE((
                SELECT id FROM development_execution_event
                ORDER BY id DESC LIMIT 1 OFFSET ?
            ), 0)
            """,
            (MAX_EXECUTION_EVENTS,),
        )

    def _set_status(
        self,
        execution_id: str,
        status: str,
        action: str,
        outcome: str,
        detail_code: str,
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE development_execution SET status = ?, updated_at_ms = ? WHERE id = ?",
                (status, self._now_ms(), execution_id),
            )
            self._event(connection, execution_id, action, outcome, detail_code)

    def _set_applied(self, execution_id: str, applied_diff: str, digest: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                UPDATE development_execution
                SET status = 'applied', applied_diff = ?, applied_diff_sha256 = ?,
                    last_error_code = NULL, updated_at_ms = ?
                WHERE id = ?
                """,
                (applied_diff, digest, self._now_ms(), execution_id),
            )
            self._event(connection, execution_id, "execution.patch.apply", "allowed", "isolated_patch_applied")

    def _set_test_result(self, execution_id: str, result: dict[str, object], passed: bool) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                UPDATE development_execution
                SET status = ?, last_test_json = ?, last_error_code = ?, updated_at_ms = ?
                WHERE id = ?
                """,
                (
                    "tested" if passed else "test_failed",
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    None if passed else "test_failed",
                    self._now_ms(),
                    execution_id,
                ),
            )
            self._event(
                connection,
                execution_id,
                "execution.test.run",
                "allowed" if passed else "failed",
                "test_passed" if passed else str(result["status"]),
            )

    def _set_committed(self, execution_id: str, commit_sha: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                UPDATE development_execution
                SET status = 'committed', commit_sha = ?, last_error_code = NULL,
                    updated_at_ms = ? WHERE id = ?
                """,
                (commit_sha, self._now_ms(), execution_id),
            )
            self._event(connection, execution_id, "execution.git.commit", "allowed", "local_branch_commit_created")

    def _set_failure(self, execution_id: str, code: str, action: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                UPDATE development_execution
                SET status = 'failed', last_error_code = ?, updated_at_ms = ?
                WHERE id = ?
                """,
                (code[:160], self._now_ms(), execution_id),
            )
            self._event(connection, execution_id, action, "failed", code)

    def _cleanup_failed_worktree(self, repository: Path, worktree: Path, branch: str) -> None:
        try:
            if worktree.exists():
                self._git(repository, "worktree", "remove", "--force", str(worktree), timeout=60)
        except DevelopmentExecutionError:
            pass
        try:
            branch_head = self._git(
                repository,
                "rev-parse",
                "--verify",
                f"refs/heads/{branch}^{{commit}}",
                acceptable_codes={0, 128},
            ).strip()
            if branch_head:
                self._git(repository, "branch", "-D", branch)
        except DevelopmentExecutionError:
            pass
