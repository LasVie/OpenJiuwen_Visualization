"""Local SQLite persistence for read-only Development analysis sessions.

List reads expose metadata only. Restoring or exporting a session is an
explicit full-payload read; the stored analysis never leaves this module
unless one of those methods is called.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any


DEVELOPMENT_SESSION_API_VERSION = "1.0.0"
DEVELOPMENT_SESSION_SCHEMA_VERSION = 1
DEFAULT_RETENTION_DAYS = 30
DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_LIST_LIMIT = 100
MAX_ANALYSIS_BYTES = 1_500_000
MAX_LABEL_LENGTH = 160

_STAGE_KINDS = (
    "intent",
    "scope",
    "evidence",
    "diagnosis",
    "impact",
    "change-plan",
    "test-plan",
    "patch-outline",
    "boundary",
)
_TOP_LEVEL_KEYS = {
    "repository",
    "intent",
    "terms",
    "evidence",
    "impacts",
    "changes",
    "tests",
    "patchOutlines",
    "stages",
    "diagnosis",
    "warnings",
    "entry",
    "readOnly",
    "repositoryWrite",
}


class DevelopmentSessionError(ValueError):
    """Stable error returned without exposing SQLite or payload internals."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _required_string(
    record: dict[str, Any],
    name: str,
    *,
    maximum: int,
) -> str:
    value = record.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise DevelopmentSessionError(
            "invalid_development_session",
            f"{name} must be a non-empty string no longer than {maximum} characters.",
        )
    return value


def _relative_source_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 4_096:
        return False
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    return not path.is_absolute() and ".." not in path.parts


def _validate_json_tree(value: Any, *, depth: int = 0, items: list[int] | None = None) -> None:
    if items is None:
        items = [0]
    items[0] += 1
    if depth > 18 or items[0] > 12_000:
        raise DevelopmentSessionError(
            "invalid_development_session",
            "Development analysis payload is too deeply nested or contains too many values.",
        )
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and len(value) > 120_000:
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development analysis contains an oversized text field.",
            )
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development analysis contains a non-finite number.",
            )
        return
    if isinstance(value, list):
        if len(value) > 2_000:
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development analysis contains an oversized array.",
            )
        for item in value:
            _validate_json_tree(item, depth=depth + 1, items=items)
        return
    if isinstance(value, dict):
        if len(value) > 200 or any(not isinstance(key, str) for key in value):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development analysis contains an invalid object.",
            )
        for item in value.values():
            _validate_json_tree(item, depth=depth + 1, items=items)
        return
    raise DevelopmentSessionError(
        "invalid_development_session",
        "Development analysis must contain JSON values only.",
    )


def _validate_source(value: Any) -> None:
    if not isinstance(value, dict) or not _relative_source_path(value.get("path")):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "Every Development source must use a bounded repository-relative path.",
        )
    repository = value.get("repository")
    if not isinstance(repository, str) or not repository.strip() or len(repository) > 4_096:
        raise DevelopmentSessionError(
            "invalid_development_session",
            "Every Development source must declare a bounded repository identity.",
        )
    for name in ("revision", "symbol"):
        item = value.get(name)
        if item is not None and (not isinstance(item, str) or len(item) > 4_096):
            raise DevelopmentSessionError(
                "invalid_development_session",
                f"Development source {name} is invalid.",
            )


def _validate_node_sources(value: Any) -> None:
    if not isinstance(value, dict):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "Development analysis contains an invalid graph node.",
        )
    evidence = value.get("evidence")
    if not isinstance(evidence, list):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "Development graph nodes must retain their evidence array.",
        )
    for item in evidence:
        if not isinstance(item, dict):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development graph evidence is invalid.",
            )
        if item.get("source") is not None:
            _validate_source(item["source"])
    for name in ("startLine", "endLine"):
        item = value.get(name)
        if item is not None and (
            isinstance(item, bool) or not isinstance(item, int) or item < 1
        ):
            raise DevelopmentSessionError(
                "invalid_development_session",
                f"Development source {name} is invalid.",
            )


