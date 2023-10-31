"""Generated, local-only desired state for isolated Core and Swarm Python environments."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import tomllib
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Any

from .config import LocalServiceConfig
from .repository_connections import RepositoryConnectionStore


MANAGED_ENVIRONMENT_API_VERSION = "1.0.0"
MANAGED_ENVIRONMENT_IDS = ("core-env", "swarm-core-env")
TARGET_PYTHON = "3.11"
PROJECT_FILE_MAX_BYTES = 2 * 1024 * 1024
LOCK_FILE_MAX_BYTES = 32 * 1024 * 1024
SPEC_FILE_MAX_BYTES = 2 * 1024 * 1024
VERSION_SPECIFIER_PATTERN = re.compile(
    r"^\s*(~=|==|!=|<=|>=|<|>)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(\.\*)?\s*$"
)


class ManagedEnvironmentError(RuntimeError):
    """Stable local environment planning error exposed by the loopback API."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.UNPROCESSABLE_ENTITY,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _canonical_fingerprint(value: dict[str, object]) -> str:
    content = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return _sha256(content)


def _version_tuple(parts: tuple[str | None, str | None, str | None]) -> tuple[int, int, int]:
    return tuple(int(part or 0) for part in parts)  # type: ignore[return-value]


def _python_requirement_allows_target(requirement: str, target: str = TARGET_PYTHON) -> bool:
    target_parts = target.split(".")
    target_version = (
        int(target_parts[0]),
        int(target_parts[1]) if len(target_parts) > 1 else 0,
        int(target_parts[2]) if len(target_parts) > 2 else 0,
    )
    specifiers = [item.strip() for item in requirement.split(",") if item.strip()]
    if not specifiers:
        return False
    for specifier in specifiers:
        match = VERSION_SPECIFIER_PATTERN.fullmatch(specifier)
        if match is None:
            return False
        operator = match.group(1)
        compared = _version_tuple((match.group(2), match.group(3), match.group(4)))
        wildcard = bool(match.group(5))
        supplied_parts = 1 + int(match.group(3) is not None) + int(match.group(4) is not None)
        if operator == ">=" and not target_version >= compared:
            return False
        if operator == ">" and not target_version > compared:
            return False
        if operator == "<=" and not target_version <= compared:
            return False
        if operator == "<" and not target_version < compared:
            return False
        if operator in {"==", "!="}:
            matches = target_version[:supplied_parts] == compared[:supplied_parts]
            if wildcard:
                matches = target_version[:supplied_parts] == compared[:supplied_parts]
            if operator == "==" and not matches:
                return False
            if operator == "!=" and matches:
                return False
        if operator == "~=":
            if target_version < compared:
                return False
            upper = (
                (compared[0] + 1, 0, 0)
                if supplied_parts <= 2
                else (compared[0], compared[1] + 1, 0)
            )
            if target_version >= upper:
                return False
    return True


