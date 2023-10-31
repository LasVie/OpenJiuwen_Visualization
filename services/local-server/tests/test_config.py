from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.config import LocalServiceConfig, PathAccessError


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class LocalServiceConfigTests(unittest.TestCase):
    def test_authorizes_only_resolved_directories_inside_allowed_roots(self) -> None:
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=["http://127.0.0.1:4173/"],
        )

        self.assertEqual(config.authorize_directory(REPOSITORY_ROOT), REPOSITORY_ROOT)
        self.assertTrue(config.is_origin_allowed("http://127.0.0.1:4173"))
        self.assertFalse(config.is_origin_allowed("https://example.com"))
        self.assertEqual(
            config.archive_path,
            REPOSITORY_ROOT / ".openjiuwen-visualization" / "runtime-archive.sqlite3",
        )
        self.assertEqual(config.archive_retention_days, 30)
        self.assertEqual(config.archive_max_bytes, 2 * 1024 * 1024 * 1024)
        self.assertEqual(
            config.development_session_path,
            REPOSITORY_ROOT
            / ".openjiuwen-visualization"
            / "development-sessions.sqlite3",
        )
        self.assertEqual(config.development_session_retention_days, 30)
        self.assertFalse(config.system_credentials_enabled)
        self.assertEqual(
            config.development_session_max_bytes, 2 * 1024 * 1024 * 1024
        )
        self.assertEqual(
            config.development_execution_path,
            REPOSITORY_ROOT
            / ".openjiuwen-visualization"
            / "development-executions.sqlite3",
        )
        self.assertEqual(
            config.development_worktree_root,
            REPOSITORY_ROOT
            / ".openjiuwen-visualization"
            / "development-worktrees",
        )
        self.assertEqual(
            config.connection_settings_path,
            REPOSITORY_ROOT
            / ".openjiuwen-visualization"
            / "connection-settings.sqlite3",
        )
        self.assertEqual(
            config.managed_source_root,
            REPOSITORY_ROOT / ".openjiuwen-visualization" / "sources",
        )
        self.assertEqual(
            config.managed_environment_root,
            REPOSITORY_ROOT / ".openjiuwen-visualization" / "environments",
        )
        with self.assertRaises(PathAccessError):
            config.authorize_directory(REPOSITORY_ROOT.parent)

    def test_requires_an_explicit_allowed_root(self) -> None:
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(allowed_roots=[])

    def test_keeps_the_archive_file_inside_an_allowed_root(self) -> None:
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                archive_path=REPOSITORY_ROOT.parent / "outside.sqlite3",
            )

        configured = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            archive_path=REPOSITORY_ROOT / ".runtime-temp" / "configured.sqlite3",
            archive_retention_days=90,
            archive_max_bytes=4 * 1024 * 1024,
            development_session_path=(
                REPOSITORY_ROOT / ".runtime-temp" / "development.sqlite3"
            ),
            development_session_retention_days=60,
            development_session_max_bytes=8 * 1024 * 1024,
            development_execution_path=(
                REPOSITORY_ROOT / ".runtime-temp" / "executions.sqlite3"
            ),
            development_worktree_root=(
                REPOSITORY_ROOT / ".runtime-temp" / "controlled-worktrees"
            ),
            connection_settings_path=(
                REPOSITORY_ROOT / ".runtime-temp" / "connections.sqlite3"
            ),
            managed_source_root=(
                REPOSITORY_ROOT / ".runtime-temp" / "managed-sources"
            ),
            managed_environment_root=(
                REPOSITORY_ROOT / ".runtime-temp" / "managed-environments"
            ),
        )
        self.assertEqual(
            configured.archive_path,
            REPOSITORY_ROOT / ".runtime-temp" / "configured.sqlite3",
        )
        self.assertEqual(configured.archive_retention_days, 90)
        self.assertEqual(configured.archive_max_bytes, 4 * 1024 * 1024)
        self.assertEqual(
            configured.development_session_path,
            REPOSITORY_ROOT / ".runtime-temp" / "development.sqlite3",
        )
        self.assertEqual(configured.development_session_retention_days, 60)
        self.assertEqual(configured.development_session_max_bytes, 8 * 1024 * 1024)
        self.assertEqual(
            configured.development_execution_path,
            REPOSITORY_ROOT / ".runtime-temp" / "executions.sqlite3",
        )
        self.assertEqual(
            configured.development_worktree_root,
            REPOSITORY_ROOT / ".runtime-temp" / "controlled-worktrees",
        )
        self.assertEqual(
            configured.connection_settings_path,
            REPOSITORY_ROOT / ".runtime-temp" / "connections.sqlite3",
        )
        self.assertEqual(
            configured.managed_source_root,
            REPOSITORY_ROOT / ".runtime-temp" / "managed-sources",
        )
        self.assertEqual(
            configured.managed_environment_root,
            REPOSITORY_ROOT / ".runtime-temp" / "managed-environments",
        )

        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                development_session_path=REPOSITORY_ROOT.parent / "outside.sqlite3",
            )
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                development_execution_path=REPOSITORY_ROOT.parent / "outside.sqlite3",
            )
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                development_worktree_root=REPOSITORY_ROOT.parent / "outside-worktrees",
            )
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                connection_settings_path=REPOSITORY_ROOT.parent / "outside.sqlite3",
            )
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                managed_source_root=REPOSITORY_ROOT.parent / "outside-sources",
            )
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                managed_environment_root=REPOSITORY_ROOT.parent / "outside-environments",
            )

    def test_scopes_unsigned_plugin_discovery_to_explicit_allowed_paths(self) -> None:
        with self.assertRaises(ValueError):
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                plugin_developer_roots=[REPOSITORY_ROOT],
            )

        configured = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allow_unsigned_plugins=True,
            plugin_developer_roots=[REPOSITORY_ROOT],
        )

        self.assertTrue(configured.allow_unsigned_plugins)
        self.assertEqual(configured.plugin_developer_roots, (REPOSITORY_ROOT,))


if __name__ == "__main__":
    unittest.main()
