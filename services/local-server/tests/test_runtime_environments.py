from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.environment_reconciler import environment_python
from openjiuwen_visualization_server.managed_environments import (
    ManagedEnvironmentError,
    generation_id,
)
from openjiuwen_visualization_server.runtime_environments import (
    ManagedRuntimeEnvironmentAuthority,
    runtime_environment_event,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore, TraceStoreError


class FakeRegistry:
    def __init__(
        self,
        root: Path,
        desired: dict[str, object],
        active: dict[str, object],
    ) -> None:
        self.root = root
        self.desired = desired
        self.active = active
        self.descriptor_calls = 0

    def desired_spec(self, environment_id: str) -> dict[str, object]:
        self.assert_environment(environment_id)
        return self.desired

    def active_manifest(self, environment_id: str) -> dict[str, object]:
        self.assert_environment(environment_id)
        return self.active

    def descriptor(self) -> dict[str, object]:
        self.descriptor_calls += 1
        key = "coreEnv" if self.desired["id"] == "core-env" else "swarmCoreEnv"
        return {
            "environments": {
                key: {
                    "state": "ready",
                    "message": "verified",
                    "desired": self.desired,
                    "active": self.active,
                }
            }
        }

    def assert_environment(self, environment_id: str) -> None:
        if environment_id != self.desired["id"]:
            raise AssertionError(environment_id)


class FakeReconciler:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def reconcile(self, environment_id: str) -> dict[str, object]:
        self.calls.append(environment_id)
        return {"environmentId": environment_id}


class ManagedRuntimeEnvironmentAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.project = self.root / "project"
        self.project.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def authority(
        self,
        environment_id: str,
        *,
        dependency: dict[str, object] | None = None,
    ) -> tuple[ManagedRuntimeEnvironmentAuthority, FakeRegistry, FakeReconciler]:
        fingerprint = ("a" if environment_id == "core-env" else "b") * 64
        generation = (
            self.root
            / environment_id
            / "generations"
            / generation_id(fingerprint)
        )
        venv = generation / "venv"
        python = environment_python(venv)
        python.parent.mkdir(parents=True)
        python.write_bytes(b"test executable identity")
        slot = "agent-core" if environment_id == "core-env" else "jiuwenswarm"
        desired: dict[str, object] = {
            "id": environment_id,
            "fingerprint": fingerprint,
            "resolution": {"status": "ready"},
            "project": {
                "slot": slot,
                "source": {
                    "path": str(self.project),
                    "revision": "1" * 40,
                    "dirty": False,
                },
            },
            "sync": {"projectRoot": str(self.project)},
            "coreDependency": dependency,
        }
        active: dict[str, object] = {
            "fingerprint": fingerprint,
            "generationPath": str(generation),
            "venvPath": str(venv),
            "pythonExecutable": str(python),
            "pythonVersion": "3.11.9",
            "uvVersion": "0.9.0",
            "activatedAt": "2025-01-01T00:00:00Z",
            "validation": {"status": "passed"},
        }
        registry = FakeRegistry(self.root, desired, active)
        reconciler = FakeReconciler()
        authority = ManagedRuntimeEnvironmentAuthority(registry, reconciler)  # type: ignore[arg-type]
        return authority, registry, reconciler

    def test_prepare_reconciles_and_returns_exact_core_generation(self) -> None:
        authority, _registry, reconciler = self.authority("core-env")

        binding = authority.prepare("agent-core")

        self.assertEqual(reconciler.calls, ["core-env"])
        self.assertEqual(binding.consumer, "agent-core")
        self.assertEqual(binding.project_root, self.project)
        self.assertTrue(binding.python_executable.is_file())
        self.assertEqual(binding.evidence()["validation"], "passed")
        status = authority.descriptor("agent-core")
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["activeFingerprint"], binding.fingerprint)

    def test_remote_swarm_dependency_uses_lock_identity_without_local_core_path(self) -> None:
        authority, _registry, _reconciler = self.authority(
            "swarm-core-env",
            dependency={
                "kind": "git",
                "url": "https://example.invalid/core.git",
                "lockedRevision": "2" * 40,
            },
        )

        binding = authority.current_binding("swarmflow")

        self.assertIsNone(binding.core_source_root)
        self.assertEqual(binding.core_dependency_revision, "2" * 40)
        self.assertEqual(binding.source_revisions()["agent-core"], "2" * 40)

    def test_tampered_python_identity_is_not_reported_ready(self) -> None:
        authority, registry, _reconciler = self.authority("core-env")
        Path(str(registry.active["pythonExecutable"])).unlink()

        with self.assertRaises(ManagedEnvironmentError) as raised:
            authority.current_binding("subagent")

        self.assertEqual(raised.exception.code, "managed_environment_active_invalid")
        status = authority.descriptor("subagent")
        self.assertEqual(status["state"], "drifted")
        self.assertEqual(
            status["diagnostic"]["code"],
            "managed_environment_active_invalid",
        )

    def test_status_snapshot_is_shared_until_an_explicit_refresh(self) -> None:
        authority, registry, _reconciler = self.authority("core-env")

        authority.descriptor("agent-core")
        authority.descriptor("subagent")
        self.assertEqual(registry.descriptor_calls, 1)

        authority.descriptor("agent-core", refresh=True)
        self.assertEqual(registry.descriptor_calls, 2)

    def test_environment_trace_evidence_is_validated_and_stored(self) -> None:
        authority, _registry, _reconciler = self.authority("core-env")
        binding = authority.current_binding("agent-core")
        store = RuntimeTraceStore()
        trace, token = store.create(
            owner="agent-core",
            label="environment trace",
            max_tokens=8_192,
        )

        store.append(
            trace["id"],
            token,
            [runtime_environment_event(binding, "ac_test", timestamp_ms=0)],
        )
        _metadata, events = store.snapshot(trace["id"])

        self.assertEqual(events[0]["environment"]["fingerprint"], binding.fingerprint)
        invalid = runtime_environment_event(binding, "ac_bad", timestamp_ms=1)
        invalid["environment"]["project"]["slot"] = "jiuwenswarm"
        with self.assertRaises(TraceStoreError):
            store.append(trace["id"], token, [invalid])


if __name__ == "__main__":
    unittest.main()