def _validate_analysis(analysis: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(analysis, dict):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis must be an object.",
        )
    unknown = set(analysis) - _TOP_LEVEL_KEYS
    if unknown:
        raise DevelopmentSessionError(
            "invalid_development_session",
            f"Unsupported Development analysis field: {sorted(unknown)[0]}",
        )
    _validate_json_tree(analysis)
    repository = analysis.get("repository")
    if not isinstance(repository, dict):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis.repository must be an object.",
        )
    for name, maximum in (
        ("id", 1_024),
        ("name", 300),
        ("owner", 100),
        ("path", 32_768),
        ("scanScope", 32_768),
        ("revision", 300),
        ("branch", 1_024),
    ):
        _required_string(repository, name, maximum=maximum)
    if not isinstance(repository.get("dirty"), bool):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis.repository.dirty must be a boolean.",
        )
    intent = _required_string(analysis, "intent", maximum=20_000).strip()
    _required_string(analysis, "diagnosis", maximum=30_000)
    if analysis.get("readOnly") is not True or analysis.get("repositoryWrite") is not False:
        raise DevelopmentSessionError(
            "development_write_forbidden",
            "Persisted Development analysis must remain read-only with repositoryWrite=false.",
            status=403,
        )
    limits = {
        "terms": 24,
        "evidence": 5,
        "impacts": 10,
        "changes": 3,
        "tests": 4,
        "patchOutlines": 2,
        "warnings": 100,
    }
    for name, maximum in limits.items():
        value = analysis.get(name)
        if not isinstance(value, list) or len(value) > maximum:
            raise DevelopmentSessionError(
                "invalid_development_session",
                f"analysis.{name} must be an array with at most {maximum} items.",
            )
    if not all(isinstance(term, str) and len(term) <= 300 for term in analysis["terms"]):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis.terms contains an invalid term.",
        )
    if not all(isinstance(item, str) and len(item) <= 30_000 for item in analysis["warnings"]):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis.warnings contains an invalid warning.",
        )
    stages = analysis.get("stages")
    if not isinstance(stages, list) or len(stages) != len(_STAGE_KINDS):
        raise DevelopmentSessionError(
            "invalid_development_session",
            "analysis.stages must contain the complete nine-stage read-only chain.",
        )
    for ordinal, (stage, expected_kind) in enumerate(zip(stages, _STAGE_KINDS), start=1):
        if (
            not isinstance(stage, dict)
            or stage.get("kind") != expected_kind
            or stage.get("ordinal") != ordinal
        ):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "analysis.stages is not the canonical read-only stage sequence.",
            )
    for patch in analysis["patchOutlines"]:
        if (
            not isinstance(patch, dict)
            or patch.get("applicable") is not False
            or patch.get("basis") != "structural-outline"
            or not isinstance(patch.get("preview"), str)
            or not patch["preview"].startswith(
                "*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***"
            )
            or not _relative_source_path(patch.get("path"))
        ):
            raise DevelopmentSessionError(
                "development_write_forbidden",
                "Persisted patch output must remain a non-applicable structural outline.",
                status=403,
            )
    for evidence in analysis["evidence"]:
        if not isinstance(evidence, dict):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "analysis.evidence contains an invalid record.",
            )
        _validate_source(evidence.get("source"))
        _validate_node_sources(evidence.get("node"))
    for impact in analysis["impacts"]:
        if not isinstance(impact, dict):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "analysis.impacts contains an invalid record.",
            )
        _validate_node_sources(impact.get("node"))
        if impact.get("source") is not None:
            _validate_source(impact["source"])
    for change in analysis["changes"]:
        target = change.get("target") if isinstance(change, dict) else None
        if not isinstance(target, dict):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "analysis.changes contains an invalid evidence target.",
            )
        _validate_source(target.get("source"))
        _validate_node_sources(target.get("node"))
    for test in analysis["tests"]:
        if isinstance(test, dict) and test.get("source") is not None:
            _validate_source(test["source"])
    entry = analysis.get("entry")
    navigation = entry.get("navigation") if isinstance(entry, dict) else None
    if isinstance(navigation, dict):
        _validate_source(navigation.get("source"))
    canonical = _canonical_json(analysis)
    if len(canonical.encode("utf-8")) > MAX_ANALYSIS_BYTES:
        raise DevelopmentSessionError(
            "development_session_too_large",
            f"Development analysis exceeds the {MAX_ANALYSIS_BYTES}-byte local session limit.",
            status=413,
        )
    return canonical, repository


