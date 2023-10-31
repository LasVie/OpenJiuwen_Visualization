"""Generated, local-only desired state for isolated Core and Swarm Python environments."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
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
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
GENERATION_ID_LENGTH = 24
GENERATION_ID_PATTERN = re.compile(r"^[0-9a-f]{24}$")


def generation_id(fingerprint: str) -> str:
    if not FINGERPRINT_PATTERN.fullmatch(fingerprint):
        raise ManagedEnvironmentError(
            "invalid_environment_fingerprint",
            "Environment fingerprint must be a lowercase SHA-256 digest.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return fingerprint[:GENERATION_ID_LENGTH]


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
                "extras": [
                    extra
                    for extra in ("observability", "sqlite")
                    if extra in project.get("optionalExtras", [])
                ],
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
                "extras": [],
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
            optional_dependencies = project.get("optional-dependencies", {})
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
                "optionalExtras": (
                    sorted(str(name) for name in optional_dependencies)
                    if isinstance(optional_dependencies, dict)
                    else []
                ),
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
            "optionalExtras": [],
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

    def desired_spec(self, environment_id: str) -> dict[str, object]:
        checked = self._validate_environment_id(environment_id)
        with self._lock:
            self.refresh()
            return self._desired_specs()[checked]

    def active_manifest(self, environment_id: str) -> dict[str, Any] | None:
        checked = self._validate_environment_id(environment_id)
        with self._lock:
            path = self.root / checked / "active.json"
            value = self._read_managed_manifest(path, checked)
            if value is None:
                return None
            generation = Path(str(value.get("generationPath", ""))).resolve(
                strict=False
            )
            expected_root = (self.root / checked / "generations").resolve(
                strict=False
            )
            if (
                not FINGERPRINT_PATTERN.fullmatch(str(value.get("fingerprint", "")))
                or generation.parent != expected_root
                or generation.name != generation_id(str(value.get("fingerprint")))
            ):
                return None
            return value

    def generation_manifest(
        self,
        environment_id: str,
        fingerprint: str,
    ) -> dict[str, Any] | None:
        checked = self._validate_environment_id(environment_id)
        checked_fingerprint = self._validate_fingerprint(fingerprint)
        with self._lock:
            path = (
                self.root
                / checked
                / "generations"
                / generation_id(checked_fingerprint)
                / "generation.json"
            )
            return self._read_managed_manifest(path, checked, checked_fingerprint)

    def create_staging_directory(
        self,
        environment_id: str,
        fingerprint: str,
    ) -> Path:
        checked = self._validate_environment_id(environment_id)
        checked_fingerprint = self._validate_fingerprint(fingerprint)
        with self._lock:
            generations = self._ensure_generations_root(checked)
            staging = generations / f".s-{uuid.uuid4().hex[:8]}"
            try:
                staging.mkdir()
                resolved = staging.resolve(strict=True)
            except OSError as exc:
                raise ManagedEnvironmentError(
                    "environment_staging_failed",
                    "A managed environment staging directory could not be created.",
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                ) from exc
            if resolved.parent != generations or resolved.is_symlink():
                self._remove_tree(resolved, generations)
                raise ManagedEnvironmentError(
                    "unsafe_environment_staging_path",
                    "Managed environment staging escaped its generation root.",
                    status=HTTPStatus.FORBIDDEN,
                )
            return resolved

    def promote_generation(
        self,
        environment_id: str,
        fingerprint: str,
        staging: Path,
        manifest: dict[str, object],
    ) -> Path:
        checked = self._validate_environment_id(environment_id)
        checked_fingerprint = self._validate_fingerprint(fingerprint)
        with self._lock:
            generations = self._ensure_generations_root(checked)
            resolved_staging = staging.resolve(strict=True)
            if (
                resolved_staging.parent != generations
                or not resolved_staging.name.startswith(".s-")
                or resolved_staging.is_symlink()
            ):
                raise ManagedEnvironmentError(
                    "unsafe_environment_staging_path",
                    "Only the expected managed staging directory can be promoted.",
                    status=HTTPStatus.FORBIDDEN,
                )
            self._atomic_write(
                resolved_staging / "generation.json",
                manifest,
            )
            identifier = generation_id(checked_fingerprint)
            target = generations / identifier
            backup: Path | None = None
            if target.exists():
                resolved_target = target.resolve(strict=True)
                is_junction = getattr(resolved_target, "is_junction", None)
                if (
                    resolved_target.parent != generations
                    or resolved_target.is_symlink()
                    or bool(is_junction and is_junction())
                ):
                    raise ManagedEnvironmentError(
                        "unsafe_environment_generation",
                        "Existing environment generation is not a safe managed directory.",
                        status=HTTPStatus.FORBIDDEN,
                    )
                backup = generations / f".b-{uuid.uuid4().hex[:8]}"
                try:
                    os.replace(resolved_target, backup)
                except OSError as exc:
                    raise ManagedEnvironmentError(
                        "environment_generation_backup_failed",
                        "The stale environment generation could not be isolated safely.",
                        status=HTTPStatus.INTERNAL_SERVER_ERROR,
                    ) from exc
            try:
                os.replace(resolved_staging, target)
            except OSError as exc:
                if backup is not None and backup.exists() and not target.exists():
                    try:
                        os.replace(backup, target)
                    except OSError:
                        pass
                raise ManagedEnvironmentError(
                    "environment_generation_promotion_failed",
                    "The verified environment generation could not be promoted atomically.",
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                ) from exc
            if backup is not None and backup.exists():
                try:
                    self._remove_tree(backup, generations)
                except ManagedEnvironmentError:
                    pass
            return target.resolve(strict=True)

    def activate_generation(
        self,
        environment_id: str,
        manifest: dict[str, object],
    ) -> dict[str, object]:
        checked = self._validate_environment_id(environment_id)
        fingerprint = self._validate_fingerprint(str(manifest.get("fingerprint", "")))
        with self._lock:
            generation = (
                self.root / checked / "generations" / generation_id(fingerprint)
            ).resolve(strict=True)
            if generation.parent != self._ensure_generations_root(checked):
                raise ManagedEnvironmentError(
                    "unsafe_environment_generation",
                    "Environment generation is outside its managed root.",
                    status=HTTPStatus.FORBIDDEN,
                )
            active = {
                **manifest,
                "environmentId": checked,
                "generationPath": str(generation),
                "activatedAt": _utc_now(),
            }
            self._atomic_write(self.root / checked / "active.json", active)
            return active

    def discard_tree(self, environment_id: str, path: Path) -> None:
        checked = self._validate_environment_id(environment_id)
        with self._lock:
            generations = self._ensure_generations_root(checked)
            self._remove_tree(path, generations)

    def cleanup_generations(
        self,
        environment_id: str,
        *,
        retain: int = 2,
    ) -> list[str]:
        checked = self._validate_environment_id(environment_id)
        keep_count = max(1, min(retain, 10))
        with self._lock:
            generations = self._ensure_generations_root(checked)
            active = self.active_manifest(checked)
            active_fingerprint = (
                str(active.get("fingerprint")) if active is not None else None
            )
            candidates: list[tuple[str, str, Path]] = []
            for path in generations.iterdir():
                if not path.is_dir() or path.is_symlink() or path.name.startswith("."):
                    continue
                if not GENERATION_ID_PATTERN.fullmatch(path.name):
                    continue
                manifest = self._read_managed_manifest(
                    path / "generation.json",
                    checked,
                    None,
                )
                if (
                    manifest is None
                    or generation_id(str(manifest.get("fingerprint", "")))
                    != path.name
                ):
                    continue
                candidates.append(
                    (
                        str(manifest.get("createdAt") or ""),
                        str(manifest.get("fingerprint")),
                        path,
                    )
                )
            retained = {active_fingerprint} if active_fingerprint else set()
            for _created, fingerprint, _path in sorted(candidates, reverse=True):
                if len(retained) >= keep_count:
                    break
                retained.add(fingerprint)
            removed: list[str] = []
            for _created, fingerprint, path in candidates:
                if fingerprint in retained:
                    continue
                self._remove_tree(path, generations)
                removed.append(fingerprint)
            return removed

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
        active = self.active_manifest(environment_id)
        active_matches = bool(
            active is not None
            and active.get("fingerprint") == desired.get("fingerprint")
        )
        state = (
            "blocked"
            if blocked
            else "ready"
            if matches and active_matches
            else "drifted"
            if active is not None
            else "planned"
            if matches
            else "plan-drift"
        )
        state_message = (
            str(resolution.get("message"))
            if blocked and isinstance(resolution, dict)
            else "The verified active generation matches current repository and lock evidence."
            if state == "ready"
            else "The active generation does not match current repository or lock evidence."
            if state == "drifted"
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
            "active": active,
            "paths": {
                "spec": str(spec_path),
                "generations": str(self.root / environment_id / "generations"),
                "activeManifest": str(self.root / environment_id / "active.json"),
            },
        }

    def _ensure_specs_root(self) -> Path:
        resolved_root = self._ensure_managed_root()
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

    def _ensure_managed_root(self) -> Path:
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
        return resolved_root

    def _ensure_generations_root(self, environment_id: str) -> Path:
        managed_root = self._ensure_managed_root()
        environment_root = managed_root / environment_id
        generations = environment_root / "generations"
        try:
            generations.mkdir(parents=True, exist_ok=True)
            resolved = generations.resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "environment_generation_storage_unavailable",
                "Environment generation storage is unavailable.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            ) from exc
        if (
            environment_root.is_symlink()
            or generations.is_symlink()
            or resolved.parent != environment_root.resolve(strict=True)
            or resolved.parent.parent != managed_root
        ):
            raise ManagedEnvironmentError(
                "unsafe_environment_generation_root",
                "Environment generation directory escaped its managed root.",
                status=HTTPStatus.FORBIDDEN,
            )
        return resolved

    @staticmethod
    def _validate_environment_id(environment_id: str) -> str:
        if environment_id not in MANAGED_ENVIRONMENT_IDS:
            raise ManagedEnvironmentError(
                "invalid_environment_id",
                "Environment id must be core-env or swarm-core-env.",
                status=HTTPStatus.BAD_REQUEST,
            )
        return environment_id

    @staticmethod
    def _validate_fingerprint(fingerprint: str) -> str:
        if not FINGERPRINT_PATTERN.fullmatch(fingerprint):
            raise ManagedEnvironmentError(
                "invalid_environment_fingerprint",
                "Environment fingerprint must be a lowercase SHA-256 digest.",
                status=HTTPStatus.BAD_REQUEST,
            )
        return fingerprint

    @classmethod
    def _read_managed_manifest(
        cls,
        path: Path,
        environment_id: str,
        fingerprint: str | None = None,
    ) -> dict[str, Any] | None:
        value = cls._read_spec(path)
        if value is None or value.get("environmentId") != environment_id:
            return None
        if fingerprint is not None and value.get("fingerprint") != fingerprint:
            return None
        return value

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
        temporary = path.parent / f".tmp-{uuid.uuid4().hex[:8]}"
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

    @staticmethod
    def _remove_tree(path: Path, generations_root: Path) -> None:
        resolved = path.resolve(strict=True)
        expected_root = generations_root.resolve(strict=True)
        is_junction = getattr(resolved, "is_junction", None)
        if (
            resolved.parent != expected_root
            or resolved == expected_root
            or resolved.is_symlink()
            or bool(is_junction and is_junction())
        ):
            raise ManagedEnvironmentError(
                "unsafe_environment_cleanup_target",
                "Only a direct managed generation can be removed.",
                status=HTTPStatus.FORBIDDEN,
            )

        def remove_readonly(function: object, raw_path: str, _error: object) -> None:
            try:
                os.chmod(raw_path, stat.S_IWRITE)
                function(raw_path)  # type: ignore[operator]
            except OSError:
                return

        raw_path = str(resolved)
        if os.name == "nt" and not raw_path.startswith("\\\\?\\"):
            raw_path = "\\\\?\\" + raw_path
        try:
            shutil.rmtree(raw_path, onerror=remove_readonly)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "environment_cleanup_failed",
                "A stale managed environment generation could not be removed.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            ) from exc
