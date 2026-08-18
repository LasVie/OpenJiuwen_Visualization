from __future__ import annotations

import unittest

from openjiuwen_visualization_server.trace_store import RuntimeTraceStore, TraceStoreError


def event(event_id: str, *, kind: str = "model.call", phase: str = "start") -> dict:
    return {
        "eventId": event_id,
        "kind": kind,
        "phase": phase,
        "timestampMs": 12,
        "spanId": f"span-{event_id}",
        "title": "Model boundary",
        "summary": "A normalized event",
    }


class RuntimeTraceStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 1_700_000_000.0
        self.trace_number = 0

        def trace_id() -> str:
            self.trace_number += 1
            return f"tr_test_{self.trace_number}"

        self.store = RuntimeTraceStore(
            max_sessions=2,
            max_events_per_session=4,
            ttl_seconds=60,
            clock=lambda: self.now,
            id_factory=trace_id,
            token_factory=lambda: "tw_secret",
        )

    def test_collects_ordered_events_and_deduplicates_retries(self) -> None:
        trace, token = self.store.create(
            owner="agent-core",
            label="Core run",
            max_tokens=8192,
        )
        metadata, accepted = self.store.append(
            trace["id"],
            token,
            [event("one"), event("one"), event("two", phase="end")],
        )
        snapshot, events = self.store.snapshot(trace["id"], after=1)

        self.assertEqual(len(accepted), 2)
        self.assertEqual(metadata["lastSequence"], 2)
        self.assertEqual(snapshot["status"], "open")
        self.assertGreater(snapshot["byteCount"], 0)
        self.assertEqual([item["sequence"] for item in events], [2])
        self.assertEqual(events[0]["traceId"], trace["id"])

    def test_requires_write_token_and_closes_on_terminal_status(self) -> None:
        trace, token = self.store.create(
            owner="agent-core",
            label="Core run",
            max_tokens=4096,
        )
        with self.assertRaisesRegex(TraceStoreError, "token"):
            self.store.append(trace["id"], "wrong", [event("one")])

        metadata, _ = self.store.append(
            trace["id"],
            token,
            [event("done", kind="trace.status", phase="end")],
        )
        self.assertEqual(metadata["status"], "completed")
        duplicate_metadata, duplicate_events = self.store.append(
            trace["id"],
            token,
            [event("done", kind="trace.status", phase="end")],
        )
        self.assertEqual(duplicate_metadata["status"], "completed")
        self.assertEqual(duplicate_events, [])
        with self.assertRaisesRegex(TraceStoreError, "no longer"):
            self.store.append(trace["id"], token, [event("late")])

    def test_requires_terminal_status_to_be_last_in_a_batch(self) -> None:
        trace, token = self.store.create(
            owner="agent-core",
            label="Core run",
            max_tokens=4096,
        )
        with self.assertRaisesRegex(TraceStoreError, "final unique event"):
            self.store.append(
                trace["id"],
                token,
                [
                    event("done", kind="trace.status", phase="end"),
                    event("after-terminal"),
                ],
            )
        metadata, events = self.store.snapshot(trace["id"])
        self.assertEqual(metadata["status"], "open")
        self.assertEqual(events, [])

    def test_expires_memory_only_sessions_and_validates_event_shape(self) -> None:
        trace, token = self.store.create(
            owner="agent-core",
            label="Core run",
            max_tokens=4096,
        )
        malformed = event("bad")
        malformed["timestampMs"] = -1
        with self.assertRaisesRegex(TraceStoreError, "timestampMs"):
            self.store.append(trace["id"], token, [malformed])

        missing_hook = event("rail", kind="rail.hook", phase="end")
        with self.assertRaisesRegex(TraceStoreError, "require hook"):
            self.store.append(trace["id"], token, [missing_hook])

        self.now += 61
        with self.assertRaisesRegex(TraceStoreError, "expired"):
            self.store.snapshot(trace["id"])

    def test_preserves_full_context_text_and_bounds_session_bytes(self) -> None:
        bounded = RuntimeTraceStore(
            max_bytes_per_session=500,
            id_factory=lambda: "tr_bounded",
            token_factory=lambda: "tw_bounded",
        )
        trace, token = bounded.create(
            owner="agent-core",
            label="Bounded",
            max_tokens=4096,
        )
        context_event = event("context", kind="context.delta", phase="instant")
        context_event["token"] = {"used": 10, "delta": -2}
        context_event["context"] = {
            "operation": "append",
            "messages": [
                {
                    "id": "message-1",
                    "role": "user",
                    "label": "User",
                    "raw": "  full text with deliberate whitespace  ",
                    "tokens": 10,
                    "source": "test",
                }
            ],
        }
        _, accepted = bounded.append(trace["id"], token, [context_event])
        self.assertEqual(
            accepted[0]["context"]["messages"][0]["raw"],
            "  full text with deliberate whitespace  ",
        )

        oversized = event("oversized")
        oversized["summary"] = "x" * 400
        with self.assertRaisesRegex(TraceStoreError, "byte limit"):
            bounded.append(trace["id"], token, [oversized])


if __name__ == "__main__":
    unittest.main()
