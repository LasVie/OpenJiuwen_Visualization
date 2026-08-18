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
        with self.assertRaises(PathAccessError):
            config.authorize_directory(REPOSITORY_ROOT.parent)

    def test_requires_an_explicit_allowed_root(self) -> None:
        with self.assertRaises(PathAccessError):
            LocalServiceConfig.create(allowed_roots=[])


if __name__ == "__main__":
    unittest.main()
