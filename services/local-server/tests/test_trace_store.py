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

    def test_enforces_swarm_subjects_and_separate_context_owners(self) -> None:
        trace, token = self.store.create(
            owner="jiuwenswarm",
            label="Swarm run",
            max_tokens=32768,
        )
        with self.assertRaisesRegex(TraceStoreError, "require a subject"):
            self.store.append(trace["id"], token, [event("missing-subject", kind="swarm.member")])

        member = event("member", kind="swarm.member")
        member["subject"] = {
            "id": "member:leader",
            "kind": "member",
            "label": "Leader",
            "contextOwnerId": "context:leader",
        }
        context = event("context", kind="context.delta", phase="instant")
        context["subject"] = member["subject"]
        context["context"] = {
            "operation": "append",
            "ownerId": "context:leader",
            "messages": [
                {
                    "id": "message-1",
                    "role": "user",
                    "label": "User",
                    "raw": "full member text",
                    "tokens": 3,
                    "source": "team.message",
                }
            ],
        }
        metadata, accepted = self.store.append(trace["id"], token, [member, context])

        self.assertEqual(metadata["eventCount"], 2)
        self.assertEqual(accepted[0]["subject"]["id"], "member:leader")
        self.assertEqual(accepted[1]["context"]["ownerId"], "context:leader")

    def test_rejects_owner_mismatches_and_unowned_swarm_context(self) -> None:
        core_trace, core_token = self.store.create(
            owner="agent-core",
            label="Core run",
            max_tokens=4096,
        )
        swarm_event = event("swarm", kind="swarm.team")
        swarm_event["subject"] = {"id": "team:alpha", "kind": "team", "label": "Alpha"}
        with self.assertRaisesRegex(TraceStoreError, "not valid for an agent-core"):
            self.store.append(core_trace["id"], core_token, [swarm_event])

        swarm_store = RuntimeTraceStore(
            max_sessions=2,
            id_factory=lambda: "tr_swarm_context",
            token_factory=lambda: "tw_swarm_context",
        )
        swarm_trace, swarm_token = swarm_store.create(
            owner="jiuwenswarm",
            label="Swarm run",
            max_tokens=32768,
        )
        unowned_context = event("context", kind="context.snapshot", phase="instant")
        unowned_context["subject"] = {
            "id": "subagent:explore",
            "kind": "subagent",
            "label": "Explore",
        }
        unowned_context["context"] = {"operation": "replace", "messages": []}
        with self.assertRaisesRegex(TraceStoreError, "context.ownerId"):
            swarm_store.append(swarm_trace["id"], swarm_token, [unowned_context])

    def test_keeps_swarm_subject_hierarchy_stable_and_acyclic(self) -> None:
        stable_store = RuntimeTraceStore(
            id_factory=lambda: "tr_swarm_stable",
            token_factory=lambda: "tw_swarm_stable",
        )
        trace, token = stable_store.create(
            owner="jiuwenswarm",
            label="Stable swarm",
            max_tokens=32768,
        )

        cyclic_team = event("cyclic-team", kind="swarm.team")
        cyclic_team["subject"] = {
            "id": "team:alpha",
            "kind": "team",
            "label": "Alpha",
            "parentId": "member:leader",
        }
        cyclic_member = event("cyclic-member", kind="swarm.member")
        cyclic_member["subject"] = {
            "id": "member:leader",
            "kind": "member",
            "label": "Leader",
            "parentId": "team:alpha",
        }
        with self.assertRaisesRegex(TraceStoreError, "contains a cycle"):
            stable_store.append(trace["id"], token, [cyclic_team, cyclic_member])

        team = event("team", kind="swarm.team")
        team["subject"] = {"id": "team:alpha", "kind": "team", "label": "Alpha"}
        stable_store.append(trace["id"], token, [team])

        changed_kind = event("changed-kind", kind="swarm.agent")
        changed_kind["subject"] = {"id": "team:alpha", "kind": "agent", "label": "Alpha"}
        with self.assertRaisesRegex(TraceStoreError, "changed kind"):
            stable_store.append(trace["id"], token, [changed_kind])

        self_parent = event("self-parent", kind="swarm.member")
        self_parent["subject"] = {
            "id": "member:loop",
            "kind": "member",
            "label": "Loop",
            "parentId": "member:loop",
        }
        with self.assertRaisesRegex(TraceStoreError, "parentId must differ"):
            stable_store.append(trace["id"], token, [self_parent])

    def test_validates_structured_model_stream_usage_and_recording_frames(self) -> None:
        model_store = RuntimeTraceStore(
            id_factory=lambda: "tr_model",
            token_factory=lambda: "tw_model",
        )
        trace, token = model_store.create(
            owner="agent-core",
            label="Model recording",
            max_tokens=8192,
        )
        base_model = {
            "invocationId": "invoke-1",
            "providerId": "provider.demo",
            "modelId": "model.demo",
            "source": "recording",
            "recordingId": "recording-1",
        }

        missing_frame = event("missing-frame", kind="model.stream", phase="instant")
        missing_frame["model"] = {**base_model, "delta": "hello"}
        with self.assertRaisesRegex(TraceStoreError, "recordingSequence"):
            model_store.append(trace["id"], token, [missing_frame])

        missing_delta = event("missing-delta", kind="model.stream", phase="instant")
        missing_delta["model"] = {**base_model, "recordingSequence": 0}
        with self.assertRaisesRegex(TraceStoreError, "model.delta"):
            model_store.append(trace["id"], token, [missing_delta])

        fractional_usage = event("fractional-usage", kind="model.usage", phase="instant")
        fractional_usage["model"] = {
            **base_model,
            "recordingSequence": 0,
            "usage": {"inputTokens": 1, "outputTokens": 1.5, "totalTokens": 2.5},
        }
        with self.assertRaisesRegex(TraceStoreError, "non-negative integer"):
            model_store.append(trace["id"], token, [fractional_usage])

        stream = event("stream", kind="model.stream", phase="instant")
        stream["model"] = {
            **base_model,
            "recordingSequence": 0,
            "delta": "full recorded output",
            "budget": {"maxTotalTokens": 128, "maxCostMicros": 5000, "currency": "USD"},
        }
        usage = event("usage", kind="model.usage", phase="instant")
        usage["model"] = {
            **base_model,
            "recordingSequence": 1,
            "usage": {
                "inputTokens": 12,
                "outputTokens": 3,
                "totalTokens": 15,
                "costMicros": 420,
                "currency": "USD",
            },
        }
        _, accepted = model_store.append(trace["id"], token, [stream, usage])

        self.assertEqual(accepted[0]["model"]["delta"], "full recorded output")
        self.assertEqual(accepted[1]["model"]["usage"]["totalTokens"], 15)

        repeated_frame = event("repeated-frame", kind="model.stream", phase="instant")
        repeated_frame["model"] = {
            **base_model,
            "recordingSequence": 1,
            "delta": "out of order",
        }
        with self.assertRaisesRegex(TraceStoreError, "increase monotonically"):
            model_store.append(trace["id"], token, [repeated_frame])

        changed_provider = event("changed-provider", kind="model.stream", phase="instant")
        changed_provider["model"] = {
            **base_model,
            "providerId": "provider.other",
            "recordingSequence": 2,
            "delta": "wrong provider",
        }
        with self.assertRaisesRegex(TraceStoreError, "changed provider"):
            model_store.append(trace["id"], token, [changed_provider])


if __name__ == "__main__":
    unittest.main()
