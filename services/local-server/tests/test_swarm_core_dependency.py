from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.repository_connections import (
    RepositoryConnectionStore,
)
from openjiuwen_visualization_server.swarm_core_dependency import (
    SwarmCoreDependencyInspector,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
LOCKED_REVISION = "ce21a9b7cfcce28923fba6c47758d60c624b69be"


def create_repository(root: Path, marker: Path) -> Path:
    root.mkdir(parents=True)
    target = root / marker
    target.parent.mkdir(parents=True)
    target.write_text("# test marker\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Dependency Test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "fixture"],
        check=True,
    )
    return root


class SwarmCoreDependencyTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="swarm-core-dependency-",
            dir=runtime_temp,
        )
        self.root = Path(self.temporary.name)
        self.core = create_repository(
            self.root / "agent-core",
            Path("openjiuwen/harness/deep_agent.py"),
        )
        self.swarm = create_repository(
            self.root / "jiuwenswarm",
            Path("jiuwenswarm/agents/swarm/assembly.py"),
        )
        self.config = LocalServiceConfig.create(
            allowed_roots=[self.root],
            connection_settings_path=self.root / "state" / "connections.sqlite3",
            managed_source_root=self.root / "managed",
        )
        self.resolver = RepositoryResolver(self.config)
        self.inspector = SwarmCoreDependencyInspector(self.config, self.resolver)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_remote_config(self, *, locked: bool = True) -> None:
        (self.swarm / "pyproject.toml").write_text(
            """
[project]
name = "workswarm"
version = "0.1.0"
dependencies = [
  "openjiuwen @ git+https://gitcode.com/openJiuwen/agent-core.git@develop",
]

[tool.uv.sources]
openjiuwen = { git = "https://gitcode.com/openJiuwen/agent-core.git", branch = "develop" }
""".strip()
            + "\n",
            encoding="utf-8",
        )
        if locked:
            (self.swarm / "uv.lock").write_text(
                f"""
version = 1

[[package]]
name = "openjiuwen"
version = "0.1.16"
source = {{ git = "https://gitcode.com/openJiuwen/agent-core.git?branch=develop#{LOCKED_REVISION}" }}
""".strip()
                + "\n",
                encoding="utf-8",
            )

    def test_reports_declared_branch_and_exact_locked_git_revision(self) -> None:
        self.write_remote_config()

        result = self.inspector.inspect(self.swarm)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["code"], "git_core_dependency_locked")
        self.assertEqual(result["source"]["kind"], "git")
        self.assertEqual(result["source"]["ref"], {"kind": "branch", "value": "develop"})
        self.assertEqual(result["source"]["lockedRevision"], LOCKED_REVISION)
        self.assertEqual(len(result["evidence"]["pyproject"]["sha256"]), 64)
        self.assertEqual(len(result["evidence"]["uvLock"]["sha256"]), 64)

    def test_resolves_allowed_local_core_path_and_git_identity(self) -> None:
        (self.swarm / "pyproject.toml").write_text(
            """
[project]
name = "workswarm"
version = "0.1.0"
dependencies = ["openjiuwen"]

[tool.uv.sources]
openjiuwen = { path = "../agent-core", editable = true }
""".strip()
            + "\n",
            encoding="utf-8",
        )

        result = self.inspector.inspect(self.swarm)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["source"]["kind"], "path")
        self.assertEqual(Path(result["source"]["path"]), self.core)
        self.assertEqual(len(result["source"]["revision"]), 40)
        self.assertEqual(result["source"]["lockStatus"], "local")

    def test_rejects_secret_bearing_direct_source_without_echoing_it(self) -> None:
        secret = "do-not-return-this"
        (self.swarm / "pyproject.toml").write_text(
            f"""
[project]
name = "workswarm"
version = "0.1.0"
dependencies = ["openjiuwen @ git+https://user:{secret}@github.com/LasVie/agent-core.git@main"]
""".strip()
            + "\n",
            encoding="utf-8",
        )

        result = self.inspector.inspect(self.swarm)

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["code"], "unsupported_core_direct_source")
        self.assertNotIn(secret, json.dumps(result))

    def test_malformed_project_structure_degrades_to_unavailable_status(self) -> None:
        (self.swarm / "pyproject.toml").write_text(
            'project = "not-a-table"\n',
            encoding="utf-8",
        )

        result = self.inspector.inspect(self.swarm)

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["code"], "swarm_config_unreadable")
        self.assertIsNone(result["source"])

    def test_store_descriptor_and_manual_api_return_fresh_inspection(self) -> None:
        self.write_remote_config(locked=False)
        store = RepositoryConnectionStore(
            self.config,
            self.resolver,
            default_paths={"agent-core": self.core, "jiuwenswarm": self.swarm},
        )
        api = LocalRepositoryApi(self.config, repository_connections=store)

        settings = api.dispatch("GET", "/api/v1/settings")
        inspected = api.dispatch(
            "POST",
            "/api/v1/settings/repositories/jiuwenswarm/inspect-core-dependency",
            body={},
        )
        rejected = api.dispatch(
            "POST",
            "/api/v1/settings/repositories/jiuwenswarm/inspect-core-dependency",
            body={"execute": True},
        )

        dependency = settings.body["settings"]["repositories"]["slots"]["jiuwenSwarm"]["coreDependency"]
        self.assertEqual(dependency["code"], "git_core_dependency_unlocked")
        self.assertEqual(inspected.status, 200)
        self.assertEqual(inspected.body["inspection"]["source"]["ref"]["value"], "develop")
        self.assertEqual(rejected.status, 400)
        self.assertEqual(
            rejected.body["error"]["code"],
            "invalid_swarm_dependency_inspection",
        )


if __name__ == "__main__":
    unittest.main()
