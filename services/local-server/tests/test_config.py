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
        )
        self.assertEqual(
            configured.archive_path,
            REPOSITORY_ROOT / ".runtime-temp" / "configured.sqlite3",
        )
        self.assertEqual(configured.archive_retention_days, 90)
        self.assertEqual(configured.archive_max_bytes, 4 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