class EnvironmentSpecBuilder:
    """Build reproducible desired specs from active repository connection evidence."""

    def __init__(self, config: LocalServiceConfig) -> None:
        self._config = config

    def build_all(
        self,
        connections: dict[str, object],
    ) -> dict[str, dict[str, object]]:
        slots = connections.get("slots")
        if not isinstance(slots, dict):
            raise ManagedEnvironmentError(
                "repository_connections_unavailable",
                "Repository connection state is unavailable for environment planning.",
            )
        core_connection = slots.get("agentCore")
        swarm_connection = slots.get("jiuwenSwarm")
        if not isinstance(core_connection, dict) or not isinstance(swarm_connection, dict):
            raise ManagedEnvironmentError(
                "repository_connections_unavailable",
                "Core and Swarm repository slots are required for environment planning.",
            )
        return {
            "core-env": self._build_core(core_connection),
            "swarm-core-env": self._build_swarm(swarm_connection),
        }

    def _build_core(self, connection: dict[str, Any]) -> dict[str, object]:
        project = self._project_snapshot(connection)
        resolution = self._project_resolution(connection, project)
        source = self._connection_source(connection)
        payload: dict[str, object] = {
            "apiVersion": MANAGED_ENVIRONMENT_API_VERSION,
            "id": "core-env",
            "label": "Agent Core Environment",
            "consumers": ["agent-core", "subagent"],
            "manager": "uv",
            "python": self._python_contract(project),
            "project": {
                "slot": "agent-core",
                "source": source,
                "metadata": project,
            },
            "coreDependency": None,
            "sync": {
                "strategy": "project-lock",
                "frozen": True,
                "projectRoot": connection.get("path"),
                "python": TARGET_PYTHON,
            },
            "resolution": resolution,
        }
        return self._finalize(payload)

    def _build_swarm(self, connection: dict[str, Any]) -> dict[str, object]:
        project = self._project_snapshot(connection)
        dependency = connection.get("coreDependency")
        resolution = self._project_resolution(connection, project)
        if resolution["status"] == "ready":
            if not isinstance(dependency, dict):
                resolution = self._blocked(
                    "swarm_core_dependency_unavailable",
                    "Swarm Core dependency inspection is unavailable.",
                )
            elif dependency.get("status") != "ready":
                resolution = self._blocked(
                    str(dependency.get("code") or "swarm_core_dependency_unavailable"),
                    str(
                        dependency.get("message")
                        or "Swarm Core dependency is not ready for a locked environment."
                    ),
                )
        dependency_source = (
            dependency.get("source") if isinstance(dependency, dict) else None
        )
        payload: dict[str, object] = {
            "apiVersion": MANAGED_ENVIRONMENT_API_VERSION,
            "id": "swarm-core-env",
            "label": "JiuwenSwarm + Core Environment",
            "consumers": ["jiuwenswarm", "swarmflow"],
            "manager": "uv",
            "python": self._python_contract(project),
            "project": {
                "slot": "jiuwenswarm",
                "source": self._connection_source(connection),
                "metadata": project,
            },
            "coreDependency": dependency_source,
            "sync": {
                "strategy": "project-lock",
                "frozen": True,
                "projectRoot": connection.get("path"),
                "python": TARGET_PYTHON,
            },
            "resolution": resolution,
        }
        return self._finalize(payload)

    def _project_snapshot(self, connection: dict[str, Any]) -> dict[str, object]:
        raw_root = connection.get("path")
        if not isinstance(raw_root, str):
            return self._unavailable_project("repository_path_missing")
        try:
            root = self._config.authorize_directory(raw_root)
            pyproject, pyproject_hash = self._read_project_toml(root)
            project = pyproject.get("project")
            if not isinstance(project, dict):
                return self._unavailable_project("project_metadata_invalid")
            requires_python = project.get("requires-python")
            lock_path = root / "uv.lock"
            lock_hash = self._file_hash(
                root,
                lock_path,
                LOCK_FILE_MAX_BYTES,
                validate_toml=True,
            )
            python_pin = self._python_pin(root)
            return {
                "status": "ready",
                "name": str(project.get("name") or ""),
                "version": str(project.get("version") or ""),
                "requiresPython": (
                    requires_python if isinstance(requires_python, str) else None
                ),
                "pythonVersionFile": python_pin,
                "pyproject": {
                    "path": str(root / "pyproject.toml"),
                    "sha256": pyproject_hash,
                },
                "lockfile": (
                    {"path": str(lock_path), "sha256": lock_hash}
                    if lock_hash is not None
                    else None
                ),
            }
        except ManagedEnvironmentError as exc:
            return self._unavailable_project(exc.code)
        except (OSError, RuntimeError, TypeError, UnicodeError, ValueError):
            return self._unavailable_project("project_metadata_unreadable")

    @staticmethod
    def _unavailable_project(code: str) -> dict[str, object]:
        return {
            "status": "unavailable",
            "code": code,
            "name": "",
            "version": "",
            "requiresPython": None,
            "pythonVersionFile": None,
            "pyproject": None,
            "lockfile": None,
        }

    @staticmethod
    def _connection_source(connection: dict[str, Any]) -> dict[str, object]:
        repository = connection.get("repository")
        github = connection.get("github")
        return {
            "kind": connection.get("mode"),
            "origin": connection.get("origin"),
            "path": connection.get("path"),
            "github": (
                {
                    "url": github.get("url"),
                    "ref": github.get("ref"),
                }
                if isinstance(github, dict)
                else None
            ),
            "revision": (
                repository.get("revision") if isinstance(repository, dict) else None
            ),
            "branch": (
                repository.get("branch") if isinstance(repository, dict) else None
            ),
            "dirty": (
                repository.get("dirty") if isinstance(repository, dict) else None
            ),
        }

    def _project_resolution(
        self,
        connection: dict[str, Any],
        project: dict[str, Any],
    ) -> dict[str, str]:
        if connection.get("configured") is not True:
            validation = connection.get("validation")
            return self._blocked(
                str(
                    validation.get("code")
                    if isinstance(validation, dict)
                    else "repository_unavailable"
                ),
                "The bound repository is not ready for environment planning.",
            )
        if project.get("status") != "ready" or project.get("pyproject") is None:
            return self._blocked(
                str(project.get("code") or "project_metadata_unavailable"),
                "Project metadata is unavailable or invalid.",
            )
        if project.get("lockfile") is None:
            return self._blocked(
                "uv_lock_missing",
                "A checked-in uv.lock is required for deterministic synchronization.",
            )
        requires_python = project.get("requiresPython")
        if not isinstance(requires_python, str):
            return self._blocked(
                "python_requirement_missing",
                "project.requires-python is required for environment planning.",
            )
        if not _python_requirement_allows_target(requires_python):
            return self._blocked(
                "python_311_unsupported",
                "The project Python constraint does not accept managed Python 3.11.",
            )
        return {
            "status": "ready",
            "code": "desired_spec_ready",
            "message": "Repository lock evidence is ready for managed synchronization.",
        }

    @staticmethod
    def _blocked(code: str, message: str) -> dict[str, str]:
        return {"status": "blocked", "code": code, "message": message}

    @staticmethod
    def _python_contract(project: dict[str, Any]) -> dict[str, object]:
        return {
            "implementation": "cpython",
            "requested": TARGET_PYTHON,
            "requiresPython": project.get("requiresPython"),
            "projectPin": project.get("pythonVersionFile"),
            "provisioning": "uv-managed",
        }

    @staticmethod
    def _finalize(payload: dict[str, object]) -> dict[str, object]:
        return {
            **payload,
            "fingerprint": _canonical_fingerprint(payload),
            "generatedAt": _utc_now(),
        }

    @staticmethod
    def _read_project_toml(root: Path) -> tuple[dict[str, Any], str]:
        path = root / "pyproject.toml"
        resolved = path.resolve(strict=True)
        if path.is_symlink() or not resolved.is_relative_to(root) or not resolved.is_file():
            raise ManagedEnvironmentError(
                "unsafe_project_metadata",
                "pyproject.toml must be a regular file inside the repository.",
            )
        content = resolved.read_bytes()
        if len(content) > PROJECT_FILE_MAX_BYTES:
            raise ManagedEnvironmentError(
                "project_metadata_too_large",
                "pyproject.toml exceeds the environment planning limit.",
            )
        return tomllib.loads(content.decode("utf-8")), _sha256(content)

    @staticmethod
    def _file_hash(
        root: Path,
        path: Path,
        max_bytes: int,
        *,
        validate_toml: bool = False,
    ) -> str | None:
        if not path.exists():
            return None
        resolved = path.resolve(strict=True)
        if path.is_symlink() or not resolved.is_relative_to(root) or not resolved.is_file():
            raise ManagedEnvironmentError(
                "unsafe_environment_evidence",
                f"{path.name} must be a regular file inside the repository.",
            )
        if resolved.stat().st_size > max_bytes:
            raise ManagedEnvironmentError(
                "environment_evidence_too_large",
                f"{path.name} exceeds the environment planning limit.",
            )
        content = resolved.read_bytes()
        if validate_toml:
            try:
                tomllib.loads(content.decode("utf-8"))
            except (UnicodeError, ValueError) as exc:
                raise ManagedEnvironmentError(
                    "uv_lock_invalid",
                    "uv.lock is not valid UTF-8 TOML.",
                ) from exc
        return _sha256(content)

    @classmethod
    def _python_pin(cls, root: Path) -> str | None:
        path = root / ".python-version"
        if not path.exists():
            return None
        if cls._file_hash(root, path, 256) is None:
            return None
        value = path.read_text(encoding="utf-8").strip()
        return value[:64] or None


