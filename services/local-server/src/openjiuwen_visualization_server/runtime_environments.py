"""Runtime bindings derived only from verified managed environment manifests."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .environment_reconciler import ManagedEnvironmentReconciler, environment_python
from .managed_environments import (
    FINGERPRINT_PATTERN,
    ManagedEnvironmentError,
    ManagedEnvironmentRegistry,
    generation_id,
)


RUNTIME_ENVIRONMENT_CONSUMERS = frozenset(
    {"agent-core", "subagent", "jiuwenswarm", "swarmflow"}
)
CONSUMER_ENVIRONMENTS = {
    "agent-core": "core-env",
    "subagent": "core-env",
    "jiuwenswarm": "swarm-core-env",
    "swarmflow": "swarm-core-env",
}
STATUS_SNAPSHOT_TTL_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class RuntimeEnvironmentBinding:
    """Validated internal paths plus the bounded identity recorded in a Trace."""

    environment_id: str
    consumer: str
    fingerprint: str
    generation_path: Path
    python_executable: Path
    python_version: str
    uv_version: str
    activated_at: str
    project_slot: str
    project_root: Path
    project_revision: str | None
    project_dirty: bool | None
    core_dependency_kind: str | None = None
    core_dependency_revision: str | None = None
    core_source_root: Path | None = None

    def source_revisions(self) -> dict[str, str]:
        revisions: dict[str, str] = {}
        if self.project_revision:
            revisions[self.project_slot] = self.project_revision
        if self.environment_id == "swarm-core-env" and self.core_dependency_revision:
            revisions["agent-core"] = self.core_dependency_revision
        return revisions

    def evidence(self) -> dict[str, object]:
        return {
            "id": self.environment_id,
            "consumer": self.consumer,
            "fingerprint": self.fingerprint,
            "pythonVersion": self.python_version,
            "uvVersion": self.uv_version,
            "activatedAt": self.activated_at,
            "project": {
                "slot": self.project_slot,
                "revision": self.project_revision,
                "dirty": self.project_dirty,
            },
            "coreDependency": (
                {
                    "kind": self.core_dependency_kind,
                    "revision": self.core_dependency_revision,
                }
                if self.core_dependency_kind is not None
                else None
            ),
            "validation": "passed",
        }


class ManagedRuntimeEnvironmentAuthority:
    """Reconcile before a run and resolve only the matching active generation."""

    def __init__(
        self,
        registry: ManagedEnvironmentRegistry,
        reconciler: ManagedEnvironmentReconciler,
    ) -> None:
        self.registry = registry
        self.reconciler = reconciler
        self._status_lock = threading.RLock()
        self._status_snapshot: tuple[float, dict[str, object]] | None = None

    @staticmethod
    def environment_id(consumer: str) -> str:
        try:
            return CONSUMER_ENVIRONMENTS[consumer]
        except KeyError as exc:
            raise ManagedEnvironmentError(
                "invalid_environment_consumer",
                "Runtime environment consumer is not registered.",
                status=400,
            ) from exc

    def prepare(self, consumer: str, *, reconcile: bool = True) -> RuntimeEnvironmentBinding:
        environment_id = self.environment_id(consumer)
        if reconcile:
            try:
                self.reconciler.reconcile(environment_id)
            finally:
                self.invalidate_status_cache()
        return self.current_binding(consumer, refresh=True)

    def current_binding(
        self,
        consumer: str,
        *,
        refresh: bool = True,
    ) -> RuntimeEnvironmentBinding:
        environment_id = self.environment_id(consumer)
        status = self._environment_status(
            self._registry_snapshot(refresh=refresh),
            environment_id,
        )
        desired = status.get("desired")
        active = status.get("active")
        if not isinstance(desired, dict):
            raise ManagedEnvironmentError(
                "managed_environment_status_unavailable",
                "Managed runtime environment desired state is unavailable.",
                status=503,
            )
        fingerprint = str(desired.get("fingerprint") or "")
        resolution = desired.get("resolution")
        if not isinstance(resolution, dict) or resolution.get("status") != "ready":
            raise ManagedEnvironmentError(
                str(
                    resolution.get("code")
                    if isinstance(resolution, dict)
                    else "managed_environment_blocked"
                ),
                str(
                    resolution.get("message")
                    if isinstance(resolution, dict)
                    else "Managed runtime environment is blocked."
                ),
                status=409,
            )
        if (
            not isinstance(active, dict)
            or not FINGERPRINT_PATTERN.fullmatch(fingerprint)
            or active.get("fingerprint") != fingerprint
        ):
            raise ManagedEnvironmentError(
                "managed_environment_not_ready",
                "Build and verify the managed runtime environment from Connection settings.",
                status=409,
            )
        return self._binding(environment_id, consumer, desired, active)

    def descriptor(
        self,
        consumer: str,
        *,
        refresh: bool = False,
    ) -> dict[str, object]:
        environment_id = self.environment_id(consumer)
        status = self._environment_status(
            self._registry_snapshot(refresh=refresh),
            environment_id,
        )
        active = status.get("active")
        state = status.get("state")
        validation_error: ManagedEnvironmentError | None = None
        binding: RuntimeEnvironmentBinding | None = None
        if state == "ready":
            try:
                desired = status.get("desired")
                if not isinstance(desired, dict) or not isinstance(active, dict):
                    raise ManagedEnvironmentError(
                        "managed_environment_status_unavailable",
                        "Managed runtime environment identity is unavailable.",
                        status=503,
                    )
                binding = self._binding(
                    environment_id,
                    consumer,
                    desired,
                    active,
                )
            except ManagedEnvironmentError as exc:
                state = "drifted"
                validation_error = exc
        desired_status = status.get("desired")
        resolution = (
            desired_status.get("resolution")
            if isinstance(desired_status, dict)
            else None
        )
        diagnostic_code = (
            validation_error.code
            if validation_error is not None
            else str(resolution.get("code"))
            if state == "blocked" and isinstance(resolution, dict)
            else "ready"
            if state == "ready"
            else "managed_environment_not_ready"
        )
        diagnostic_message = (
            str(validation_error)
            if validation_error is not None
            else str(resolution.get("message"))
            if state == "blocked" and isinstance(resolution, dict)
            else str(status.get("message") or "Managed runtime environment is not ready.")
        )
        return {
            "id": environment_id,
            "consumer": consumer,
            "state": state,
            "desiredFingerprint": (
                status.get("desired", {}).get("fingerprint")
                if isinstance(status.get("desired"), dict)
                else None
            ),
            "activeFingerprint": (
                active.get("fingerprint") if isinstance(active, dict) else None
            ),
            "pythonVersion": binding.python_version if binding is not None else None,
            "uvVersion": binding.uv_version if binding is not None else None,
            "autoReconcile": "before-runtime-invocation",
            "diagnostic": {
                "code": diagnostic_code,
                "message": diagnostic_message,
            },
        }

    def invalidate_status_cache(self) -> None:
        """Discard status-only evidence after repository or environment changes."""

        with self._status_lock:
            self._status_snapshot = None

    def _registry_snapshot(self, *, refresh: bool) -> dict[str, object]:
        with self._status_lock:
            now = time.monotonic()
            if not refresh and self._status_snapshot is not None:
                captured_at, snapshot = self._status_snapshot
                if now - captured_at <= STATUS_SNAPSHOT_TTL_SECONDS:
                    return snapshot
            snapshot = self.registry.descriptor()
            self._status_snapshot = (time.monotonic(), snapshot)
            return snapshot

    @staticmethod
    def _environment_status(
        registry: dict[str, object],
        environment_id: str,
    ) -> dict[str, Any]:
        environments = registry.get("environments")
        key = "coreEnv" if environment_id == "core-env" else "swarmCoreEnv"
        status = environments.get(key) if isinstance(environments, dict) else None
        if not isinstance(status, dict):
            raise ManagedEnvironmentError(
                "managed_environment_status_unavailable",
                "Managed runtime environment status is unavailable.",
                status=503,
            )
        return status

    def _binding(
        self,
        environment_id: str,
        consumer: str,
        desired: dict[str, object],
        active: dict[str, Any],
    ) -> RuntimeEnvironmentBinding:
        fingerprint = str(desired["fingerprint"])
        expected_generation = (
            self.registry.root
            / environment_id
            / "generations"
            / generation_id(fingerprint)
        ).resolve(strict=False)
        try:
            generation = Path(str(active.get("generationPath", ""))).resolve(
                strict=True
            )
            venv = Path(str(active.get("venvPath", ""))).resolve(strict=True)
            python = Path(str(active.get("pythonExecutable", ""))).resolve(
                strict=True
            )
        except OSError as exc:
            raise ManagedEnvironmentError(
                "managed_environment_active_invalid",
                "The active managed environment is unavailable or incomplete.",
                status=409,
            ) from exc
        validation = active.get("validation")
        if (
            generation != expected_generation
            or venv != generation / "venv"
            or python != environment_python(venv).resolve(strict=False)
            or not python.is_file()
            or not isinstance(validation, dict)
            or validation.get("status") != "passed"
        ):
            raise ManagedEnvironmentError(
                "managed_environment_active_invalid",
                "The active managed environment failed identity validation.",
                status=409,
            )

        project = desired.get("project")
        source = project.get("source") if isinstance(project, dict) else None
        sync = desired.get("sync")
        raw_project_root = (
            sync.get("projectRoot") if isinstance(sync, dict) else None
        )
        if (
            not isinstance(project, dict)
            or project.get("slot") not in {"agent-core", "jiuwenswarm"}
            or not isinstance(source, dict)
            or not isinstance(raw_project_root, str)
        ):
            raise ManagedEnvironmentError(
                "managed_environment_project_invalid",
                "Managed runtime project evidence is invalid.",
                status=409,
            )
        try:
            project_root = Path(raw_project_root).resolve(strict=True)
            source_root = Path(str(source.get("path") or "")).resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "managed_environment_project_unavailable",
                "Managed runtime project source is unavailable.",
                status=409,
            ) from exc
        if not project_root.is_dir() or source_root != project_root:
            raise ManagedEnvironmentError(
                "managed_environment_project_invalid",
                "Managed runtime project path does not match active source evidence.",
                status=409,
            )
        expected_slot = "agent-core" if environment_id == "core-env" else "jiuwenswarm"
        if project.get("slot") != expected_slot:
            raise ManagedEnvironmentError(
                "managed_environment_project_invalid",
                "Managed runtime project slot does not own this environment.",
                status=409,
            )

        dependency = desired.get("coreDependency")
        dependency_kind: str | None = None
        dependency_revision: str | None = None
        core_source_root: Path | None = None
        if environment_id == "swarm-core-env":
            if not isinstance(dependency, dict):
                raise ManagedEnvironmentError(
                    "managed_environment_core_dependency_invalid",
                    "Swarm runtime environment has no verified Core dependency.",
                    status=409,
                )
            dependency_kind = str(dependency.get("kind") or "")
            if dependency_kind == "git":
                dependency_revision = self._optional_text(
                    dependency.get("lockedRevision")
                )
                if dependency_revision is None:
                    raise ManagedEnvironmentError(
                        "managed_environment_core_dependency_invalid",
                        "Remote Swarm Core dependency has no locked revision.",
                        status=409,
                    )
            elif dependency_kind == "path":
                dependency_revision = self._optional_text(dependency.get("revision"))
                raw_core_root = dependency.get("path")
                if not isinstance(raw_core_root, str):
                    raise ManagedEnvironmentError(
                        "managed_environment_core_dependency_invalid",
                        "Local Swarm Core dependency path is invalid.",
                        status=409,
                    )
                try:
                    core_source_root = Path(raw_core_root).resolve(strict=True)
                except OSError as exc:
                    raise ManagedEnvironmentError(
                        "managed_environment_core_dependency_unavailable",
                        "Local Swarm Core dependency is unavailable.",
                        status=409,
                    ) from exc
                if not core_source_root.is_dir():
                    raise ManagedEnvironmentError(
                        "managed_environment_core_dependency_unavailable",
                        "Local Swarm Core dependency is not a directory.",
                        status=409,
                    )
            elif dependency_kind == "registry":
                dependency_revision = self._optional_text(
                    dependency.get("lockedVersion")
                )
                if dependency_revision is None:
                    raise ManagedEnvironmentError(
                        "managed_environment_core_dependency_invalid",
                        "Registry Swarm Core dependency has no locked version.",
                        status=409,
                    )
            else:
                raise ManagedEnvironmentError(
                    "managed_environment_core_dependency_invalid",
                    "Swarm Core dependency kind is unsupported.",
                    status=409,
                )

        python_version = self._required_text(active.get("pythonVersion"), "pythonVersion")
        uv_version = self._required_text(active.get("uvVersion"), "uvVersion")
        activated_at = self._required_text(active.get("activatedAt"), "activatedAt")
        return RuntimeEnvironmentBinding(
            environment_id=environment_id,
            consumer=consumer,
            fingerprint=fingerprint,
            generation_path=generation,
            python_executable=python,
            python_version=python_version,
            uv_version=uv_version,
            activated_at=activated_at,
            project_slot=str(project["slot"]),
            project_root=project_root,
            project_revision=self._optional_text(source.get("revision")),
            project_dirty=(
                source.get("dirty") if isinstance(source.get("dirty"), bool) else None
            ),
            core_dependency_kind=dependency_kind,
            core_dependency_revision=dependency_revision,
            core_source_root=core_source_root,
        )

    @staticmethod
    def _required_text(value: object, field: str) -> str:
        if not isinstance(value, str) or not value:
            raise ManagedEnvironmentError(
                "managed_environment_active_invalid",
                f"Managed runtime environment {field} is invalid.",
                status=409,
            )
        return value

    @staticmethod
    def _optional_text(value: object) -> str | None:
        return value if isinstance(value, str) and value else None


def runtime_environment_event(
    binding: RuntimeEnvironmentBinding,
    invocation_id: str,
    *,
    timestamp_ms: float,
) -> dict[str, object]:
    """Create one server-owned structural event before the bridge can emit output."""

    identity = binding.evidence()
    return {
        "eventId": f"environment:{binding.consumer}:{invocation_id}",
        "kind": "trace.status",
        "phase": "instant",
        "timestampMs": max(0.0, timestamp_ms),
        "spanId": f"environment:{invocation_id}",
        "title": "Managed runtime environment verified",
        "summary": (
            f"{binding.environment_id} @ {binding.fingerprint[:12]} · "
            f"Python {binding.python_version} · uv {binding.uv_version}"
        ),
        "environment": identity,
    }
