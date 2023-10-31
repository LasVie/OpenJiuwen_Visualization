"""Local SQLite archive for normalized runtime traces.

The archive keeps full event JSON at rest while default reads expose only a
bounded preview. Raw event and Context reads are separate, explicit methods.
"""

from __future__ import annotations

import copy
import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


ARCHIVE_API_VERSION = "1.0.0"
ARCHIVE_SCHEMA_VERSION = 1
DEFAULT_RETENTION_DAYS = 30
DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_LIST_LIMIT = 100
MAX_EVENT_PAGE = 500
MAX_RAW_EVENT_BATCH = 100


class TraceArchiveError(ValueError):
    """Stable error returned by archive routes without exposing SQLite details."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _bounded_preview(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value.strip():
        return value[:8_000]
    return fallback


def _preview_event(event: dict[str, Any]) -> dict[str, Any]:
    """Remove raw-bearing fields while retaining structural comparison data."""

    allowed = {
        "eventId",
        "traceId",
        "sequence",
        "receivedAt",
        "kind",
        "phase",
        "timestampMs",
        "spanId",
        "parentSpanId",
        "iteration",
        "title",
        "summary",
        "durationMs",
        "activeNodeIds",
        "activeEdgeIds",
        "token",
        "subject",
        "definition",
        "environment",
    }
    preview = {
        key: copy.deepcopy(value)
        for key, value in event.items()
        if key in allowed
    }

    details = event.get("details")
    if isinstance(details, list):
        preview["details"] = [
            {
                "label": item.get("label", "detail"),
                "valuePreview": "原文已保存在本机数据库",
                "rawAvailable": True,
            }
            for item in details
            if isinstance(item, dict)
        ]

    context = event.get("context")
    if isinstance(context, dict):
        context_preview: dict[str, Any] = {
            key: copy.deepcopy(value)
            for key, value in context.items()
            if key in {"operation", "ownerId", "removeMessageIds"}
        }
        messages: list[dict[str, Any]] = []
        for message in context.get("messages", []):
            if not isinstance(message, dict):
                continue
            raw = message.get("raw")
            messages.append(
                {
                    "id": message.get("id"),
                    "role": message.get("role"),
                    "label": message.get("label"),
                    "preview": _bounded_preview(
                        message.get("preview"),
                        "完整原文已保存在本机数据库",
                    ),
                    "tokens": message.get("tokens", 0),
                    "source": message.get("source"),
                    "rawAvailable": isinstance(raw, str),
                    "rawBytes": len(raw.encode("utf-8")) if isinstance(raw, str) else 0,
                }
            )
        if messages:
            context_preview["messages"] = messages
        preview["context"] = context_preview

    hook = event.get("hook")
    if isinstance(hook, dict):
        preview["hook"] = {
            key: copy.deepcopy(value)
            for key, value in hook.items()
            if key
            in {
                "rail",
                "railNodeId",
                "callback",
                "priority",
                "namespace",
                "durationMs",
                "noop",
                "exact",
                "examines",
            }
        }
        preview["hook"]["rawAvailable"] = "mutationDiff" in hook
        preview["hook"]["hasControlSignal"] = "controlSignal" in hook

    model = event.get("model")
    if isinstance(model, dict):
        preview["model"] = {
            key: copy.deepcopy(value)
            for key, value in model.items()
            if key
            in {
                "invocationId",
                "providerId",
                "modelId",
                "source",
                "recordingId",
                "recordingSequence",
                "finishReason",
                "usage",
                "budget",
            }
        }
        preview["model"]["rawAvailable"] = any(
            field in model for field in ("delta", "responseText", "cancelReason")
        )

    subagent = event.get("subagent")
    if isinstance(subagent, dict):
        preview["subagent"] = {
            key: copy.deepcopy(value)
            for key, value in subagent.items()
            if key not in {"resultPreview", "error"}
        }
        preview["subagent"]["rawAvailable"] = any(
            field in subagent for field in ("resultPreview", "error")
        )

    payload = event.get("payload")
    if isinstance(payload, dict):
        preview["payload"] = {
            "keys": sorted(str(key) for key in payload)[:100],
            "rawAvailable": True,
        }

    preview["rawAvailable"] = True
    return preview


def _event_metrics(event: dict[str, Any]) -> tuple[int, int, int, int, int]:
    model = event.get("model")
    usage = model.get("usage") if isinstance(model, dict) else None
    if not isinstance(usage, dict):
        usage = {}
    context = event.get("context")
    messages = context.get("messages", []) if isinstance(context, dict) else []
    return (
        int(usage.get("totalTokens", 0) or 0),
        int(usage.get("inputTokens", 0) or 0),
        int(usage.get("outputTokens", 0) or 0),
        int(usage.get("costMicros", 0) or 0),
        len(messages) if isinstance(messages, list) else 0,
    )


class TraceArchiveStore:
    """Thread-safe SQLite archive with WAL, migrations, retention and raw gates."""

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
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        """Commit or roll back a unit of work and always release its file handle."""

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
                raise RuntimeError("SQLite archive could not enable WAL mode.")
            connection.execute("PRAGMA synchronous=NORMAL")
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
            if current > ARCHIVE_SCHEMA_VERSION:
                raise RuntimeError("SQLite archive schema is newer than this service.")
            if current < 1:
                self._migrate_v1(connection)

    def _migrate_v1(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE archive_sessions (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                label TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_epoch REAL NOT NULL,
                updated_at TEXT NOT NULL,
                updated_epoch REAL NOT NULL,
                archived_at TEXT NOT NULL,
                event_count INTEGER NOT NULL DEFAULT 0,
                last_sequence INTEGER NOT NULL DEFAULT 0,
                max_tokens INTEGER NOT NULL,
                byte_count INTEGER NOT NULL DEFAULT 0,
                stored_raw_bytes INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_micros INTEGER NOT NULL DEFAULT 0,
                context_message_count INTEGER NOT NULL DEFAULT 0,
                schema_version INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE archive_events (
                trace_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                phase TEXT NOT NULL,
                timestamp_ms REAL NOT NULL,
                received_at TEXT NOT NULL,
                preview_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                raw_bytes INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_micros INTEGER NOT NULL DEFAULT 0,
                context_message_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (trace_id, sequence),
                UNIQUE (trace_id, event_id),
                FOREIGN KEY (trace_id) REFERENCES archive_sessions(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            "CREATE INDEX archive_sessions_updated_idx ON archive_sessions(updated_epoch DESC)"
        )
        connection.execute(
            "CREATE INDEX archive_events_kind_idx ON archive_events(trace_id, kind)"
        )
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))",
            (1,),
        )

    def store(self, metadata: dict[str, Any], events: Iterable[dict[str, Any]]) -> None:
        """Upsert session metadata and append already validated full events."""

        now = self._clock()
        event_list = list(events)
        try:
            with self._lock, self._connection() as connection:
                connection.execute(
                    """
                    INSERT INTO archive_sessions (
                        id, owner, label, status, created_at, created_epoch,
                        updated_at, updated_epoch, archived_at, event_count,
                        last_sequence, max_tokens, byte_count, schema_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        owner=excluded.owner,
                        label=excluded.label,
                        status=excluded.status,
                        updated_at=excluded.updated_at,
                        updated_epoch=excluded.updated_epoch,
                        archived_at=excluded.archived_at,
                        event_count=excluded.event_count,
                        last_sequence=excluded.last_sequence,
                        max_tokens=excluded.max_tokens,
                        byte_count=excluded.byte_count,
                        schema_version=excluded.schema_version
                    """,
                    (
                        metadata["id"],
                        metadata["owner"],
                        metadata["label"],
                        metadata["status"],
                        metadata["createdAt"],
                        self._parse_epoch(metadata["createdAt"]),
                        metadata["updatedAt"],
                        self._parse_epoch(metadata["updatedAt"]),
                        self._utc(now),
                        metadata["eventCount"],
                        metadata["lastSequence"],
                        metadata["maxTokens"],
                        metadata["byteCount"],
                        ARCHIVE_SCHEMA_VERSION,
                    ),
                )
                for event in event_list:
                    raw_json = _json(event)
                    raw_bytes = len(raw_json.encode("utf-8"))
                    total, input_tokens, output_tokens, cost, context_count = _event_metrics(event)
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO archive_events (
                            trace_id, sequence, event_id, kind, phase,
                            timestamp_ms, received_at, preview_json, raw_json,
                            raw_bytes, total_tokens, input_tokens, output_tokens,
                            cost_micros, context_message_count
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            metadata["id"],
                            event["sequence"],
                            event["eventId"],
                            event["kind"],
                            event["phase"],
                            event["timestampMs"],
                            event["receivedAt"],
                            _json(_preview_event(event)),
                            raw_json,
                            raw_bytes,
                            total,
                            input_tokens,
                            output_tokens,
                            cost,
                            context_count,
                        ),
                    )
                aggregates = connection.execute(
                    """
                    SELECT
                        COALESCE(SUM(raw_bytes), 0),
                        COALESCE(SUM(total_tokens), 0),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cost_micros), 0),
                        COALESCE(SUM(context_message_count), 0)
                    FROM archive_events WHERE trace_id=?
                    """,
                    (metadata["id"],),
                ).fetchone()
                connection.execute(
                    """
                    UPDATE archive_sessions SET
                        stored_raw_bytes=?, total_tokens=?, input_tokens=?,
                        output_tokens=?, cost_micros=?, context_message_count=?
                    WHERE id=?
                    """,
                    (*aggregates, metadata["id"]),
                )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            raise TraceArchiveError(
                "archive_write_failed",
                "The local trace archive could not persist this event batch.",
                status=500,
            ) from exc
        self.purge()

    def descriptor(self) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS session_count,
                       COALESCE(SUM(stored_raw_bytes), 0) AS stored_bytes,
                       MIN(updated_at) AS oldest_at,
                       MAX(updated_at) AS newest_at
                FROM archive_sessions
                """
            ).fetchone()
        return {
            "engine": "sqlite",
            "journalMode": "wal",
            "schemaVersion": ARCHIVE_SCHEMA_VERSION,
            "databaseFile": self.database_path.name,
            "retentionDays": self.retention_days,
            "maxBytes": self.max_bytes,
            "storedBytes": row["stored_bytes"],
            "sessionCount": row["session_count"],
            "oldestAt": row["oldest_at"],
            "newestAt": row["newest_at"],
            "rawTextStored": True,
            "rawReadPolicy": "explicit-only",
            "localOnly": True,
        }

    def list_sessions(self, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        if not 1 <= limit <= MAX_LIST_LIMIT or offset < 0:
            raise TraceArchiveError(
                "invalid_pagination",
                f"limit must be 1..{MAX_LIST_LIMIT} and offset must be non-negative.",
            )
        self.purge()
        with self._lock, self._connection() as connection:
            total = connection.execute("SELECT COUNT(*) FROM archive_sessions").fetchone()[0]
            rows = connection.execute(
                """
                SELECT * FROM archive_sessions
                ORDER BY updated_epoch DESC, id DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "storage": self.descriptor(),
            "sessions": [self._session_dict(row) for row in rows],
            "pagination": {
                "limit": limit,
                "offset": offset,
                "total": total,
                "hasMore": offset + len(rows) < total,
            },
        }

    def get_session(
        self,
        trace_id: str,
        *,
        after: int = 0,
        limit: int = MAX_EVENT_PAGE,
    ) -> dict[str, Any]:
        if after < 0 or not 1 <= limit <= MAX_EVENT_PAGE:
            raise TraceArchiveError(
                "invalid_pagination",
                f"after must be non-negative and limit must be 1..{MAX_EVENT_PAGE}.",
            )
        with self._lock, self._connection() as connection:
            session = self._session_row(connection, trace_id)
            rows = connection.execute(
                """
                SELECT sequence, preview_json FROM archive_events
                WHERE trace_id=? AND sequence>? ORDER BY sequence LIMIT ?
                """,
                (trace_id, after, limit),
            ).fetchall()
        events = [json.loads(row["preview_json"]) for row in rows]
        last = events[-1]["sequence"] if events else after
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "session": self._session_dict(session),
            "events": events,
            "page": {
                "after": after,
                "lastSequence": last,
                "hasMore": last < session["last_sequence"],
            },
            "rawIncluded": False,
        }

    def reveal_events(self, trace_id: str, sequences: list[int]) -> dict[str, Any]:
        if not 1 <= len(sequences) <= MAX_RAW_EVENT_BATCH:
            raise TraceArchiveError(
                "invalid_raw_request",
                f"sequences must contain 1..{MAX_RAW_EVENT_BATCH} items.",
            )
        if any(isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1 for sequence in sequences):
            raise TraceArchiveError("invalid_raw_request", "sequences must contain positive integers.")
        unique = list(dict.fromkeys(sequences))
        placeholders = ",".join("?" for _ in unique)
        with self._lock, self._connection() as connection:
            self._session_row(connection, trace_id)
            rows = connection.execute(
                f"""
                SELECT sequence, raw_json FROM archive_events
                WHERE trace_id=? AND sequence IN ({placeholders}) ORDER BY sequence
                """,
                (trace_id, *unique),
            ).fetchall()
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "traceId": trace_id,
            "events": [json.loads(row["raw_json"]) for row in rows],
            "rawIncluded": True,
            "localOnly": True,
        }

    def reveal_context(self, trace_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            self._session_row(connection, trace_id)
            rows = connection.execute(
                "SELECT sequence, raw_json FROM archive_events WHERE trace_id=? ORDER BY sequence",
                (trace_id,),
            ).fetchall()
        frames: list[dict[str, Any]] = []
        for row in rows:
            event = json.loads(row["raw_json"])
            context = event.get("context")
            if not isinstance(context, dict):
                continue
            frames.append(
                {
                    "sequence": row["sequence"],
                    "operation": context.get("operation"),
                    "ownerId": context.get("ownerId"),
                    "messages": context.get("messages", []),
                    "removeMessageIds": context.get("removeMessageIds", []),
                }
            )
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "traceId": trace_id,
            "frames": frames,
            "rawIncluded": True,
            "localOnly": True,
        }

    def export_session(self, trace_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            session = self._session_row(connection, trace_id)
            rows = connection.execute(
                "SELECT raw_json FROM archive_events WHERE trace_id=? ORDER BY sequence",
                (trace_id,),
            ).fetchall()
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "exportedAt": self._utc(self._clock()),
            "session": self._session_dict(session),
            "events": [json.loads(row["raw_json"]) for row in rows],
            "containsFullText": True,
            "localSource": True,
        }

    def delete_session(self, trace_id: str) -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            session = self._session_row(connection, trace_id)
            if session["status"] == "open":
                raise TraceArchiveError(
                    "archive_session_open",
                    "An open session cannot be deleted until the run finishes or fails.",
                    status=409,
                )
            event_count = connection.execute(
                "SELECT COUNT(*) FROM archive_events WHERE trace_id=?",
                (trace_id,),
            ).fetchone()[0]
            connection.execute("DELETE FROM archive_sessions WHERE id=?", (trace_id,))
        self._checkpoint()
        return {
            "apiVersion": ARCHIVE_API_VERSION,
            "deleted": True,
            "traceId": trace_id,
            "deletedEvents": event_count,
            "deletedFullText": True,
        }

    def purge(self) -> dict[str, int]:
        threshold = self._clock() - self.retention_days * 86_400
        removed = 0
        removed_bytes = 0
        with self._lock, self._connection() as connection:
            expired = connection.execute(
                """
                SELECT id, stored_raw_bytes FROM archive_sessions
                WHERE status<>'open' AND updated_epoch<?
                """,
                (threshold,),
            ).fetchall()
            for row in expired:
                connection.execute("DELETE FROM archive_sessions WHERE id=?", (row["id"],))
                removed += 1
                removed_bytes += row["stored_raw_bytes"]
            stored = connection.execute(
                "SELECT COALESCE(SUM(stored_raw_bytes), 0) FROM archive_sessions"
            ).fetchone()[0]
            while stored > self.max_bytes:
                oldest = connection.execute(
                    """
                    SELECT id, stored_raw_bytes FROM archive_sessions
                    WHERE status<>'open'
                    ORDER BY updated_epoch ASC, id ASC LIMIT 1
                    """
                ).fetchone()
                if oldest is None:
                    break
                connection.execute("DELETE FROM archive_sessions WHERE id=?", (oldest["id"],))
                removed += 1
                removed_bytes += oldest["stored_raw_bytes"]
                stored -= oldest["stored_raw_bytes"]
        if removed:
            self._checkpoint()
        return {"removedSessions": removed, "removedBytes": removed_bytes}

    def _checkpoint(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def _session_row(self, connection: sqlite3.Connection, trace_id: str) -> sqlite3.Row:
        if not isinstance(trace_id, str) or not trace_id or len(trace_id) > 200:
            raise TraceArchiveError("invalid_archive_id", "Archive session id is invalid.")
        row = connection.execute(
            "SELECT * FROM archive_sessions WHERE id=?",
            (trace_id,),
        ).fetchone()
        if row is None:
            raise TraceArchiveError(
                "archive_not_found",
                "Archived trace session was not found.",
                status=404,
            )
        return row

    @staticmethod
    def _session_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "owner": row["owner"],
            "label": row["label"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "archivedAt": row["archived_at"],
            "eventCount": row["event_count"],
            "lastSequence": row["last_sequence"],
            "maxTokens": row["max_tokens"],
            "byteCount": row["byte_count"],
            "storedRawBytes": row["stored_raw_bytes"],
            "totalTokens": row["total_tokens"],
            "inputTokens": row["input_tokens"],
            "outputTokens": row["output_tokens"],
            "costMicros": row["cost_micros"],
            "contextMessageCount": row["context_message_count"],
            "schemaVersion": row["schema_version"],
            "rawTextStored": True,
        }

    @staticmethod
    def _utc(epoch: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))

    @staticmethod
    def _parse_epoch(value: str) -> float:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError) as exc:
            raise ValueError("Trace timestamp is invalid.") from exc
