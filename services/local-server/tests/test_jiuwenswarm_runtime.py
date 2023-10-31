from __future__ import annotations

import json
import os
import threading
import unittest
from dataclasses import replace
from io import StringIO
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.jiuwenswarm_runtime import (
    BRIDGE_RECORD_PREFIX,
    JiuwenSwarmBridgeProbe,
    JiuwenSwarmRuntimeAdapter,
    JiuwenSwarmRuntimeConfig,
    JiuwenSwarmRuntimeError,
    SubprocessJiuwenSwarmBridgeLauncher,
)
from openjiuwen_visualization_server.openrouter_provider import OpenRouterProviderConfig
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore
from runtime_environment_support import ReadyRuntimeEnvironmentAuthority


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


def bridge_line(event: dict[str, Any]) -> str:
    return BRIDGE_RECORD_PREFIX + json.dumps({"type": "event", "event": event}) + "\n"


def event(event_id: str, kind: str, phase: str, **values: Any) -> dict[str, Any]:
    return {
        "eventId": event_id,
        "kind": kind,
        "phase": phase,
        "timestampMs": 1,
        "spanId": "span-jiuwenswarm",
        **values,
    }


TEAM_SUBJECT = {
    "id": "team:visualization_sw_test",
    "kind": "team",
    "label": "Visualization Agent Team",
}
MEMBER_SUBJECT = {
    "id": "member:visualization_sw_test:analyst",
    "kind": "member",
    "label": "Analysis Member",
    "parentId": TEAM_SUBJECT["id"],
    "role": "teammate",
    "contextOwnerId": "context:session_sw_test:analyst",
}


class StaticProcess:
    def __init__(self, lines: list[str], exit_code: int = 0) -> None:
        self.stdout = StringIO("".join(lines))
        self.exit_code = exit_code
        self.terminated = False

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.exit_code

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.terminated = True


class BlockingOutput:
    def __init__(self, process: "BlockingProcess") -> None:
        self.process = process

    def __iter__(self) -> Iterator[str]:
        self.process.started.set()
        self.process.release.wait(2)
        return
        yield ""  # pragma: no cover


class BlockingProcess:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.stdout = BlockingOutput(self)
        self.exit_code: int | None = None

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self, timeout: float | None = None) -> int:
        self.release.wait(timeout or 2)
        return self.exit_code if self.exit_code is not None else 0

    def terminate(self) -> None:
        self.exit_code = 1
        self.release.set()

    def kill(self) -> None:
        self.terminate()


class FakeLauncher:
    def __init__(
        self,
        probe: JiuwenSwarmBridgeProbe,
        process: StaticProcess | BlockingProcess | None = None,
    ) -> None:
        self.probe_result = probe
        self.process = process
        self.requests: list[dict[str, Any]] = []
        self.probe_calls = 0

    def probe(self, config: JiuwenSwarmRuntimeConfig) -> JiuwenSwarmBridgeProbe:
        del config
        self.probe_calls += 1
        return self.probe_result

    def start(
        self,
        config: JiuwenSwarmRuntimeConfig,
        request: dict[str, Any],
    ) -> StaticProcess | BlockingProcess:
        del config
        self.requests.append(request)
        if self.process is None:
            raise OSError("missing fake process")
        return self.process


class JiuwenSwarmRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RuntimeTraceStore()
        self.trace, self.trace_token = self.store.create(
            owner="jiuwenswarm",
            label="JiuwenSwarm test",
            max_tokens=32_768,
        )

    @staticmethod
    def config(*, api_key: str = "server-secret") -> JiuwenSwarmRuntimeConfig:
        path = Path(__file__).resolve()
        return JiuwenSwarmRuntimeConfig(
            source_root=REPOSITORY_ROOT.parent / "jiuwenswarm",
            agent_core_root=REPOSITORY_ROOT.parent / "agent-core",
            python_executable=path,
            bridge_script=path,
            workspace=REPOSITORY_ROOT / ".jiuwenswarm-runtime-test",
            provider=OpenRouterProviderConfig(
                api_key=api_key,
                models=("test/model",),
                default_model="test/model",
            ),
            max_iterations=7,
        )

    def test_descriptor_requires_framework_probe_and_server_provider(self) -> None:
        ready_launcher = FakeLauncher(JiuwenSwarmBridgeProbe(True, "ready", "ok"))
        ready_adapter = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=ready_launcher,
            probe_ttl_seconds=30,
        )
        ready = ready_adapter.descriptor()
        ready_adapter.descriptor()
        ready_adapter.descriptor(refresh=True)
        unconfigured = JiuwenSwarmRuntimeAdapter(
            self.config(api_key=""),
            self.store,
            launcher=ready_launcher,
        ).descriptor()
        unavailable = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=FakeLauncher(
                JiuwenSwarmBridgeProbe(False, "jiuwenswarm_source_unavailable", "missing")
            ),
        ).descriptor()

        runtime = ready["runtime"]
        self.assertTrue(runtime["configured"])
        self.assertEqual(runtime["entrypoint"], "jiuwenswarm.agents.swarm.enrich_team_spec_for_swarm")
        self.assertEqual(runtime["profile"], "predefined-two-member")
        self.assertFalse(runtime["swarmFlow"])
        self.assertEqual(runtime["contextOwnership"], "per-member")
        self.assertEqual(unconfigured["runtime"]["status"], "unconfigured")
        self.assertEqual(unavailable["runtime"]["status"], "unavailable")
        self.assertNotIn("server-secret", json.dumps(ready))
        self.assertEqual(ready_launcher.probe_calls, 3)

    def test_remote_core_dependency_is_loaded_from_lock_without_path_override(self) -> None:
        adapter = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=FakeLauncher(JiuwenSwarmBridgeProbe(True, "ready", "ok")),
        )
        binding = replace(
            ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT).binding("jiuwenswarm"),
            core_dependency_kind="git",
            core_dependency_revision="2" * 40,
            core_source_root=None,
        )
        adapter.rebind_managed_environment(binding)

        with patch.dict(os.environ, {"PYTHONPATH": "untrusted-service-path"}):
            environment = SubprocessJiuwenSwarmBridgeLauncher._environment(adapter.config)

        self.assertEqual(
            environment["PYTHONPATH"].split(os.pathsep),
            [str(REPOSITORY_ROOT.resolve(strict=True))],
        )

    def test_bridge_events_preserve_team_hierarchy_and_member_context(self) -> None:
        lines = [
            bridge_line(event(
                "sw-1",
                "swarm.team",
                "start",
                title="Team assembly",
                subject=TEAM_SUBJECT,
                payload={"status": "planned", "teamId": "visualization_sw_test"},
            )),
            bridge_line(event(
                "sw-2",
                "swarm.member",
                "instant",
                title="Analysis Member joined",
                subject=MEMBER_SUBJECT,
                payload={"status": "waiting", "teamId": "visualization_sw_test"},
            )),
            bridge_line(event(
                "sw-3",
                "context.snapshot",
                "instant",
                title="Analysis context",
                subject=MEMBER_SUBJECT,
                token={"used": 8, "delta": 8, "budget": 32_768},
                context={
                    "operation": "replace",
                    "ownerId": MEMBER_SUBJECT["contextOwnerId"],
                    "messages": [{
                        "id": "analyst-message",
                        "role": "assistant",
                        "label": "Analysis result",
                        "raw": "full analyst result",
                        "preview": "analyst result",
                        "tokens": 8,
                        "source": "JiuwenSwarm analyst ModelContext",
                    }],
                },
            )),
            bridge_line(event(
                "sw-4",
                "swarm.task",
                "instant",
                title="Inspect architecture",
                subject={
                    "id": "task:visualization_sw_test:task-1",
                    "kind": "task",
                    "label": "Inspect architecture",
                    "parentId": TEAM_SUBJECT["id"],
                },
                payload={
                    "status": "completed",
                    "taskId": "task-1",
                    "teamId": "visualization_sw_test",
                    "assigneeId": MEMBER_SUBJECT["id"],
                },
            )),
            bridge_line(event("sw-5", "trace.status", "end", title="complete")),
        ]
        launcher = FakeLauncher(
            JiuwenSwarmBridgeProbe(True, "ready", "ok"),
            StaticProcess(lines),
        )
        adapter = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sw_test",
        )

        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "inspect this flow",
                "maxOutputTokens": 128,
            },
            self.trace_token,
        )

        self.assertTrue(adapter.wait_for_terminal(accepted["invocation"]["id"]))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(events[1]["subject"]["parentId"], TEAM_SUBJECT["id"])
        self.assertEqual(events[2]["context"]["ownerId"], MEMBER_SUBJECT["contextOwnerId"])
        self.assertEqual(events[2]["context"]["messages"][0]["raw"], "full analyst result")
        self.assertEqual(events[3]["payload"]["assigneeId"], MEMBER_SUBJECT["id"])
        request = launcher.requests[0]
        self.assertEqual(request["maxIterations"], 7)
        self.assertEqual(request["teamName"], "visualization_sw_test")
        self.assertEqual(request["sessionId"], "session_sw_test")
        self.assertNotIn("server-secret", json.dumps(events))

    def test_capacity_is_bounded_and_cancel_closes_the_trace(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(JiuwenSwarmBridgeProbe(True, "ready", "ok"), process)
        adapter = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sw_cancel",
        )
        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "cancel me",
                "maxOutputTokens": 64,
            },
            self.trace_token,
        )
        self.assertTrue(process.started.wait(1))
        second_trace, second_token = self.store.create(
            owner="jiuwenswarm",
            label="Second trace",
            max_tokens=8_192,
        )
        with self.assertRaisesRegex(JiuwenSwarmRuntimeError, "invocation limit") as raised:
            adapter.start(
                {
                    "traceId": second_trace["id"],
                    "modelId": "test/model",
                    "input": "second",
                    "maxOutputTokens": 64,
                },
                second_token,
            )
        self.assertEqual(raised.exception.code, "jiuwenswarm_capacity_reached")

        cancelling = adapter.cancel(accepted["invocation"]["id"], self.trace_token)

        self.assertEqual(cancelling["invocation"]["status"], "cancelling")
        self.assertTrue(adapter.wait_for_terminal("sw_cancel"))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual([item["kind"] for item in events], ["swarm.team", "trace.status"])
        self.assertEqual(events[0]["payload"]["status"], "cancelled")

    def test_api_status_start_and_cancel_use_swarm_trace_authority(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(JiuwenSwarmBridgeProbe(True, "ready", "ok"), process)
        adapter = JiuwenSwarmRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sw_api",
        )
        authority = ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT)
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            jiuwenswarm_adapter=adapter,
            archive_enabled=False,
            runtime_environment_authority=authority,
        )

        status = api.dispatch("GET", "/api/v1/jiuwenswarm", origin=ALLOWED_ORIGIN)
        started = api.dispatch(
            "POST",
            "/api/v1/jiuwenswarm/invocations",
            origin=ALLOWED_ORIGIN,
            trace_token=self.trace_token,
            body={
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "route test",
                "maxOutputTokens": 64,
            },
        )
        self.assertTrue(process.started.wait(1))
        cancelled = api.dispatch(
            "POST",
            "/api/v1/jiuwenswarm/invocations/sw_api/cancel",
            origin=ALLOWED_ORIGIN,
            trace_token=self.trace_token,
            body={},
        )

        self.assertEqual(status.status, 200)
        self.assertTrue(status.body["runtime"]["configured"])
        self.assertEqual(
            status.body["runtime"]["managedEnvironment"]["id"],
            "swarm-core-env",
        )
        self.assertEqual(started.status, 202)
        self.assertEqual(authority.prepare_calls, [("jiuwenswarm", True)])
        self.assertEqual(cancelled.status, 202)
        self.assertTrue(adapter.wait_for_terminal("sw_api"))
        _metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(events[0]["environment"]["consumer"], "jiuwenswarm")


if __name__ == "__main__":
    unittest.main()
