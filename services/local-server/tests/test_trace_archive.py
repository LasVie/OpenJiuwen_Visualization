from __future__ import annotations

import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

from openjiuwen_visualization_server.trace_archive import (
    ARCHIVE_SCHEMA_VERSION,
    TraceArchiveError,
    TraceArchiveStore,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def utc(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def metadata(
    trace_id: str,
    *,
    epoch: float,
    status: str = "completed",
    event_count: int = 1,
) -> dict:
    return {
        "id": trace_id,
        "owner": "agent-core",
        "label": f"Session {trace_id}",
        "status": status,
        "createdAt": utc(epoch),
        "updatedAt": utc(epoch),
        "eventCount": event_count,
        "lastSequence": event_count,
        "maxTokens": 8192,
        "byteCount": 0,
    }


def archived_event(trace_id: str, sequence: int, payload: object) -> dict:
    return {
        "eventId": f"event-{sequence}",
        "traceId": trace_id,
        "sequence": sequence,
        "receivedAt": "2026-08-19T00:00:00Z",
        "kind": "tool.call",
        "phase": "end",
        "timestampMs": sequence,
        "spanId": f"span-{sequence}",
        "title": "Tool boundary",
        "summary": "工具调用已完成；正文仅按需读取。",
        "payload": {"value": payload},
    }


class TraceArchiveStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(
            prefix="trace-archive-",
            dir=runtime_temp,
        )
        self.root = Path(self.temp.name)
        self.now = 1_776_211_200.0

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_wal_migration_incremental_raw_boundary_and_cascade_delete(self) -> None:
        archive = TraceArchiveStore(
            self.root / "archive.sqlite3",
            clock=lambda: self.now,
        )
        live = RuntimeTraceStore(
            clock=lambda: self.now,
            id_factory=lambda: "tr_archive",
            token_factory=lambda: "tw_archive",
            archive_sink=archive,
        )
        trace, token = live.create(
            owner="agent-core",
            label="Full local record",
            max_tokens=8192,
        )

        with self.assertRaises(TraceArchiveError) as caught:
            archive.delete_session(trace["id"])
        self.assertEqual(caught.exception.code, "archive_session_open")
        self.assertEqual(caught.exception.status, 409)

        events = [
            {
                "eventId": "context-1",
                "kind": "context.delta",
                "phase": "instant",
                "timestampMs": 1,
                "spanId": "context",
                "title": "Context append",
                "summary": "系统消息已加入 Context；内容默认隐藏。",
                "context": {
                    "operation": "append",
                    "messages": [
                        {
                            "id": "system-1",
                            "role": "system",
                            "label": "System prompt",
                            "raw": "SYSTEM-RAW-SECRET",
                            "preview": "系统约束（已脱敏）",
                            "tokens": 7,
                            "source": "runtime.system",
                        }
                    ],
                },
            },
            {
                "eventId": "tool-1",
                "kind": "tool.call",
                "phase": "end",
                "timestampMs": 2,
                "spanId": "tool",
                "summary": "Tool 参数与结果已在本机完整留存。",
                "details": [{"label": "result", "value": "TOOL-RAW-SECRET"}],
                "payload": {
                    "arguments": {"query": "TOOL-ARG-SECRET"},
                    "result": "TOOL-RESULT-SECRET",
                },
            },
            {
                "eventId": "rail-1",
                "kind": "rail.hook",
                "phase": "end",
                "timestampMs": 3,
                "spanId": "rail",
                "summary": "Rail 审查完成；输入输出默认隐藏。",
                "hook": {
                    "rail": "input_rail",
                    "callback": "inspect_prompt",
                    "priority": 10,
                    "namespace": "outer",
                    "durationMs": 2,
                    "mutationDiff": "RAIL-DIFF-SECRET",
                    "controlSignal": "RAIL-OUTPUT-SECRET",
                    "exact": True,
                    "examines": ["user input", "system prompt"],
                },
            },
            {
                "eventId": "model-1",
                "kind": "model.stream",
                "phase": "instant",
                "timestampMs": 4,
                "spanId": "model",
                "summary": "模型流片段已接收；正文默认隐藏。",
                "model": {
                    "invocationId": "invoke-1",
                    "providerId": "openrouter",
                    "modelId": "test/model",
                    "source": "live",
                    "delta": "MODEL-STREAM-SECRET",
                },
            },
            {
                "eventId": "terminal",
                "kind": "trace.status",
                "phase": "end",
                "timestampMs": 5,
                "spanId": "trace",
                "summary": "运行完成。",
            },
        ]
        self.now += 1
        completed, accepted = live.append(trace["id"], token, events)
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(len(accepted), 5)

        preview = archive.get_session(trace["id"])
        serialized_preview = json.dumps(preview, ensure_ascii=False)
        for secret in (
            "SYSTEM-RAW-SECRET",
            "TOOL-RAW-SECRET",
            "TOOL-ARG-SECRET",
            "TOOL-RESULT-SECRET",
            "RAIL-DIFF-SECRET",
            "RAIL-OUTPUT-SECRET",
            "MODEL-STREAM-SECRET",
        ):
            self.assertNotIn(secret, serialized_preview)
        self.assertIn("系统约束（已脱敏）", serialized_preview)
        self.assertFalse(preview["rawIncluded"])

        revealed = archive.reveal_events(trace["id"], [1, 2, 3, 4])
        serialized_raw = json.dumps(revealed, ensure_ascii=False)
        self.assertTrue(revealed["rawIncluded"])
        self.assertIn("SYSTEM-RAW-SECRET", serialized_raw)
        self.assertIn("TOOL-RESULT-SECRET", serialized_raw)
        self.assertIn("RAIL-OUTPUT-SECRET", serialized_raw)
        self.assertIn("MODEL-STREAM-SECRET", serialized_raw)

        context = archive.reveal_context(trace["id"])
        self.assertEqual(context["frames"][0]["messages"][0]["raw"], "SYSTEM-RAW-SECRET")
        exported = archive.export_session(trace["id"])
        self.assertTrue(exported["containsFullText"])
        self.assertEqual(len(exported["events"]), 5)

        descriptor = archive.descriptor()
        self.assertEqual(descriptor["journalMode"], "wal")
        self.assertEqual(descriptor["schemaVersion"], ARCHIVE_SCHEMA_VERSION)
        with closing(sqlite3.connect(archive.database_path)) as connection:
            journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
            schema_version = connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
        self.assertEqual(journal_mode.lower(), "wal")
        self.assertEqual(schema_version, ARCHIVE_SCHEMA_VERSION)

        deleted = archive.delete_session(trace["id"])
        self.assertTrue(deleted["deletedFullText"])
        self.assertEqual(deleted["deletedEvents"], 5)
        with closing(sqlite3.connect(archive.database_path)) as connection:
            event_count = connection.execute(
                "SELECT COUNT(*) FROM archive_events WHERE trace_id=?",
                (trace["id"],),
            ).fetchone()[0]
        self.assertEqual(event_count, 0)
        with self.assertRaises(TraceArchiveError) as missing:
            archive.get_session(trace["id"])
        self.assertEqual(missing.exception.status, 404)

    def test_retention_and_logical_size_remove_oldest_closed_sessions(self) -> None:
        archive = TraceArchiveStore(
            self.root / "bounded.sqlite3",
            retention_days=30,
            max_bytes=1_048_576,
            clock=lambda: self.now,
        )
        first_payload = "a" * 600_000
        second_payload = "b" * 600_000
        archive.store(
            metadata("tr_first", epoch=self.now),
            [archived_event("tr_first", 1, first_payload)],
        )
        self.now += 1
        archive.store(
            metadata("tr_second", epoch=self.now),
            [archived_event("tr_second", 1, second_payload)],
        )

        sessions = archive.list_sessions()["sessions"]
        self.assertEqual([session["id"] for session in sessions], ["tr_second"])
        self.assertLessEqual(archive.descriptor()["storedBytes"], 1_048_576)

        expired_epoch = self.now - 31 * 86_400
        archive.store(
            metadata("tr_expired", epoch=expired_epoch),
            [archived_event("tr_expired", 1, "old")],
        )
        self.assertNotIn(
            "tr_expired",
            [session["id"] for session in archive.list_sessions()["sessions"]],
        )

        archive.store(
            metadata("tr_open_old", epoch=expired_epoch, status="open"),
            [archived_event("tr_open_old", 1, "still running")],
        )
        self.assertIn(
            "tr_open_old",
            [session["id"] for session in archive.list_sessions()["sessions"]],
        )


if __name__ == "__main__":
    unittest.main()
