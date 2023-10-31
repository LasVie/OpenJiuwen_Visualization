from __future__ import annotations

import json
import os
import threading
import unittest
from io import StringIO
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.openrouter_provider import OpenRouterProviderConfig
from openjiuwen_visualization_server.subagent_runtime import (
    BRIDGE_RECORD_PREFIX,
    SubagentBridgeProbe,
    SubagentRuntimeAdapter,
    SubagentRuntimeConfig,
    SubagentRuntimeError,
    SubprocessSubagentBridgeLauncher,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore
from runtime_environment_support import ReadyRuntimeEnvironmentAuthority


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALLOWED_ORIGIN = "http://127.0.0.1:4173"
PARENT_SUBJECT = {
    "id": "member:subagent-dispatcher:sub_test",
    "kind": "member",
    "label": "Subagent Dispatcher",
    "role": "parent",
    "contextOwnerId": "context:session_sub_test:parent",
}
CHILD_SUBJECT = {
    "id": "subagent:sub_test:analysis",
    "kind": "subagent",
    "label": "Analysis Subagent",
    "parentId": PARENT_SUBJECT["id"],
    "role": "child",
    "contextOwnerId": "context:session_sub_test:child:analysis",
}
OBSERVATION = {
    "invocationId": "sub_test:child:1",
    "subagentType": "analysis_subagent",
    "dispatcher": "task-tool",
    "runMode": "foreground",
    "parentSessionId": "session_sub_test",
    "sessionId": "session_sub_test_sub_analysis_subagent_ab12cd34",
    "contextOwnerId": CHILD_SUBJECT["contextOwnerId"],
    "sessionPolicy": "ephemeral",
    "workspaceIsolation": "subdirectory",
    "toolPolicy": "configured",
    "toolCallSpanId": "sub_test:parent:tool:1",
}


def bridge_line(item: dict[str, Any]) -> str:
    return BRIDGE_RECORD_PREFIX + json.dumps({"type": "event", "event": item}) + "\n"


def event(event_id: str, kind: str, phase: str, **values: Any) -> dict[str, Any]:
    return {
        "eventId": event_id,
        "kind": kind,
        "phase": phase,
        "timestampMs": 1,
        "spanId": values.pop("spanId", "span-subagent"),
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
        probe: SubagentBridgeProbe,
        process: StaticProcess | BlockingProcess | None = None,
    ) -> None:
        self.probe_result = probe
        self.process = process
        self.requests: list[dict[str, Any]] = []
        self.probe_calls = 0

    def probe(self, config: SubagentRuntimeConfig) -> SubagentBridgeProbe:
        del config
        self.probe_calls += 1
        return self.probe_result

    def start(
        self,
        config: SubagentRuntimeConfig,
        request: dict[str, Any],
    ) -> StaticProcess | BlockingProcess:
        del config
        self.requests.append(request)
        if self.process is None:
            raise OSError("missing fake process")
        return self.process


class SubagentRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RuntimeTraceStore()
        self.trace, self.trace_token = self.store.create(
            owner="jiuwenswarm",
            label="Subagent test",
            max_tokens=32_768,
        )

    @staticmethod
    def config(*, api_key: str = "server-secret") -> SubagentRuntimeConfig:
        path = Path(__file__).resolve()
        return SubagentRuntimeConfig(
            agent_core_root=REPOSITORY_ROOT.parent / "agent-core",
            python_executable=path,
            bridge_script=path,
            workspace=REPOSITORY_ROOT / ".subagent-runtime-test",
            provider=OpenRouterProviderConfig(
                api_key=api_key,
                models=("test/model",),
                default_model="test/model",
            ),
            max_iterations=7,
        )

    def test_descriptor_exposes_only_the_fixed_single_child_profile(self) -> None:
        launcher = FakeLauncher(SubagentBridgeProbe(True, "ready", "ok", "source-checkout"))
        ready = SubagentRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            probe_ttl_seconds=30,
        )
        descriptor = ready.descriptor()
        ready.descriptor()
        ready.descriptor(refresh=True)
        unconfigured = SubagentRuntimeAdapter(
            self.config(api_key=""),
            self.store,
            launcher=launcher,
        ).descriptor()

        runtime = descriptor["runtime"]
        self.assertTrue(runtime["configured"])
        self.assertEqual(runtime["profile"], "fixed-single-child")
        self.assertEqual(runtime["dispatcher"], "task-tool")
        self.assertEqual(runtime["runMode"], "foreground")
        self.assertEqual(runtime["limits"]["maxDepth"], 1)
        self.assertEqual(
            [tool["id"] for tool in runtime["tools"]],
            ["task_tool", "inspect_delegated_task"],
        )
        self.assertFalse(runtime["swarmFlow"])
        self.assertEqual(unconfigured["runtime"]["status"], "unconfigured")
        self.assertNotIn("server-secret", json.dumps(descriptor))
        self.assertEqual(launcher.probe_calls, 3)

    def test_managed_launcher_does_not_inherit_service_pythonpath(self) -> None:
        adapter = SubagentRuntimeAdapter(
            self.config(),
            self.store,
            launcher=FakeLauncher(SubagentBridgeProbe(True, "ready", "ok")),
        )
        adapter.rebind_managed_environment(
            ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT).binding("subagent")
        )

        with patch.dict(os.environ, {"PYTHONPATH": "untrusted-service-path"}):
            environment = SubprocessSubagentBridgeLauncher._environment(adapter.config)

        self.assertEqual(
            environment["PYTHONPATH"].split(os.pathsep),
            [str(REPOSITORY_ROOT.resolve(strict=True))],
        )

    def test_bridge_events_preserve_child_identity_and_separate_context(self) -> None:
        lines = [
            bridge_line(event(
                "sub-1", "swarm.member", "start",
                title="Parent start", subject=PARENT_SUBJECT, payload={"status": "running"},
            )),
            bridge_line(event(
                "sub-2", "swarm.subagent", "start",
                title="Child start", subject=CHILD_SUBJECT, subagent=OBSERVATION,
                spanId=OBSERVATION["invocationId"],
            )),
            bridge_line(event(
                "sub-3", "context.snapshot", "instant",
                title="Child context", subject=CHILD_SUBJECT,
                token={"used": 8, "delta": 8, "budget": 32_768},
                context={
                    "operation": "replace",
                    "ownerId": CHILD_SUBJECT["contextOwnerId"],
                    "messages": [{
                        "id": "child-message",
                        "role": "assistant",
                        "label": "Child result",
                        "raw": "full child result",
                        "preview": "child result",
                        "tokens": 8,
                        "source": "child ModelContext",
                    }],
                },
            )),
            bridge_line(event(
                "sub-4", "swarm.subagent", "end",
                title="Child end", subject=CHILD_SUBJECT,
                subagent={**OBSERVATION, "resultPreview": "child result"},
                spanId=OBSERVATION["invocationId"],
            )),
            bridge_line(event("sub-5", "trace.status", "end", title="complete")),
        ]
        launcher = FakeLauncher(
            SubagentBridgeProbe(True, "ready", "ok"),
            StaticProcess(lines),
        )
        adapter = SubagentRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sub_test",
        )

        accepted = adapter.start({
            "traceId": self.trace["id"],
            "modelId": "test/model",
            "input": "inspect this delegation",
            "maxOutputTokens": 128,
        }, self.trace_token)

        self.assertTrue(adapter.wait_for_terminal(accepted["invocation"]["id"]))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(events[1]["subject"]["parentId"], PARENT_SUBJECT["id"])
        self.assertEqual(events[1]["subagent"]["sessionId"], OBSERVATION["sessionId"])
        self.assertEqual(events[2]["context"]["ownerId"], CHILD_SUBJECT["contextOwnerId"])
        self.assertEqual(events[2]["context"]["messages"][0]["raw"], "full child result")
        self.assertEqual(events[3]["subagent"]["resultPreview"], "child result")
        request = launcher.requests[0]
        self.assertEqual(request["parentSessionId"], "session_sub_test")
        self.assertEqual(request["childType"], "analysis_subagent")
        self.assertEqual(request["maxIterations"], 7)
        self.assertNotIn("server-secret", json.dumps(request))

    def test_capacity_is_bounded_and_cancel_closes_the_whole_process_tree(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(SubagentBridgeProbe(True, "ready", "ok"), process)
        adapter = SubagentRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sub_cancel",
        )
        accepted = adapter.start({
            "traceId": self.trace["id"],
            "modelId": "test/model",
            "input": "cancel me",
            "maxOutputTokens": 64,
        }, self.trace_token)
        self.assertTrue(process.started.wait(1))
        second_trace, second_token = self.store.create(
            owner="jiuwenswarm", label="Second trace", max_tokens=8_192,
        )
        with self.assertRaisesRegex(SubagentRuntimeError, "invocation limit") as raised:
            adapter.start({
                "traceId": second_trace["id"],
                "modelId": "test/model",
                "input": "second",
                "maxOutputTokens": 64,
            }, second_token)
        self.assertEqual(raised.exception.code, "subagent_capacity_reached")

        cancelling = adapter.cancel(accepted["invocation"]["id"], self.trace_token)

        self.assertEqual(cancelling["invocation"]["status"], "cancelling")
        self.assertTrue(adapter.wait_for_terminal("sub_cancel"))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual([item["kind"] for item in events], ["swarm.member", "trace.status"])
        self.assertEqual(events[0]["payload"]["status"], "cancelled")

    def test_api_status_start_and_cancel_use_swarm_trace_authority(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(SubagentBridgeProbe(True, "ready", "ok"), process)
        adapter = SubagentRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "sub_api",
        )
        authority = ReadyRuntimeEnvironmentAuthority(REPOSITORY_ROOT)
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            subagent_adapter=adapter,
            archive_enabled=False,
            runtime_environment_authority=authority,
        )

        status = api.dispatch("GET", "/api/v1/subagents", origin=ALLOWED_ORIGIN)
        started = api.dispatch(
            "POST",
            "/api/v1/subagents/invocations",
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
            "/api/v1/subagents/invocations/sub_api/cancel",
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
        self.assertEqual(authority.prepare_calls, [("subagent", True)])
        self.assertEqual(cancelled.status, 202)
        self.assertTrue(adapter.wait_for_terminal("sub_api"))
        _metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(events[0]["environment"]["consumer"], "subagent")


if __name__ == "__main__":
    unittest.main()
