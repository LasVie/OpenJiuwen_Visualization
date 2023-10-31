from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.managed_environments import (
    ManagedEnvironmentRegistry,
)
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.repository_connections import (
    RepositoryConnectionStore,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
LOCKED_CORE_REVISION = "ce21a9b7cfcce28923fba6c47758d60c624b69be"


def create_project(
    root: Path,
    marker: Path,
    *,
    project_name: str,
    pyproject_extra: str = "",
    lock_extra: str = "",
) -> Path:
    root.mkdir(parents=True)
    target = root / marker
    target.parent.mkdir(parents=True)
    target.write_text("# test marker\n", encoding="utf-8")
    (root / ".python-version").write_text("3.11\n", encoding="utf-8")
    (root / "pyproject.toml").write_text(
        f"""
[project]
name = "{project_name}"
version = "0.1.0"
requires-python = ">=3.11,<3.14"
dependencies = []
{pyproject_extra}
""".strip()
        + "\n",
        encoding="utf-8",
    )
    (root / "uv.lock").write_text(
        ("version = 1\n" + lock_extra).strip() + "\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Environment Test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "fixture"],
        check=True,
    )
    return root


def git_status(root: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain=v1"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


class ManagedEnvironmentTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="managed-environments-",
            dir=runtime_temp,
        )
        self.root = Path(self.temporary.name)
        self.core = create_project(
            self.root / "agent-core",
            Path("openjiuwen/harness/deep_agent.py"),
            project_name="openjiuwen",
        )
        self.swarm = create_project(
            self.root / "jiuwenswarm",
            Path("jiuwenswarm/agents/swarm/assembly.py"),
            project_name="workswarm",
            lock_extra=f"""

[[package]]
name = "openjiuwen"
version = "0.1.16"
source = {{ git = "https://gitcode.com/openJiuwen/agent-core.git?branch=develop#{LOCKED_CORE_REVISION}" }}
""",
        )
        # Replace the fixture's array with a valid PEP 508 dependency and recommit.
        swarm_pyproject = self.swarm / "pyproject.toml"
        swarm_pyproject.write_text(
            f"""
[project]
name = "workswarm"
version = "0.1.0"
requires-python = ">=3.11,<3.14"
dependencies = [
  "openjiuwen @ git+https://gitcode.com/openJiuwen/agent-core.git@develop",
]

[tool.uv.sources]
openjiuwen = {{ git = "https://gitcode.com/openJiuwen/agent-core.git", branch = "develop" }}
""".strip()
            + "\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "-C", str(self.swarm), "add", "pyproject.toml"], check=True)
        subprocess.run(
            ["git", "-C", str(self.swarm), "commit", "-q", "-m", "swarm config"],
            check=True,
        )
        self.environment_root = self.root / "managed-environments"
        self.config = LocalServiceConfig.create(
            allowed_roots=[self.root],
            connection_settings_path=self.root / "state" / "connections.sqlite3",
            managed_source_root=self.root / "managed-sources",
            managed_environment_root=self.environment_root,
        )
        self.resolver = RepositoryResolver(self.config)
        self.connections = RepositoryConnectionStore(
            self.config,
            self.resolver,
            default_paths={"agent-core": self.core, "jiuwenswarm": self.swarm},
        )
        self.registry = ManagedEnvironmentRegistry(
            self.config,
            self.connections,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_refresh_writes_stable_specs_outside_upstream_repositories(self) -> None:
        initial_core_status = git_status(self.core)
        initial_swarm_status = git_status(self.swarm)

        first = self.registry.refresh()
        core_path = self.environment_root / "specs" / "core-env.json"
        swarm_path = self.environment_root / "specs" / "swarm-core-env.json"
        first_core_content = core_path.read_text(encoding="utf-8")
        second = self.registry.refresh()

        self.assertTrue(core_path.is_file())
        self.assertTrue(swarm_path.is_file())
        self.assertEqual(first_core_content, core_path.read_text(encoding="utf-8"))
        self.assertEqual(first["environments"]["coreEnv"]["state"], "planned")
        self.assertEqual(second["environments"]["swarmCoreEnv"]["state"], "planned")
        self.assertEqual(
            first["environments"]["coreEnv"]["desired"]["consumers"],
            ["agent-core", "subagent"],
        )
        self.assertEqual(
            first["environments"]["swarmCoreEnv"]["desired"]["coreDependency"]["lockedRevision"],
            LOCKED_CORE_REVISION,
        )
        self.assertEqual(git_status(self.core), initial_core_status)
        self.assertEqual(git_status(self.swarm), initial_swarm_status)
        self.assertFalse(core_path.is_relative_to(self.core))
        self.assertFalse(swarm_path.is_relative_to(self.swarm))

    def test_remote_swarm_core_identity_is_independent_of_standalone_core_binding(self) -> None:
        first = self.registry.refresh()
        first_core = first["environments"]["coreEnv"]["desired"]["fingerprint"]
        first_swarm = first["environments"]["swarmCoreEnv"]["desired"]["fingerprint"]
        alternate_core = create_project(
            self.root / "alternate-agent-core",
            Path("openjiuwen/harness/deep_agent.py"),
            project_name="openjiuwen",
            lock_extra="\n[[package]]\nname = \"alternate-only\"\nversion = \"1.0.0\"\n",
        )

        self.connections.bind_local("agent-core", str(alternate_core))
        changed = self.registry.refresh()

        self.assertNotEqual(
            changed["environments"]["coreEnv"]["desired"]["fingerprint"],
            first_core,
        )
        self.assertEqual(
            changed["environments"]["swarmCoreEnv"]["desired"]["fingerprint"],
            first_swarm,
        )

    def test_missing_lock_blocks_spec_without_creating_an_environment(self) -> None:
        (self.core / "uv.lock").unlink()

        descriptor = self.registry.refresh()
        core = descriptor["environments"]["coreEnv"]

        self.assertEqual(core["state"], "blocked")
        self.assertEqual(core["desired"]["resolution"]["code"], "uv_lock_missing")
        self.assertIsNone(core["active"])
        self.assertFalse((self.environment_root / "core-env" / "generations").exists())

    def test_invalid_lock_is_rejected_during_planning(self) -> None:
        (self.core / "uv.lock").write_text("not = [valid\n", encoding="utf-8")

        descriptor = self.registry.refresh()

        core = descriptor["environments"]["coreEnv"]
        self.assertEqual(core["state"], "blocked")
        self.assertEqual(core["desired"]["resolution"]["code"], "uv_lock_invalid")

    def test_loopback_api_reads_and_refreshes_generated_specs(self) -> None:
        api = LocalRepositoryApi(
            self.config,
            repository_connections=self.connections,
            environment_registry=self.registry,
        )

        current = api.dispatch("GET", "/api/v1/environments")
        refreshed = api.dispatch("POST", "/api/v1/environments/refresh", body={})
        rejected = api.dispatch(
            "POST",
            "/api/v1/environments/refresh",
            body={"install": True},
        )

        self.assertEqual(current.status, 200)
        self.assertEqual(current.body["policy"]["python"], "3.11")
        self.assertFalse(current.body["policy"]["upstreamWrites"])
        self.assertEqual(refreshed.status, 200)
        self.assertEqual(rejected.status, 400)
        self.assertEqual(rejected.body["error"]["code"], "invalid_environment_refresh")
        self.assertNotIn("apiKey", json.dumps(refreshed.body))


if __name__ == "__main__":
    unittest.main()
