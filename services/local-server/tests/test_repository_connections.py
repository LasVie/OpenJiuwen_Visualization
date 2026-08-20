from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.repository_connections import (
    GitHubReference,
    RepositoryConnectionError,
    RepositoryConnectionStore,
    parse_public_github_reference,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


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
        ["git", "-C", str(root), "config", "user.name", "Connection Test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "fixture"],
        check=True,
    )
    return root


class FakeManagedRepositories:
    def __init__(self, root: Path, checkouts: dict[str, Path]) -> None:
        self.root = root
        self.checkouts = checkouts
        self.synced: list[tuple[Path, GitHubReference]] = []

    def checkout(self, slot: str, reference: GitHubReference) -> tuple[Path, bool]:
        del reference
        return self.checkouts[slot], False

    def sync(self, path: Path, reference: GitHubReference) -> Path:
        self.synced.append((path, reference))
        return path

    def discard(self, path: Path) -> None:
        raise AssertionError(f"Existing fixture must not be discarded: {path}")


class RepositoryConnectionTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="repository-connections-",
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
        self.managed = FakeManagedRepositories(
            self.root / "managed",
            {"agent-core": self.core, "jiuwenswarm": self.swarm},
        )
        self.store = RepositoryConnectionStore(
            self.config,
            RepositoryResolver(self.config),
            default_paths={"agent-core": self.core, "jiuwenswarm": self.swarm},
            managed_repositories=self.managed,  # type: ignore[arg-type]
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_defaults_local_bindings_and_sqlite_state_are_reported(self) -> None:
        initial = self.store.descriptor()
        self.assertEqual(initial["storage"]["journalMode"], "wal")
        self.assertEqual(initial["slots"]["agentCore"]["origin"], "default")
        self.assertTrue(initial["slots"]["agentCore"]["configured"])

        bound = self.store.bind_local("agent-core", str(self.core))
        reopened = RepositoryConnectionStore(
            self.config,
            RepositoryResolver(self.config),
            default_paths={"agent-core": self.swarm, "jiuwenswarm": self.swarm},
            managed_repositories=self.managed,  # type: ignore[arg-type]
        )

        self.assertEqual(bound["origin"], "configured")
        self.assertEqual(reopened.effective_path("agent-core"), self.core)
        self.assertEqual(reopened.reset("agent-core")["origin"], "default")

    def test_public_github_binding_and_manual_sync_use_managed_checkout(self) -> None:
        bound = self.store.bind_github(
            "agent-core",
            "https://github.com/LasVie/agent-core/tree/develop".replace(
                "/tree/develop", ""
            ),
            "develop",
        )
        synced = self.store.sync("agent-core")

        self.assertEqual(bound["mode"], "github")
        self.assertEqual(bound["github"]["repository"], "LasVie/agent-core")
        self.assertEqual(bound["github"]["ref"], "develop")
        self.assertEqual(bound["repository"]["owner"], "agent-core")
        self.assertTrue(synced["lastSyncedAt"])
        self.assertEqual(len(self.managed.synced), 1)

    def test_rejects_wrong_framework_outside_paths_and_unsafe_github_inputs(self) -> None:
        with self.assertRaises(RepositoryConnectionError) as mismatch:
            self.store.bind_local("agent-core", str(self.swarm))
        self.assertEqual(mismatch.exception.code, "repository_framework_mismatch")

        with self.assertRaises(RepositoryConnectionError) as outside:
            self.store.bind_local("agent-core", str(REPOSITORY_ROOT))
        self.assertEqual(outside.exception.code, "repository_path_not_allowed")

        for url, ref in (
            ("git@github.com:LasVie/agent-core.git", None),
            ("https://user:secret@github.com/LasVie/agent-core", None),
            ("https://github.com/LasVie/agent-core?token=secret", None),
            ("https://github.com/LasVie/agent-core", "--upload-pack=evil"),
            ("https://github.com/LasVie/agent-core", "develop..main"),
        ):
            with self.subTest(url=url, ref=ref):
                with self.assertRaises(RepositoryConnectionError):
                    parse_public_github_reference(url, ref)

    def test_api_updates_all_runtime_roots_and_blocks_changes_while_running(self) -> None:
        api = LocalRepositoryApi(
            self.config,
            repository_connections=self.store,
        )

        settings = api.dispatch("GET", "/api/v1/settings")
        bound = api.dispatch(
            "POST",
            "/api/v1/settings/repositories/agent-core",
            body={"kind": "local", "path": str(self.core)},
        )
        github = api.dispatch(
            "POST",
            "/api/v1/settings/repositories/jiuwenswarm",
            body={
                "kind": "github",
                "url": "https://github.com/LasVie/jiuwenswarm",
                "ref": "main",
            },
        )
        synced = api.dispatch(
            "POST",
            "/api/v1/settings/repositories/jiuwenswarm/sync",
        )

        self.assertEqual(settings.status, 200)
        self.assertIn("repositories", settings.body["settings"])
        self.assertEqual(bound.status, 200)
        self.assertEqual(github.status, 200)
        self.assertEqual(synced.status, 200)
        self.assertEqual(api.agent_core_adapter.config.source_root, self.core)
        self.assertEqual(api.subagent_adapter.config.agent_core_root, self.core)
        self.assertEqual(api.jiuwenswarm_adapter.config.source_root, self.swarm)
        self.assertEqual(api.swarmflow_adapter.config.source_root, self.swarm)

        api.agent_core_adapter._jobs["busy"] = type(  # type: ignore[attr-defined]
            "BusyJob",
            (),
            {"state": "running"},
        )()
        blocked = api.dispatch(
            "DELETE",
            "/api/v1/settings/repositories/agent-core",
        )
        self.assertEqual(blocked.status, 409)
        self.assertEqual(blocked.body["error"]["code"], "runtime_busy")


if __name__ == "__main__":
    unittest.main()