class DevelopmentSessionStore:
    """Thread-safe SQLite/WAL store with versioned schema and bounded retention."""

    def __init__(
        self,
        database_path: str | Path,
        *,
        retention_days: int = DEFAULT_RETENTION_DAYS,
        max_bytes: int = DEFAULT_MAX_BYTES,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not 1 <= retention_days <= 3_650:
            raise ValueError("retention_days must be between 1 and 3650.")
        if max_bytes < 1_048_576:
            raise ValueError("max_bytes must be at least 1048576.")
        self.database_path = Path(database_path).expanduser().resolve(strict=False)
        self.retention_days = retention_days
        self.max_bytes = max_bytes
        self._clock = clock
        self._lock = threading.RLock()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self.purge()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self.database_path),
            timeout=10,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connection() as connection:
            journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                raise RuntimeError("Development Session database could not enable WAL mode.")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                )
                """
            )
            current = connection.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            ).fetchone()[0]
            if current > DEVELOPMENT_SESSION_SCHEMA_VERSION:
                raise RuntimeError(
                    "Development Session schema is newer than this service."
                )
            if current < 1:
                self._migrate_v1(connection)

    @staticmethod
    def _migrate_v1(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE development_sessions (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                intent_preview TEXT NOT NULL,
                repository_name TEXT NOT NULL,
                repository_owner TEXT NOT NULL,
                repository_path TEXT NOT NULL,
                repository_branch TEXT NOT NULL,
                repository_revision TEXT NOT NULL,
                repository_dirty INTEGER NOT NULL,
                engine TEXT NOT NULL,
                entry_plane TEXT,
                evidence_count INTEGER NOT NULL,
                impact_count INTEGER NOT NULL,
                change_count INTEGER NOT NULL,
                test_count INTEGER NOT NULL,
                patch_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                created_epoch REAL NOT NULL,
                updated_at TEXT NOT NULL,
                updated_epoch REAL NOT NULL,
                analysis_json TEXT NOT NULL,
                analysis_bytes INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX development_sessions_updated_idx "
            "ON development_sessions(updated_epoch DESC)"
        )
        connection.execute(
            "CREATE INDEX development_sessions_repository_idx "
            "ON development_sessions(repository_owner, repository_name, updated_epoch DESC)"
        )
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'))"
        )

    def create_session(self, analysis: Any, *, label: str | None = None) -> dict[str, Any]:
        canonical, repository = _validate_analysis(analysis)
        if label is not None and not isinstance(label, str):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "label must be a string when provided.",
            )
        normalized_label = label.strip() if isinstance(label, str) else ""
        intent = analysis["intent"].strip()
        if not normalized_label:
            normalized_label = f"{repository['name']} · 开发分析"
        if not normalized_label or len(normalized_label) > MAX_LABEL_LENGTH:
            raise DevelopmentSessionError(
                "invalid_development_session",
                f"label must be no longer than {MAX_LABEL_LENGTH} characters.",
            )
        now = self._clock()
        timestamp = self._utc(now)
        session_id = f"dev_{uuid.uuid4().hex}"
        analysis_bytes = len(canonical.encode("utf-8"))
        if analysis_bytes > self.max_bytes:
            raise DevelopmentSessionError(
                "development_session_too_large",
                "Development analysis exceeds the configured local Session capacity.",
                status=413,
            )
        entry = analysis.get("entry")
        navigation = entry.get("navigation") if isinstance(entry, dict) else None
        origin = navigation.get("origin") if isinstance(navigation, dict) else None
        entry_plane = origin.get("plane") if isinstance(origin, dict) else None
        if entry_plane not in (None, "runtime", "definition", "change"):
            raise DevelopmentSessionError(
                "invalid_development_session",
                "Development entry plane is invalid.",
            )
        try:
            with self._lock, self._connection() as connection:
                connection.execute(
                    """
                    INSERT INTO development_sessions (
                        id, label, intent_preview, repository_name, repository_owner,
                        repository_path, repository_branch, repository_revision,
                        repository_dirty, engine, entry_plane, evidence_count,
                        impact_count, change_count, test_count, patch_count,
                        created_at, created_epoch, updated_at, updated_epoch,
                        analysis_json, analysis_bytes, content_sha256, schema_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        normalized_label,
                        f"本机开发意图 · {len(intent)} 字",
                        repository["name"],
                        repository["owner"],
                        repository["path"],
                        repository["branch"],
                        repository["revision"],
                        int(repository["dirty"]),
                        "deterministic-static",
                        entry_plane,
                        len(analysis["evidence"]),
                        len(analysis["impacts"]),
                        len(analysis["changes"]),
                        len(analysis["tests"]),
                        len(analysis["patchOutlines"]),
                        timestamp,
                        now,
                        timestamp,
                        now,
                        canonical,
                        analysis_bytes,
                        hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                        DEVELOPMENT_SESSION_SCHEMA_VERSION,
                    ),
                )
        except sqlite3.Error as exc:
            raise DevelopmentSessionError(
                "development_session_write_failed",
                "The local Development Session database could not save this analysis.",
                status=500,
            ) from exc
        self.purge()
        return {
            "apiVersion": DEVELOPMENT_SESSION_API_VERSION,
            "session": self.get_summary(session_id),
            "analysisStored": True,
            "localOnly": True,
        }

    def descriptor(self) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS session_count,
                       COALESCE(SUM(analysis_bytes), 0) AS stored_bytes,
                       MIN(updated_at) AS oldest_at,
                       MAX(updated_at) AS newest_at
                FROM development_sessions
                """
            ).fetchone()
        return {
            "engine": "sqlite",
            "journalMode": "wal",
            "schemaVersion": DEVELOPMENT_SESSION_SCHEMA_VERSION,
            "databaseFile": self.database_path.name,
            "retentionDays": self.retention_days,
            "maxBytes": self.max_bytes,
            "storedBytes": row["stored_bytes"],
            "sessionCount": row["session_count"],
            "oldestAt": row["oldest_at"],
            "newestAt": row["newest_at"],
            "fullAnalysisStored": True,
            "fullReadPolicy": "restore-or-export",
            "localOnly": True,
        }

    def list_sessions(self, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        if not 1 <= limit <= MAX_LIST_LIMIT or offset < 0:
            raise DevelopmentSessionError(
                "invalid_pagination",
                f"limit must be 1..{MAX_LIST_LIMIT} and offset must be non-negative.",
            )
        self.purge()
        with self._lock, self._connection() as connection:
            total = connection.execute(
                "SELECT COUNT(*) FROM development_sessions"
            ).fetchone()[0]
            rows = connection.execute(
                """
                SELECT * FROM development_sessions
                ORDER BY updated_epoch DESC, id DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return {
            "apiVersion": DEVELOPMENT_SESSION_API_VERSION,
            "storage": self.descriptor(),
            "sessions": [self._summary(row) for row in rows],
            "pagination": {
                "limit": limit,
                "offset": offset,
                "total": total,
                "hasMore": offset + len(rows) < total,
            },
            "fullAnalysisIncluded": False,
        }

    def get_summary(self, session_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            return self._summary(self._session_row(connection, session_id))

    def get_session(self, session_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            row = self._session_row(connection, session_id)
            analysis = json.loads(row["analysis_json"])
        return {
            "apiVersion": DEVELOPMENT_SESSION_API_VERSION,
            "session": self._summary(row),
            "analysis": analysis,
            "fullAnalysisIncluded": True,
            "localOnly": True,
        }

    def export_session(self, session_id: str) -> dict[str, Any]:
        detail = self.get_session(session_id)
        return {
            "apiVersion": DEVELOPMENT_SESSION_API_VERSION,
            "exportedAt": self._utc(self._clock()),
            "session": detail["session"],
            "analysis": detail["analysis"],
            "containsFullAnalysis": True,
            "localSource": True,
        }

    def delete_session(self, session_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            row = self._session_row(connection, session_id)
            deleted_bytes = row["analysis_bytes"]
            connection.execute(
                "DELETE FROM development_sessions WHERE id=?",
                (session_id,),
            )
        self._checkpoint()
        return {
            "apiVersion": DEVELOPMENT_SESSION_API_VERSION,
            "deleted": True,
            "sessionId": session_id,
            "deletedBytes": deleted_bytes,
            "deletedFullAnalysis": True,
        }

    def purge(self) -> dict[str, int]:
        threshold = self._clock() - self.retention_days * 86_400
        removed = 0
        removed_bytes = 0
        with self._lock, self._connection() as connection:
            expired = connection.execute(
                """
                SELECT id, analysis_bytes FROM development_sessions
                WHERE updated_epoch<? ORDER BY updated_epoch ASC, id ASC
                """,
                (threshold,),
            ).fetchall()
            for row in expired:
                connection.execute(
                    "DELETE FROM development_sessions WHERE id=?", (row["id"],)
                )
                removed += 1
                removed_bytes += row["analysis_bytes"]
            stored = connection.execute(
                "SELECT COALESCE(SUM(analysis_bytes), 0) FROM development_sessions"
            ).fetchone()[0]
            while stored > self.max_bytes:
                oldest = connection.execute(
                    """
                    SELECT id, analysis_bytes FROM development_sessions
                    ORDER BY updated_epoch ASC, id ASC LIMIT 1
                    """
                ).fetchone()
                if oldest is None:
                    break
                connection.execute(
                    "DELETE FROM development_sessions WHERE id=?", (oldest["id"],)
                )
                removed += 1
                removed_bytes += oldest["analysis_bytes"]
                stored -= oldest["analysis_bytes"]
        if removed:
            self._checkpoint()
        return {"removedSessions": removed, "removedBytes": removed_bytes}

    def _checkpoint(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def _session_row(self, connection: sqlite3.Connection, session_id: str) -> sqlite3.Row:
        if (
            not isinstance(session_id, str)
            or not session_id.startswith("dev_")
            or len(session_id) != 36
            or any(character not in "0123456789abcdef" for character in session_id[4:])
        ):
            raise DevelopmentSessionError(
                "invalid_development_session_id",
                "Development Session id is invalid.",
            )
        row = connection.execute(
            "SELECT * FROM development_sessions WHERE id=?", (session_id,)
        ).fetchone()
        if row is None:
            raise DevelopmentSessionError(
                "development_session_not_found",
                "Development Session was not found in the local database.",
                status=404,
            )
        return row

    @staticmethod
    def _summary(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "label": row["label"],
            "intentPreview": row["intent_preview"],
            "repository": {
                "name": row["repository_name"],
                "owner": row["repository_owner"],
                "path": row["repository_path"],
                "branch": row["repository_branch"],
                "revision": row["repository_revision"],
                "dirty": bool(row["repository_dirty"]),
            },
            "engine": row["engine"],
            "entryPlane": row["entry_plane"],
            "counts": {
                "evidence": row["evidence_count"],
                "impacts": row["impact_count"],
                "changes": row["change_count"],
                "tests": row["test_count"],
                "patches": row["patch_count"],
            },
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "byteCount": row["analysis_bytes"],
            "contentSha256": row["content_sha256"],
            "schemaVersion": row["schema_version"],
            "fullAnalysisStored": True,
        }

    @staticmethod
    def _utc(epoch: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))
