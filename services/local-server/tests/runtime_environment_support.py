from __future__ import annotations

import sys
from pathlib import Path

from openjiuwen_visualization_server.runtime_environments import (
    CONSUMER_ENVIRONMENTS,
    RuntimeEnvironmentBinding,
)
from openjiuwen_visualization_server.managed_environments import ManagedEnvironmentError


class ReadyRuntimeEnvironmentAuthority:
    """Small API-test authority representing two already verified generations."""

    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root.resolve(strict=True)
        self.prepare_calls: list[tuple[str, bool]] = []

    def binding(self, consumer: str) -> RuntimeEnvironmentBinding:
        environment_id = CONSUMER_ENVIRONMENTS[consumer]
        swarm = environment_id == "swarm-core-env"
        fingerprint = ("b" if swarm else "a") * 64
        return RuntimeEnvironmentBinding(
            environment_id=environment_id,
            consumer=consumer,
            fingerprint=fingerprint,
            generation_path=self.project_root,
            python_executable=Path(sys.executable).resolve(strict=True),
            python_version="3.11.9",
            uv_version="0.9.0",
            activated_at="2025-01-01T00:00:00Z",
            project_slot="jiuwenswarm" if swarm else "agent-core",
            project_root=self.project_root,
            project_revision=("2" if swarm else "1") * 40,
            project_dirty=False,
            core_dependency_kind="path" if swarm else None,
            core_dependency_revision="1" * 40 if swarm else None,
            core_source_root=self.project_root if swarm else None,
        )

    def current_binding(
        self,
        consumer: str,
        *,
        refresh: bool = True,
    ) -> RuntimeEnvironmentBinding:
        del refresh
        return self.binding(consumer)

    def prepare(
        self,
        consumer: str,
        *,
        reconcile: bool = True,
    ) -> RuntimeEnvironmentBinding:
        self.prepare_calls.append((consumer, reconcile))
        return self.binding(consumer)

    def descriptor(
        self,
        consumer: str,
        *,
        refresh: bool = False,
    ) -> dict[str, object]:
        del refresh
        binding = self.binding(consumer)
        return {
            "id": binding.environment_id,
            "consumer": consumer,
            "state": "ready",
            "desiredFingerprint": binding.fingerprint,
            "activeFingerprint": binding.fingerprint,
            "pythonVersion": binding.python_version,
            "uvVersion": binding.uv_version,
            "autoReconcile": "before-runtime-invocation",
            "diagnostic": {
                "code": "ready",
                "message": "The test generation is verified.",
            },
        }

    def invalidate_status_cache(self) -> None:
        pass


class PlannedRuntimeEnvironmentAuthority:
    """API-test authority that must block before any legacy bridge probe."""

    def current_binding(
        self,
        consumer: str,
        *,
        refresh: bool = True,
    ) -> RuntimeEnvironmentBinding:
        del consumer, refresh
        raise ManagedEnvironmentError(
            "managed_environment_not_ready",
            "Build and verify the managed runtime environment.",
            status=409,
        )

    def prepare(
        self,
        consumer: str,
        *,
        reconcile: bool = True,
    ) -> RuntimeEnvironmentBinding:
        del consumer, reconcile
        raise ManagedEnvironmentError(
            "managed_environment_not_ready",
            "Build and verify the managed runtime environment.",
            status=409,
        )

    def descriptor(
        self,
        consumer: str,
        *,
        refresh: bool = False,
    ) -> dict[str, object]:
        del refresh
        return {
            "id": CONSUMER_ENVIRONMENTS[consumer],
            "consumer": consumer,
            "state": "planned",
            "desiredFingerprint": "c" * 64,
            "activeFingerprint": None,
            "pythonVersion": None,
            "uvVersion": None,
            "autoReconcile": "before-runtime-invocation",
            "diagnostic": {
                "code": "managed_environment_not_ready",
                "message": "Build and verify the managed runtime environment.",
            },
        }

    def invalidate_status_cache(self) -> None:
        pass
