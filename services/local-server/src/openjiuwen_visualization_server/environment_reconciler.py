"""Verified uv reconciliation for isolated managed environment generations."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from .managed_environments import (
    MANAGED_ENVIRONMENT_API_VERSION,
    ManagedEnvironmentError,
    ManagedEnvironmentRegistry,
    _utc_now,
    generation_id,
)


UV_VERSION_PATTERN = re.compile(r"^uv\s+([0-9]+(?:\.[0-9]+){1,3})\b")
PYTHON_VERSION_PATTERN = re.compile(r"^3\.11(?:\.\d+)?$")
COMMAND_CAPTURE_LIMIT = 8_192
PYTHON_INSTALL_TIMEOUT_SECONDS = 10 * 60
SYNC_TIMEOUT_SECONDS = 30 * 60
CHECK_TIMEOUT_SECONDS = 5 * 60
PROBE_TIMEOUT_SECONDS = 2 * 60


@dataclass(frozen=True, slots=True)
class EnvironmentCommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class EnvironmentCommandTimeout(TimeoutError):
    """Raised internally when a managed subprocess exceeds its fixed deadline."""


class EnvironmentCommandRunner:
    """Run fixed argv without a shell and without leaking child output by default."""

    def run(
        self,
        arguments: Sequence[str],
        *,
        cwd: Path | None,
        environment: Mapping[str, str],
        timeout_seconds: float,
        capture: bool = False,
    ) -> EnvironmentCommandResult:
        try:
            completed = subprocess.run(
                list(arguments),
                cwd=str(cwd) if cwd is not None else None,
                env=dict(environment),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                shell=False,
                timeout=timeout_seconds,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except subprocess.TimeoutExpired as exc:
            raise EnvironmentCommandTimeout from exc
        except (OSError, subprocess.SubprocessError) as exc:
            raise ManagedEnvironmentError(
                "environment_command_unavailable",
                "A managed environment command could not be started.",
                status=503,
            ) from exc
        return EnvironmentCommandResult(
            completed.returncode,
            (completed.stdout or "")[-COMMAND_CAPTURE_LIMIT:],
            (completed.stderr or "")[-COMMAND_CAPTURE_LIMIT:],
        )


def environment_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


class ManagedEnvironmentReconciler:
    """Build, verify, and atomically activate one desired environment generation."""

    def __init__(
        self,
        registry: ManagedEnvironmentRegistry,
        *,
        runner: EnvironmentCommandRunner | None = None,
        uv_executable: Path | None = None,
        probe_scripts: dict[str, tuple[Path, ...]] | None = None,
        retained_generations: int = 2,
    ) -> None:
        self.registry = registry
        self._runner = runner or EnvironmentCommandRunner()
        self._configured_uv = uv_executable.resolve(strict=False) if uv_executable else None
        scripts_root = Path(__file__).resolve().parents[2] / "scripts"
        self._probe_scripts = probe_scripts or {
            "core-env": (
                scripts_root / "agent_core_bridge.py",
                scripts_root / "subagent_bridge.py",
            ),
            "swarm-core-env": (
                scripts_root / "jiuwenswarm_bridge.py",
                scripts_root / "swarmflow_bridge.py",
            ),
        }
        self._retained_generations = max(1, min(retained_generations, 10))
        self._locks = {
            "core-env": threading.Lock(),
            "swarm-core-env": threading.Lock(),
        }

    def reconcile(self, environment_id: str) -> dict[str, object]:
        if environment_id not in self._locks:
            raise ManagedEnvironmentError(
                "invalid_environment_id",
                "Environment id must be core-env or swarm-core-env.",
                status=400,
            )
        if not self._locks[environment_id].acquire(blocking=False):
            raise ManagedEnvironmentError(
                "environment_reconcile_busy",
                "This managed environment is already being reconciled.",
                status=409,
            )
        try:
            return self._reconcile_locked(environment_id)
        finally:
            self._locks[environment_id].release()

    def _reconcile_locked(self, environment_id: str) -> dict[str, object]:
        desired = self.registry.desired_spec(environment_id)
        resolution = desired.get("resolution")
        if not isinstance(resolution, dict) or resolution.get("status") != "ready":
            raise ManagedEnvironmentError(
                str(
                    resolution.get("code")
                    if isinstance(resolution, dict)
                    else "environment_spec_blocked"
                ),
                str(
                    resolution.get("message")
                    if isinstance(resolution, dict)
                    else "Managed environment desired state is blocked."
                ),
                status=409,
            )
        fingerprint = str(desired.get("fingerprint") or "")
        project_root = self._project_root(desired)
        uv = self._uv_executable()
        base_environment = self._command_environment()
        uv_version = self._uv_version(uv, base_environment)
        managed_python = self._ensure_managed_python(uv, base_environment)
        existing = self.registry.generation_manifest(environment_id, fingerprint)
        if existing is not None and self._validate_generation(
            environment_id,
            desired,
            existing,
            uv,
            project_root,
            base_environment,
        ):
            active = self.registry.activate_generation(environment_id, existing)
            removed = self.registry.cleanup_generations(
                environment_id,
                retain=self._retained_generations,
            )
            return self._result("reused", active, removed)

        staging = self.registry.create_staging_directory(environment_id, fingerprint)
        venv = staging / "venv"
        try:
            sync_environment = self._generation_environment(
                base_environment,
                venv,
                desired,
            )
            self._run_checked(
                [
                    str(uv),
                    "sync",
                    "--frozen",
                    "--no-default-groups",
                    *self._sync_selection_arguments(desired),
                    "--managed-python",
                    "--python",
                    str(managed_python),
                    "--link-mode",
                    "copy",
                    "--no-progress",
                    "--color",
                    "never",
                    "--project",
                    str(project_root),
                ],
                cwd=project_root,
                environment=sync_environment,
                timeout_seconds=SYNC_TIMEOUT_SECONDS,
                failure_code="environment_sync_failed",
                failure_message="uv could not synchronize the locked project environment.",
            )
            python_executable, python_version = self._validate_new_generation(
                environment_id,
                desired,
                uv,
                project_root,
                venv,
                sync_environment,
            )
            target = (
                self.registry.root
                / environment_id
                / "generations"
                / generation_id(fingerprint)
            ).resolve(strict=False)
            manifest: dict[str, object] = {
                "apiVersion": MANAGED_ENVIRONMENT_API_VERSION,
                "id": environment_id,
                "environmentId": environment_id,
                "fingerprint": fingerprint,
                "createdAt": _utc_now(),
                "generationPath": str(target),
                "venvPath": str(target / "venv"),
                "pythonExecutable": str(
                    environment_python(target / "venv").resolve(strict=False)
                ),
                "pythonVersion": python_version,
                "uvVersion": uv_version,
                "project": self._manifest_project(desired),
                "coreDependency": desired.get("coreDependency"),
                "validation": {
                    "status": "passed",
                    "checks": [
                        "python-3.11",
                        "uv-sync-check",
                        "dependency-check",
                        "runtime-probes",
                    ],
                },
            }
            promoted = self.registry.promote_generation(
                environment_id,
                fingerprint,
                staging,
                manifest,
            )
            if promoted != target or not python_executable.is_relative_to(staging):
                raise ManagedEnvironmentError(
                    "environment_generation_identity_mismatch",
                    "Promoted environment generation did not match its verified staging identity.",
                    status=500,
                )
            active = self.registry.activate_generation(environment_id, manifest)
            removed = self.registry.cleanup_generations(
                environment_id,
                retain=self._retained_generations,
            )
            return self._result("activated", active, removed)
        except Exception:
            if staging.exists():
                self.registry.discard_tree(environment_id, staging)
            raise

    @staticmethod
    def _project_root(desired: dict[str, object]) -> Path:
        sync = desired.get("sync")
        raw_root = sync.get("projectRoot") if isinstance(sync, dict) else None
        if not isinstance(raw_root, str):
            raise ManagedEnvironmentError(
                "environment_project_root_missing",
                "Managed environment spec has no project root.",
                status=409,
            )
        try:
            root = Path(raw_root).resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "environment_project_unavailable",
                "Managed environment project root is unavailable.",
                status=409,
            ) from exc
        if not root.is_dir():
            raise ManagedEnvironmentError(
                "environment_project_unavailable",
                "Managed environment project root is unavailable.",
                status=409,
            )
        return root

    def _uv_executable(self) -> Path:
        raw = str(self._configured_uv) if self._configured_uv else shutil.which("uv")
        if not raw:
            raise ManagedEnvironmentError(
                "uv_unavailable",
                "uv is required to reconcile managed Python environments.",
                status=503,
            )
        path = Path(raw).resolve(strict=False)
        if not path.is_file():
            raise ManagedEnvironmentError(
                "uv_unavailable",
                "uv is required to reconcile managed Python environments.",
                status=503,
            )
        return path

    def _uv_version(self, uv: Path, environment: Mapping[str, str]) -> str:
        result = self._run_checked(
            [str(uv), "--version"],
            cwd=None,
            environment=environment,
            timeout_seconds=30,
            failure_code="uv_version_unavailable",
            failure_message="uv version could not be verified.",
            capture=True,
        )
        match = UV_VERSION_PATTERN.match(result.stdout.strip())
        if match is None:
            raise ManagedEnvironmentError(
                "uv_version_invalid",
                "uv returned an unsupported version response.",
                status=503,
            )
        return match.group(1)

    def _ensure_managed_python(
        self,
        uv: Path,
        environment: dict[str, str],
    ) -> Path:
        python_root = self._managed_child_directory("python")
        cache_root = self._managed_child_directory("cache")
        managed = {
            **environment,
            "UV_PYTHON_INSTALL_DIR": str(python_root),
            "UV_CACHE_DIR": str(cache_root),
        }
        found = self._runner.run(
            [
                str(uv),
                "python",
                "find",
                "3.11",
                "--managed-python",
                "--no-project",
                "--no-python-downloads",
            ],
            cwd=None,
            environment=managed,
            timeout_seconds=60,
            capture=True,
        )
        if found.returncode != 0:
            install_arguments = [
                str(uv),
                "python",
                "install",
                "3.11",
                "--install-dir",
                str(python_root),
                "--no-bin",
                "--no-registry",
                "--no-progress",
                "--color",
                "never",
            ]
            try:
                installed = self._runner.run(
                    install_arguments,
                    cwd=None,
                    environment=managed,
                    timeout_seconds=PYTHON_INSTALL_TIMEOUT_SECONDS,
                    capture=True,
                )
            except EnvironmentCommandTimeout as exc:
                raise ManagedEnvironmentError(
                    "python_311_install_timeout",
                    "Managed CPython 3.11 provisioning exceeded its fixed deadline.",
                    status=504,
                ) from exc
            if installed.returncode != 0:
                evidence = f"{installed.stdout}\n{installed.stderr}".casefold()
                if "certificate not valid yet" in evidence:
                    raise ManagedEnvironmentError(
                        "system_clock_invalid",
                        "The system clock prevents verified TLS downloads. Correct Windows date and time, then retry.",
                        status=409,
                    )
                raise ManagedEnvironmentError(
                    "python_311_install_failed",
                    "uv could not provision managed CPython 3.11.",
                    status=422,
                )
            found = self._run_checked(
                [
                    str(uv),
                    "python",
                    "find",
                    "3.11",
                    "--managed-python",
                    "--no-project",
                    "--no-python-downloads",
                ],
                cwd=None,
                environment=managed,
                timeout_seconds=60,
                failure_code="python_311_unavailable",
                failure_message="Managed CPython 3.11 could not be located after installation.",
                capture=True,
            )
        raw_path = found.stdout.strip().splitlines()[-1] if found.stdout.strip() else ""
        try:
            python = Path(raw_path).resolve(strict=True)
            resolved_root = python_root.resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "python_311_path_invalid",
                "uv returned an invalid managed Python path.",
                status=503,
            ) from exc
        if not python.is_file() or not python.is_relative_to(resolved_root):
            raise ManagedEnvironmentError(
                "python_311_path_invalid",
                "Managed CPython 3.11 must stay inside the environment storage root.",
                status=503,
            )
        environment.update(managed)
        return python

    def _validate_new_generation(
        self,
        environment_id: str,
        desired: dict[str, object],
        uv: Path,
        project_root: Path,
        venv: Path,
        environment: dict[str, str],
    ) -> tuple[Path, str]:
        python = environment_python(venv).resolve(strict=False)
        if not python.is_file() or not python.is_relative_to(venv.resolve(strict=True)):
            raise ManagedEnvironmentError(
                "environment_python_missing",
                "uv synchronization did not create the expected virtual environment Python.",
            )
        python_version = self._python_version(python, environment)
        self._validate_synced_environment(
            environment_id,
            desired,
            uv,
            project_root,
            venv,
            python,
            environment,
        )
        return python, python_version

    def _validate_generation(
        self,
        environment_id: str,
        desired: dict[str, object],
        manifest: dict[str, object],
        uv: Path,
        project_root: Path,
        base_environment: dict[str, str],
    ) -> bool:
        try:
            generation = Path(str(manifest.get("generationPath", ""))).resolve(
                strict=True
            )
            expected = (
                self.registry.root
                / environment_id
                / "generations"
                / generation_id(str(desired.get("fingerprint")))
            ).resolve(strict=True)
            venv = Path(str(manifest.get("venvPath", ""))).resolve(strict=True)
            python = Path(str(manifest.get("pythonExecutable", ""))).resolve(
                strict=True
            )
            if (
                generation != expected
                or venv != generation / "venv"
                or python != environment_python(venv).resolve(strict=True)
                or not python.is_file()
            ):
                return False
            environment = self._generation_environment(
                base_environment,
                venv,
                desired,
            )
            self._python_version(python, environment)
            self._validate_synced_environment(
                environment_id,
                desired,
                uv,
                project_root,
                venv,
                python,
                environment,
            )
            return True
        except (ManagedEnvironmentError, OSError, RuntimeError, ValueError):
            return False

    def _validate_synced_environment(
        self,
        environment_id: str,
        desired: dict[str, object],
        uv: Path,
        project_root: Path,
        venv: Path,
        python: Path,
        environment: dict[str, str],
    ) -> None:
        self._run_checked(
            [
                str(uv),
                "sync",
                "--check",
                "--frozen",
                "--no-default-groups",
                *self._sync_selection_arguments(desired),
                "--no-progress",
                "--color",
                "never",
                "--project",
                str(project_root),
            ],
            cwd=project_root,
            environment=environment,
            timeout_seconds=CHECK_TIMEOUT_SECONDS,
            failure_code="environment_sync_check_failed",
            failure_message="The managed environment does not exactly match the project lock.",
        )
        self._run_checked(
            [
                str(uv),
                "pip",
                "check",
                "--python",
                str(python),
                "--no-progress",
                "--color",
                "never",
            ],
            cwd=project_root,
            environment=environment,
            timeout_seconds=CHECK_TIMEOUT_SECONDS,
            failure_code="environment_dependency_check_failed",
            failure_message="Installed packages contain incompatible dependencies.",
        )
        for script in self._probe_scripts[environment_id]:
            if not script.is_file():
                raise ManagedEnvironmentError(
                    "environment_probe_missing",
                    "A required local runtime probe is unavailable.",
                    status=500,
                )
            self._run_checked(
                [str(python), "-B", str(script), "--probe"],
                cwd=project_root,
                environment=environment,
                timeout_seconds=PROBE_TIMEOUT_SECONDS,
                failure_code="environment_runtime_probe_failed",
                failure_message="A runtime consumer could not import the synchronized environment.",
            )

    def _python_version(self, python: Path, environment: Mapping[str, str]) -> str:
        code = (
            "import json,sys;"
            "print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3]))}))"
        )
        result = self._run_checked(
            [str(python), "-I", "-B", "-c", code],
            cwd=None,
            environment=environment,
            timeout_seconds=60,
            failure_code="environment_python_check_failed",
            failure_message="Managed environment Python could not be verified.",
            capture=True,
        )
        try:
            payload = json.loads(result.stdout.strip())
            version = payload.get("version") if isinstance(payload, dict) else None
        except ValueError as exc:
            raise ManagedEnvironmentError(
                "environment_python_version_invalid",
                "Managed environment Python returned invalid version evidence.",
            ) from exc
        if not isinstance(version, str) or not PYTHON_VERSION_PATTERN.fullmatch(version):
            raise ManagedEnvironmentError(
                "environment_python_version_invalid",
                "Managed environment must use CPython 3.11.",
            )
        return version

    def _command_environment(self) -> dict[str, str]:
        allowed = {
            "ALL_PROXY",
            "APPDATA",
            "COMSPEC",
            "CURL_CA_BUNDLE",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "LANG",
            "LOCALAPPDATA",
            "NO_PROXY",
            "PATH",
            "PATHEXT",
            "PROGRAMDATA",
            "REQUESTS_CA_BUNDLE",
            "SSL_CERT_DIR",
            "SSL_CERT_FILE",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
            "all_proxy",
            "https_proxy",
            "http_proxy",
            "no_proxy",
        }
        allowed_folded = {key.casefold() for key in allowed}
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.casefold() in allowed_folded and isinstance(value, str)
        }
        environment.update(
            {
                "GIT_TERMINAL_PROMPT": "0",
                "GCM_INTERACTIVE": "Never",
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "credential.helper",
                "GIT_CONFIG_VALUE_0": "",
                "UV_KEYRING_PROVIDER": "disabled",
                "UV_NO_PROGRESS": "1",
                "UV_LINK_MODE": "copy",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
            }
        )
        return environment

    def _managed_child_directory(self, name: str) -> Path:
        root = self.registry.root.resolve(strict=True)
        path = root / name
        try:
            path.mkdir(exist_ok=True)
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise ManagedEnvironmentError(
                "environment_runtime_storage_unavailable",
                "Managed environment runtime storage is unavailable.",
                status=500,
            ) from exc
        is_junction = getattr(path, "is_junction", None)
        if (
            resolved.parent != root
            or path.is_symlink()
            or bool(is_junction and is_junction())
        ):
            raise ManagedEnvironmentError(
                "unsafe_environment_runtime_storage",
                "Managed environment runtime storage escaped its allowed root.",
                status=403,
            )
        return resolved

    def _generation_environment(
        self,
        base: Mapping[str, str],
        venv: Path,
        desired: dict[str, object],
    ) -> dict[str, str]:
        environment = dict(base)
        environment["UV_PROJECT_ENVIRONMENT"] = str(venv)
        roots = [self._project_root(desired)]
        dependency = desired.get("coreDependency")
        if isinstance(dependency, dict) and dependency.get("kind") == "path":
            path = dependency.get("path")
            if isinstance(path, str):
                roots.append(Path(path).resolve(strict=True))
        environment["PYTHONPATH"] = os.pathsep.join(str(root) for root in roots)
        environment["OPENJIUWEN_VISUALIZATION_BRIDGE"] = "1"
        return environment

    @staticmethod
    def _manifest_project(desired: dict[str, object]) -> dict[str, object]:
        project = desired.get("project")
        source = project.get("source") if isinstance(project, dict) else None
        metadata = project.get("metadata") if isinstance(project, dict) else None
        lockfile = metadata.get("lockfile") if isinstance(metadata, dict) else None
        return {
            "slot": project.get("slot") if isinstance(project, dict) else None,
            "path": source.get("path") if isinstance(source, dict) else None,
            "revision": source.get("revision") if isinstance(source, dict) else None,
            "dirty": source.get("dirty") if isinstance(source, dict) else None,
            "lockSha256": (
                lockfile.get("sha256") if isinstance(lockfile, dict) else None
            ),
        }

    @staticmethod
    def _sync_selection_arguments(desired: dict[str, object]) -> list[str]:
        sync = desired.get("sync")
        extras = sync.get("extras") if isinstance(sync, dict) else None
        if not isinstance(extras, list):
            return []
        arguments: list[str] = []
        for extra in extras:
            if isinstance(extra, str) and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", extra):
                arguments.extend(["--extra", extra])
        return arguments

    @staticmethod
    def _result(
        outcome: str,
        active: dict[str, object],
        removed: list[str],
    ) -> dict[str, object]:
        return {
            "apiVersion": MANAGED_ENVIRONMENT_API_VERSION,
            "environmentId": active.get("environmentId"),
            "outcome": outcome,
            "fingerprint": active.get("fingerprint"),
            "pythonVersion": active.get("pythonVersion"),
            "activatedAt": active.get("activatedAt"),
            "removedGenerations": removed,
        }

    def _run_checked(
        self,
        arguments: Sequence[str],
        *,
        cwd: Path | None,
        environment: Mapping[str, str],
        timeout_seconds: float,
        failure_code: str,
        failure_message: str,
        capture: bool = False,
    ) -> EnvironmentCommandResult:
        try:
            result = self._runner.run(
                arguments,
                cwd=cwd,
                environment=environment,
                timeout_seconds=timeout_seconds,
                capture=capture,
            )
        except EnvironmentCommandTimeout as exc:
            raise ManagedEnvironmentError(
                "environment_reconcile_timeout",
                "Managed environment reconciliation exceeded its fixed timeout.",
                status=504,
            ) from exc
        if result.returncode != 0:
            raise ManagedEnvironmentError(
                failure_code,
                failure_message,
            )
        return result
