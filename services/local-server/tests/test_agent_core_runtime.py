from __future__ import annotations

import json
import os
import threading
import unittest
from io import StringIO
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

from openjiuwen_visualization_server.agent_core_runtime import (
    BRIDGE_RECORD_PREFIX,
    AgentCoreBridgeProbe,
    AgentCoreRuntimeAdapter,
    AgentCoreRuntimeConfig,
    SubprocessAgentCoreBridgeLauncher,
)
from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.openrouter_provider import OpenRouterProviderConfig
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore
from runtime_environment_support import (
    PlannedRuntimeEnvironmentAuthority,
    ReadyRuntimeEnvironmentAuthority,
)


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
        "spanId": "span-agent-core",
        **values,
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
        probe: AgentCoreBridgeProbe,
        process: StaticProcess | BlockingProcess | None = None,
    ) -> None:
        self.probe_result = probe
        self.process = process
        self.requests: list[dict[str, Any]] = []
        self.probe_calls = 0

    def probe(self, config: AgentCoreRuntimeConfig) -> AgentCoreBridgeProbe:
        del config
        self.probe_calls += 1
        return self.probe_result

    def start(
        self,
        config: AgentCoreRuntimeConfig,
        request: dict[str, Any],
    ) -> StaticProcess | BlockingProcess:
        del config
        self.requests.append(request)
        if self.process is None:
            raise OSError("missing fake process")
        return self.process


class AgentCoreRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RuntimeTraceStore()
        self.trace, self.trace_token = self.store.create(
            owner="agent-core",
            label="Agent Core test",
            max_tokens=8_192,
        )

    @staticmethod
    def config(*, api_key: str = "server-secret") -> AgentCoreRuntimeConfig:
        path = Path(__file__).resolve()
        return AgentCoreRuntimeConfig(
            source_root=REPOSITORY_ROOT.parent / "agent-core",
            python_executable=path,
            bridge_script=path,
            workspace=REPOSITORY_ROOT / ".agent-core-runtime-test",
            provider=OpenRouterProviderConfig(
                api_key=api_key,
                models=("test/model",),
                default_model="test/model",
            ),
            max_iterations=5,
        )

    def test_descriptor_requires_both_runtime_and_server_side_provider(self) -> None:
        ready_launcher = FakeLauncher(AgentCoreBridgeProbe(True, "ready", "ok"))
        ready = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=ready_launcher,
            probe_ttl_seconds=30,
        ).descriptor()
        unconfigured = AgentCoreRuntimeAdapter(
            self.config(api_key=""),
            self.store,
            launcher=ready_launcher,
        ).descriptor()
        unavailable = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=FakeLauncher(
                AgentCoreBridgeProbe(
                    False,
                    "agent_core_dependency_unavailable",
                    "dependency missing",
                )
            ),
        ).descriptor()

        self.assertTrue(ready["runtime"]["configured"])
        self.assertEqual(ready["runtime"]["entrypoint"], "openjiuwen.harness.create_deep_agent")
        self.assertEqual(ready["runtime"]["tools"][0]["id"], "inspect_input")
        self.assertEqual(unconfigured["runtime"]["status"], "unconfigured")
        self.assertEqual(unavailable["runtime"]["status"], "unavailable")
        self.assertNotIn("server-secret", json.dumps(ready))
        cached_adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=ready_launcher,
        )
        cached_adapter.descriptor()
        cached_adapter.descriptor()
        cached_adapter.descriptor(refresh=True)
        self.assertEqual(ready_launcher.probe_calls, 4)

    def test_managed_launcher_does_not_inherit_service_pythonpath(self) -> None:
        adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=FakeLauncher(AgentCoreBridgeProbe(True, "ready", "ok")),
        )
        adapter.rebind_managed_environment(
            ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT).binding("agent-core")
        )

        with patch.dict(os.environ, {"PYTHONPATH": "untrusted-service-path"}):
            environment = SubprocessAgentCoreBridgeLauncher._environment(adapter.config)

        self.assertEqual(
            environment["PYTHONPATH"].split(os.pathsep),
            [str(REPOSITORY_ROOT.resolve(strict=True))],
        )

    def test_unready_environment_blocks_status_before_legacy_bridge_probe(self) -> None:
        launcher = FakeLauncher(AgentCoreBridgeProbe(True, "ready", "legacy"))
        adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
        )
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            agent_core_adapter=adapter,
            archive_enabled=False,
            runtime_environment_authority=PlannedRuntimeEnvironmentAuthority(),
        )

        status = api.dispatch(
            "GET",
            "/api/v1/agent-core?refresh=1",
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(status.body["runtime"]["status"], "unavailable")
        self.assertEqual(
            status.body["runtime"]["diagnostic"]["code"],
            "managed_environment_not_ready",
        )
        self.assertEqual(launcher.probe_calls, 0)

    def test_real_bridge_events_are_ingested_without_rewriting_evidence(self) -> None:
        lines = [
            bridge_line(event(
                "bridge-1",
                "agent.invoke",
                "start",
                title="DeepAgent invoke started",
                activeNodeIds=["deep-agent"],
            )),
            bridge_line(event(
                "bridge-2",
                "rail.hook",
                "instant",
                title="Tool allowlist review",
                hook={
                    "rail": "VisualizationTraceRail",
                    "railNodeId": "rail-tool",
                    "callback": "before_tool_call",
                    "priority": 1_000,
                    "namespace": "inner",
                    "durationMs": 0,
                    "mutationDiff": "无变更",
                    "controlSignal": "continue",
                    "noop": False,
                    "exact": True,
                    "examines": ["tool name: inspect_input", "arguments: full input"],
                },
                activeNodeIds=["rail-tool", "tool"],
            )),
            bridge_line(event(
                "bridge-3",
                "context.snapshot",
                "instant",
                title="Final model window",
                token={"used": 9, "delta": 9, "budget": 8_192},
                context={
                    "operation": "replace",
                    "messages": [{
                        "id": "message-user",
                        "role": "user",
                        "label": "Agent Core user message",
                        "raw": "full input text",
                        "preview": "full input text",
                        "tokens": 4,
                        "source": "agent-core final ContextWindow",
                    }],
                },
                activeNodeIds=["context"],
            )),
            bridge_line(event(
                "bridge-4",
                "tool.call",
                "end",
                title="inspect_input completed",
                details=[{"label": "result", "value": '{"characters":15}'}],
                activeNodeIds=["tool", "context"],
            )),
            bridge_line(event(
                "bridge-5",
                "agent.react_iteration",
                "end",
                title="ReAct iteration completed",
                iteration=1,
                activeNodeIds=["react-loop", "decision"],
            )),
            bridge_line(event(
                "bridge-6",
                "trace.status",
                "end",
                title="Agent Core trace complete",
                activeNodeIds=["output"],
            )),
        ]
        launcher = FakeLauncher(
            AgentCoreBridgeProbe(True, "ready", "ok"),
            StaticProcess(lines),
        )
        adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "ac_test",
            probe_ttl_seconds=30,
        )

        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "full input text",
                "maxOutputTokens": 128,
            },
            self.trace_token,
        )

        self.assertTrue(adapter.wait_for_terminal(accepted["invocation"]["id"]))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(events[1]["hook"]["examines"][1], "arguments: full input")
        self.assertEqual(events[2]["context"]["messages"][0]["raw"], "full input text")
        self.assertEqual(events[4]["kind"], "agent.react_iteration")
        self.assertEqual(launcher.requests[0]["maxIterations"], 5)
        self.assertNotIn("server-secret", json.dumps(events))

    def test_cancel_terminates_the_bridge_and_closes_the_trace(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(AgentCoreBridgeProbe(True, "ready", "ok"), process)
        adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "ac_cancel",
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

        cancelling = adapter.cancel(accepted["invocation"]["id"], self.trace_token)

        self.assertEqual(cancelling["invocation"]["status"], "cancelling")
        self.assertTrue(adapter.wait_for_terminal("ac_cancel"))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual([item["kind"] for item in events], ["model.cancel", "trace.status"])
        self.assertEqual(events[0]["model"]["cancelReason"], "operator_requested")

    def test_api_routes_status_start_and_cancel_through_trace_authority(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(AgentCoreBridgeProbe(True, "ready", "ok"), process)
        adapter = AgentCoreRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "ac_api",
        )
        authority = ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT)
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            agent_core_adapter=adapter,
            archive_enabled=False,
            runtime_environment_authority=authority,
        )

        status = api.dispatch("GET", "/api/v1/agent-core", origin=ALLOWED_ORIGIN)
        started = api.dispatch(
            "POST",
            "/api/v1/agent-core/invocations",
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
            "/api/v1/agent-core/invocations/ac_api/cancel",
            origin=ALLOWED_ORIGIN,
            trace_token=self.trace_token,
            body={},
        )

        self.assertEqual(status.status, 200)
        self.assertTrue(status.body["runtime"]["configured"])
        self.assertEqual(
            status.body["runtime"]["managedEnvironment"]["id"],
            "core-env",
        )
        self.assertEqual(started.status, 202)
        self.assertEqual(authority.prepare_calls, [("agent-core", True)])
        self.assertEqual(cancelled.status, 202)
        self.assertTrue(adapter.wait_for_terminal("ac_api"))
        _metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(events[0]["environment"]["consumer"], "agent-core")


if __name__ == "__main__":
    unittest.main()
