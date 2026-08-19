from __future__ import annotations

import json
import threading
import unittest
from io import StringIO
from pathlib import Path
from typing import Any, Iterator

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.openrouter_provider import OpenRouterProviderConfig
from openjiuwen_visualization_server.swarmflow_runtime import (
    BRIDGE_RECORD_PREFIX,
    SwarmFlowBridgeProbe,
    SwarmFlowRuntimeAdapter,
    SwarmFlowRuntimeConfig,
    SwarmFlowRuntimeError,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore


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
        "spanId": "span-swarmflow",
        **values,
    }


TEAM_SUBJECT = {
    "id": "team:visualization_swarmflow_wf_test",
    "kind": "team",
    "label": "Visualization SwarmFlow",
}
WORKFLOW_SUBJECT = {
    "id": "workflow:workflow_wf_test",
    "kind": "workflow",
    "label": "Two-phase response flow",
    "parentId": TEAM_SUBJECT["id"],
    "role": "fixed-workflow",
}
PHASE_SUBJECT = {
    "id": "phase:workflow_wf_test:understand-input-1",
    "kind": "phase",
    "label": "Understand Input",
    "parentId": WORKFLOW_SUBJECT["id"],
    "role": "author-phase",
}
AGENT_SUBJECT = {
    "id": "agent:workflow_wf_test:analysis",
    "kind": "agent",
    "label": "Analysis Worker",
    "parentId": PHASE_SUBJECT["id"],
    "role": "swarmflow-worker",
    "contextOwnerId": "context:session_wf_test:analysis",
}


class StaticProcess:
    def __init__(self, lines: list[str], exit_code: int = 0) -> None:
        self.stdout = StringIO("".join(lines))
        self.exit_code = exit_code

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.exit_code

    def terminate(self) -> None:
        self.exit_code = 1

    def kill(self) -> None:
        self.exit_code = 1


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
        probe: SwarmFlowBridgeProbe,
        process: StaticProcess | BlockingProcess | None = None,
    ) -> None:
        self.probe_result = probe
        self.process = process
        self.requests: list[dict[str, Any]] = []
        self.probe_calls = 0

    def probe(self, config: SwarmFlowRuntimeConfig) -> SwarmFlowBridgeProbe:
        del config
        self.probe_calls += 1
        return self.probe_result

    def start(
        self,
        config: SwarmFlowRuntimeConfig,
        request: dict[str, Any],
    ) -> StaticProcess | BlockingProcess:
        del config
        self.requests.append(request)
        if self.process is None:
            raise OSError("missing fake process")
        return self.process


class SwarmFlowRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RuntimeTraceStore()
        self.trace, self.trace_token = self.store.create(
            owner="jiuwenswarm",
            label="SwarmFlow test",
            max_tokens=32_768,
        )

    @staticmethod
    def config(*, api_key: str = "server-secret") -> SwarmFlowRuntimeConfig:
        path = Path(__file__).resolve()
        return SwarmFlowRuntimeConfig(
            source_root=REPOSITORY_ROOT.parent / "jiuwenswarm",
            agent_core_root=REPOSITORY_ROOT.parent / "agent-core",
            python_executable=path,
            bridge_script=path,
            workflow_script=path,
            workspace=REPOSITORY_ROOT / ".swarmflow-runtime-test",
            provider=OpenRouterProviderConfig(
                api_key=api_key,
                models=("test/model",),
                default_model="test/model",
            ),
            max_iterations=7,
        )

    def test_descriptor_exposes_fixed_non_interactive_profile(self) -> None:
        launcher = FakeLauncher(SwarmFlowBridgeProbe(True, "ready", "ok"))
        adapter = SwarmFlowRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            probe_ttl_seconds=30,
        )

        ready = adapter.descriptor()
        adapter.descriptor()
        adapter.descriptor(refresh=True)
        unconfigured = SwarmFlowRuntimeAdapter(
            self.config(api_key=""),
            self.store,
            launcher=launcher,
        ).descriptor()

        runtime = ready["runtime"]
        self.assertTrue(runtime["configured"])
        self.assertEqual(runtime["entrypoint"], "openjiuwen.agent_teams.workflow.run_swarmflow")
        self.assertEqual(runtime["profile"], "fixed-two-phase")
        self.assertTrue(runtime["swarmFlow"])
        self.assertEqual(runtime["dispatchMode"], "sequential")
        self.assertEqual(runtime["contextOwnership"], "per-agent")
        self.assertEqual(runtime["tools"], [])
        self.assertEqual(len(runtime["phases"]), 2)
        self.assertFalse(runtime["humanInLoop"])
        self.assertEqual(unconfigured["runtime"]["status"], "unconfigured")
        self.assertNotIn("server-secret", json.dumps(ready))
        self.assertEqual(launcher.probe_calls, 3)

    def test_bridge_events_preserve_workflow_hierarchy_and_agent_context(self) -> None:
        lines = [
            bridge_line(event(
                "wf-1",
                "swarm.team",
                "start",
                subject=TEAM_SUBJECT,
                payload={"status": "running", "swarmFlow": True},
            )),
            bridge_line(event(
                "wf-2",
                "swarm.workflow",
                "start",
                subject=WORKFLOW_SUBJECT,
                payload={"status": "running", "runId": "workflow_wf_test"},
            )),
            bridge_line(event(
                "wf-3",
                "swarm.phase",
                "start",
                subject=PHASE_SUBJECT,
                payload={"status": "running", "runId": "workflow_wf_test"},
            )),
            bridge_line(event(
                "wf-4",
                "swarm.agent",
                "start",
                subject=AGENT_SUBJECT,
                payload={"status": "running", "workerEphemeral": True},
            )),
            bridge_line(event(
                "wf-5",
                "context.snapshot",
                "instant",
                subject=AGENT_SUBJECT,
                token={"used": 11, "delta": 11, "budget": 32_768},
                context={
                    "operation": "replace",
                    "ownerId": AGENT_SUBJECT["contextOwnerId"],
                    "messages": [{
                        "id": "analysis-message",
                        "role": "assistant",
                        "label": "Analysis result",
                        "raw": "full analysis worker result",
                        "preview": "analysis result",
                        "tokens": 11,
                        "source": "SwarmFlow Analysis Worker ModelContext",
                    }],
                },
            )),
            bridge_line(event("wf-6", "trace.status", "end", title="complete")),
        ]
        launcher = FakeLauncher(
            SwarmFlowBridgeProbe(True, "ready", "ok"),
            StaticProcess(lines),
        )
        adapter = SwarmFlowRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "wf_test",
        )

        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "inspect this workflow",
                "maxOutputTokens": 128,
            },
            self.trace_token,
        )

        self.assertTrue(adapter.wait_for_terminal(accepted["invocation"]["id"]))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(events[1]["subject"]["parentId"], TEAM_SUBJECT["id"])
        self.assertEqual(events[2]["subject"]["parentId"], WORKFLOW_SUBJECT["id"])
        self.assertEqual(events[3]["subject"]["parentId"], PHASE_SUBJECT["id"])
        self.assertEqual(events[4]["context"]["ownerId"], AGENT_SUBJECT["contextOwnerId"])
        self.assertEqual(events[4]["context"]["messages"][0]["raw"], "full analysis worker result")
        request = launcher.requests[0]
        self.assertEqual(request["maxIterations"], 7)
        self.assertEqual(request["runId"], "workflow_wf_test")
        self.assertEqual(request["workflowScript"], str(self.config().workflow_script))
        self.assertNotIn("server-secret", json.dumps(events))

    def test_request_shape_is_closed_and_cancel_closes_trace(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(SwarmFlowBridgeProbe(True, "ready", "ok"), process)
        adapter = SwarmFlowRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "wf_cancel",
        )
        with self.assertRaisesRegex(SwarmFlowRuntimeError, "Unsupported"):
            adapter.start(
                {
                    "traceId": self.trace["id"],
                    "modelId": "test/model",
                    "input": "reject arbitrary script",
                    "maxOutputTokens": 64,
                    "script": "print('not allowed')",
                },
                self.trace_token,
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
        self.assertTrue(adapter.wait_for_terminal("wf_cancel"))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(
            [item["kind"] for item in events],
            ["swarm.workflow", "swarm.team", "trace.status"],
        )
        self.assertEqual(events[0]["payload"]["status"], "cancelled")

    def test_api_status_start_and_cancel_use_swarm_trace_authority(self) -> None:
        process = BlockingProcess()
        launcher = FakeLauncher(SwarmFlowBridgeProbe(True, "ready", "ok"), process)
        adapter = SwarmFlowRuntimeAdapter(
            self.config(),
            self.store,
            launcher=launcher,
            id_factory=lambda: "wf_api",
        )
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            swarmflow_adapter=adapter,
        )

        status = api.dispatch("GET", "/api/v1/swarmflows", origin=ALLOWED_ORIGIN)
        started = api.dispatch(
            "POST",
            "/api/v1/swarmflows/invocations",
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
            "/api/v1/swarmflows/invocations/wf_api/cancel",
            origin=ALLOWED_ORIGIN,
            trace_token=self.trace_token,
            body={},
        )

        self.assertEqual(status.status, 200)
        self.assertTrue(status.body["runtime"]["configured"])
        self.assertEqual(started.status, 202)
        self.assertEqual(cancelled.status, 202)
        self.assertTrue(adapter.wait_for_terminal("wf_api"))


if __name__ == "__main__":
    unittest.main()