class ManagedEnvironmentRegistry:
    """Persist desired specs atomically without touching either bound source tree."""

    def __init__(
        self,
        config: LocalServiceConfig,
        connections: RepositoryConnectionStore,
        *,
        root: Path | None = None,
    ) -> None:
        self._config = config
        self._connections = connections
        self._builder = EnvironmentSpecBuilder(config)
        self.root = (
            root
            or config.managed_environment_root
            or config.allowed_roots[0] / ".openjiuwen-visualization" / "environments"
        ).resolve(strict=False)
        if not any(self.root.is_relative_to(item) for item in config.allowed_roots):
            raise ManagedEnvironmentError(
                "managed_environment_root_not_allowed",
                "Managed environment root is outside allowed roots.",
                status=HTTPStatus.FORBIDDEN,
            )
        self._lock = threading.RLock()

    def refresh(self) -> dict[str, object]:
        with self._lock:
            desired = self._desired_specs()
            specs_root = self._ensure_specs_root()
            for environment_id in MANAGED_ENVIRONMENT_IDS:
                spec = desired[environment_id]
                path = specs_root / f"{environment_id}.json"
                existing = self._read_spec(path)
                if existing is not None and existing.get("fingerprint") == spec["fingerprint"]:
                    continue
                self._atomic_write(path, spec)
            return self._descriptor(desired)

    def descriptor(self) -> dict[str, object]:
        with self._lock:
            return self._descriptor(self._desired_specs())

    def _desired_specs(self) -> dict[str, dict[str, object]]:
        return self._builder.build_all(self._connections.descriptor())

    def _descriptor(
        self,
        desired: dict[str, dict[str, object]],
    ) -> dict[str, object]:
        return {
            "apiVersion": MANAGED_ENVIRONMENT_API_VERSION,
            "storage": {
                "root": str(self.root),
                "specFormat": "json",
                "localOnly": True,
            },
            "policy": {
                "manager": "uv",
                "python": TARGET_PYTHON,
                "lockAuthority": "uv.lock",
                "autoReconcile": "before-runtime-invocation",
                "upstreamWrites": False,
                "activation": "atomic-generation",
            },
            "environments": {
                "coreEnv": self._environment_descriptor(desired["core-env"]),
                "swarmCoreEnv": self._environment_descriptor(
                    desired["swarm-core-env"]
                ),
            },
        }

    def _environment_descriptor(self, desired: dict[str, object]) -> dict[str, object]:
        environment_id = str(desired["id"])
        spec_path = self.root / "specs" / f"{environment_id}.json"
        generated = self._read_spec(spec_path)
        matches = bool(
            generated is not None
            and generated.get("fingerprint") == desired.get("fingerprint")
        )
        resolution = desired.get("resolution")
        blocked = (
            isinstance(resolution, dict) and resolution.get("status") == "blocked"
        )
        state = "blocked" if blocked else "planned" if matches else "plan-drift"
        state_message = (
            str(resolution.get("message"))
            if blocked and isinstance(resolution, dict)
            else "Generated desired spec matches the active repository bindings."
            if matches
            else "Generated desired spec is missing or stale."
        )
        return {
            "id": environment_id,
            "label": desired.get("label"),
            "consumers": desired.get("consumers"),
            "state": state,
            "message": state_message,
            "desired": desired,
            "generated": (
                {
                    "path": str(spec_path),
                    "fingerprint": generated.get("fingerprint"),
                    "generatedAt": generated.get("generatedAt"),
                    "matchesDesired": matches,
                }
                if generated is not None
                else None
            ),
            "active": None,
            "paths": {
                "spec": str(spec_path),
                "generations": str(self.root / environment_id / "generations"),
                "activeManifest": str(self.root / environment_id / "active.json"),
            },
        }

    def _ensure_specs_root(self) -> Path:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            resolved_root = self.root.resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "managed_environment_storage_unavailable",
                "Managed environment storage directory is unavailable.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            ) from exc
        is_junction = getattr(self.root, "is_junction", None)
        if (
            self.root.is_symlink()
            or bool(is_junction and is_junction())
            or not any(
                resolved_root == allowed or resolved_root.is_relative_to(allowed)
                for allowed in self._config.allowed_roots
            )
        ):
            raise ManagedEnvironmentError(
                "unsafe_managed_environment_root",
                "Managed environment root must be a real directory inside an allowed root.",
                status=HTTPStatus.FORBIDDEN,
            )
        specs_root = resolved_root / "specs"
        try:
            specs_root.mkdir(exist_ok=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "environment_spec_storage_unavailable",
                "Environment spec directory is unavailable.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            ) from exc
        if specs_root.is_symlink() or not specs_root.resolve(strict=True).is_relative_to(
            resolved_root
        ):
            raise ManagedEnvironmentError(
                "unsafe_environment_spec_root",
                "Environment spec directory escaped its managed root.",
                status=HTTPStatus.FORBIDDEN,
            )
        return specs_root.resolve(strict=True)

    @staticmethod
    def _read_spec(path: Path) -> dict[str, Any] | None:
        try:
            if not path.is_file() or path.is_symlink():
                return None
            if path.stat().st_size > SPEC_FILE_MAX_BYTES:
                return None
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            return None
        if not isinstance(value, dict):
            return None
        if (
            value.get("apiVersion") != MANAGED_ENVIRONMENT_API_VERSION
            or value.get("id") not in MANAGED_ENVIRONMENT_IDS
            or not isinstance(value.get("fingerprint"), str)
        ):
            return None
        return value

    @staticmethod
    def _atomic_write(path: Path, value: dict[str, object]) -> None:
        content = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ) + "\n"
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8", newline="\n")
            os.replace(temporary, path)
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise ManagedEnvironmentError(
                "environment_spec_write_failed",
                "Managed environment desired state could not be written atomically.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            ) from exc
