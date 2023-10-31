from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.environment_reconciler import (
    EnvironmentCommandResult,
    ManagedEnvironmentReconciler,
    environment_python,
)
from openjiuwen_visualization_server.managed_environments import (
    ManagedEnvironmentError,
    ManagedEnvironmentRegistry,
)
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.repository_connections import (
    RepositoryConnectionStore,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
LOCKED_CORE_REVISION = "ce21a9b7cfcce28923fba6c47758d60c624b69be"


def create_repository(root: Path, marker: Path, pyproject: str, lock: str) -> Path:
    root.mkdir(parents=True)
    target = root / marker
    target.parent.mkdir(parents=True)
    target.write_text("# marker\n", encoding="utf-8")
    (root / ".python-version").write_text("3.11\n", encoding="utf-8")
    (root / "pyproject.toml").write_text(pyproject.strip() + "\n", encoding="utf-8")
    (root / "uv.lock").write_text(lock.strip() + "\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Reconcile Test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "fixture"],
        check=True,
    )
    return root


class FakeEnvironmentRunner:
    def __init__(self, managed_python: Path) -> None:
        self.managed_python = managed_python
        self.calls: list[dict[str, object]] = []
        self.fail_build_sync = False
        self.fail_next_sync_check = 0
        self.find_requires_install = False
        self.installed = managed_python.is_file()
        self.install_error = ""

    def run(
        self,
        arguments: list[str] | tuple[str, ...],
        *,
        cwd: Path | None,
        environment: dict[str, str],
        timeout_seconds: float,
        capture: bool = False,
    ) -> EnvironmentCommandResult:
        argv = list(arguments)
        self.calls.append(
            {
                "arguments": argv,
                "cwd": cwd,
                "environment": dict(environment),
                "timeout": timeout_seconds,
                "capture": capture,
            }
        )
        if len(argv) > 1 and argv[1] == "--version":
            return EnvironmentCommandResult(0, "uv 0.10.6\n")
        if argv[1:3] == ["python", "find"]:
            if self.find_requires_install and not self.installed:
                return EnvironmentCommandResult(1)
            return EnvironmentCommandResult(0, str(self.managed_python) + "\n")
        if argv[1:3] == ["python", "install"]:
            if self.install_error:
                return EnvironmentCommandResult(1, stderr=self.install_error)
            self.managed_python.parent.mkdir(parents=True, exist_ok=True)
            self.managed_python.write_text("managed python", encoding="utf-8")
            self.installed = True
            return EnvironmentCommandResult(0)
        if len(argv) > 1 and argv[1] == "sync" and "--check" not in argv:
            if self.fail_build_sync:
                return EnvironmentCommandResult(1)
            venv = Path(environment["UV_PROJECT_ENVIRONMENT"])
            python = environment_python(venv)
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("venv python", encoding="utf-8")
            return EnvironmentCommandResult(0)
        if len(argv) > 1 and argv[1] == "sync" and "--check" in argv:
            if self.fail_next_sync_check:
                self.fail_next_sync_check -= 1
                return EnvironmentCommandResult(1)
            return EnvironmentCommandResult(0)
        if "-c" in argv:
            return EnvironmentCommandResult(0, json.dumps({"version": "3.11.9"}))
        return EnvironmentCommandResult(0)


class ManagedEnvironmentReconcilerTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="environment-reconcile-",
            dir=runtime_temp,
        )
        self.root = Path(self.temporary.name)
        self.core = create_repository(
            self.root / "agent-core",
            Path("openjiuwen/harness/deep_agent.py"),
            """
[project]
name = "openjiuwen"
version = "0.1.0"
requires-python = ">=3.11,<3.14"
dependencies = []
""",
            "version = 1",
        )
        self.swarm = create_repository(
            self.root / "jiuwenswarm",
            Path("jiuwenswarm/agents/swarm/assembly.py"),
            """
[project]
name = "workswarm"
version = "0.1.0"
requires-python = ">=3.11,<3.14"
dependencies = [
  "openjiuwen @ git+https://gitcode.com/openJiuwen/agent-core.git@develop",
]

[tool.uv.sources]
openjiuwen = { git = "https://gitcode.com/openJiuwen/agent-core.git", branch = "develop" }
""",
            f"""
version = 1

[[package]]
name = "openjiuwen"
version = "0.1.16"
source = {{ git = "https://gitcode.com/openJiuwen/agent-core.git?branch=develop#{LOCKED_CORE_REVISION}" }}
""",
        )
        self.environment_root = self.root / "managed-environments"
        self.config = LocalServiceConfig.create(
            allowed_roots=[self.root],
            connection_settings_path=self.root / "state" / "connections.sqlite3",
            managed_source_root=self.root / "sources",
            managed_environment_root=self.environment_root,
        )
        resolver = RepositoryResolver(self.config)
        self.connections = RepositoryConnectionStore(
            self.config,
            resolver,
            default_paths={"agent-core": self.core, "jiuwenswarm": self.swarm},
        )
        self.registry = ManagedEnvironmentRegistry(self.config, self.connections)
        self.registry.refresh()
        self.fake_uv = self.root / "bin" / "uv.exe"
        self.fake_uv.parent.mkdir(parents=True)
        self.fake_uv.write_text("uv", encoding="utf-8")
        self.managed_python = (
            self.environment_root
            / "python"
            / "cpython-3.11"
            / ("python.exe" if os.name == "nt" else "bin/python")
        )
        self.managed_python.parent.mkdir(parents=True)
        self.managed_python.write_text("managed python", encoding="utf-8")
        self.probes = (self.root / "probe-one.py", self.root / "probe-two.py")
        for probe in self.probes:
            probe.write_text("# probe\n", encoding="utf-8")
        self.runner = FakeEnvironmentRunner(self.managed_python)
        self.reconciler = ManagedEnvironmentReconciler(
            self.registry,
            runner=self.runner,  # type: ignore[arg-type]
            uv_executable=self.fake_uv,
            probe_scripts={
                "core-env": self.probes,
                "swarm-core-env": self.probes,
            },
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_builds_verifies_activates_and_reuses_exact_generation(self) -> None:
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "must-not-reach-uv"}):
            first = self.reconciler.reconcile("core-env")
            second = self.reconciler.reconcile("core-env")

        active = self.registry.active_manifest("core-env")
        self.assertEqual(first["outcome"], "activated")
        self.assertEqual(second["outcome"], "reused")
        self.assertIsNotNone(active)
        self.assertEqual(active["fingerprint"], first["fingerprint"])
        self.assertEqual(active["pythonVersion"], "3.11.9")
        self.assertTrue(Path(active["pythonExecutable"]).is_file())
        build_sync = [
            call
            for call in self.runner.calls
            if call["arguments"][1] == "sync"
            and "--check" not in call["arguments"]
        ]
        self.assertEqual(len(build_sync), 1)
        arguments = build_sync[0]["arguments"]
        self.assertIn("--frozen", arguments)
        self.assertIn("--no-default-groups", arguments)
        sync_environment = build_sync[0]["environment"]
        self.assertNotIn("OPENROUTER_API_KEY", sync_environment)
        self.assertTrue(
            Path(sync_environment["UV_PROJECT_ENVIRONMENT"]).is_relative_to(
                self.environment_root
            )
        )
        self.assertEqual(self.registry.descriptor()["environments"]["coreEnv"]["state"], "ready")

    def test_failed_rebuild_keeps_previous_active_generation(self) -> None:
        first = self.reconciler.reconcile("core-env")
        with (self.core / "uv.lock").open("a", encoding="utf-8") as stream:
            stream.write('\n[[package]]\nname = "new-dependency"\nversion = "1.0.0"\n')
        self.runner.fail_build_sync = True

        with self.assertRaises(ManagedEnvironmentError) as failed:
            self.reconciler.reconcile("core-env")

        active = self.registry.active_manifest("core-env")
        self.assertEqual(failed.exception.code, "environment_sync_failed")
        self.assertEqual(active["fingerprint"], first["fingerprint"])
        self.assertEqual(self.registry.descriptor()["environments"]["coreEnv"]["state"], "drifted")
        generations = self.environment_root / "core-env" / "generations"
        self.assertFalse(any(path.name.startswith(".s-") for path in generations.iterdir()))

    def test_replaces_a_tampered_generation_only_after_new_validation_passes(self) -> None:
        first = self.reconciler.reconcile("core-env")
        self.runner.fail_next_sync_check = 1

        replaced = self.reconciler.reconcile("core-env")

        self.assertEqual(replaced["outcome"], "activated")
        self.assertEqual(replaced["fingerprint"], first["fingerprint"])
        active = self.registry.active_manifest("core-env")
        self.assertEqual(active["fingerprint"], first["fingerprint"])
        generations = self.environment_root / "core-env" / "generations"
        self.assertFalse(any(path.name.startswith(".s-") or path.name.startswith(".b-") for path in generations.iterdir()))

    def test_cleanup_retains_only_active_and_one_previous_generation(self) -> None:
        fingerprints: list[str] = []
        for index in range(3):
            if index:
                with (self.core / "uv.lock").open("a", encoding="utf-8") as stream:
                    stream.write(
                        f'\n[[package]]\nname = "dependency-{index}"\nversion = "1.0.{index}"\n'
                    )
            fingerprints.append(str(self.reconciler.reconcile("core-env")["fingerprint"]))

        generations = self.environment_root / "core-env" / "generations"
        retained = [path for path in generations.iterdir() if not path.name.startswith(".")]
        active = self.registry.active_manifest("core-env")
        self.assertEqual(len(retained), 2)
        self.assertEqual(active["fingerprint"], fingerprints[-1])

    def test_installs_managed_python_when_not_already_available(self) -> None:
        self.managed_python.unlink()
        self.runner.installed = False
        self.runner.find_requires_install = True

        result = self.reconciler.reconcile("swarm-core-env")

        install_calls = [
            call
            for call in self.runner.calls
            if call["arguments"][1:3] == ["python", "install"]
        ]
        self.assertEqual(result["outcome"], "activated")
        self.assertEqual(len(install_calls), 1)
        self.assertIn("--no-registry", install_calls[0]["arguments"])
        self.assertTrue(install_calls[0]["capture"])
        self.assertTrue(self.managed_python.is_file())

    def test_reports_system_clock_without_exposing_uv_error(self) -> None:
        self.managed_python.unlink()
        self.runner.installed = False
        self.runner.find_requires_install = True
        self.runner.install_error = (
            "download failed: certificate not valid yet; secret diagnostic"
        )

        with self.assertRaises(ManagedEnvironmentError) as failed:
            self.reconciler.reconcile("core-env")

        self.assertEqual(failed.exception.code, "system_clock_invalid")
        self.assertNotIn("secret diagnostic", str(failed.exception))

    def test_api_reconciles_known_environment_and_rejects_request_fields(self) -> None:
        api = LocalRepositoryApi(
            self.config,
            repository_connections=self.connections,
            environment_registry=self.registry,
            environment_reconciler=self.reconciler,
        )

        reconciled = api.dispatch(
            "POST",
            "/api/v1/environments/core-env/reconcile",
            body={},
        )
        rejected = api.dispatch(
            "POST",
            "/api/v1/environments/core-env/reconcile",
            body={"force": True},
        )

        self.assertEqual(reconciled.status, 200)
        self.assertEqual(reconciled.body["result"]["outcome"], "activated")
        self.assertEqual(
            reconciled.body["environments"]["environments"]["coreEnv"]["state"],
            "ready",
        )
        self.assertEqual(rejected.status, 400)
        self.assertEqual(rejected.body["error"]["code"], "invalid_environment_reconcile")


if __name__ == "__main__":
    unittest.main()
