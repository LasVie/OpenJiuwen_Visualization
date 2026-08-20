from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.companion import (
    CompanionLaunchError,
    CompanionPaths,
    build_companion_config,
    web_build_is_current,
)


class CompanionLauncherTests(unittest.TestCase):
    def test_discovers_workspace_and_builds_secure_loopback_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            project = workspace / "visualization-web"
            project.mkdir()
            (project / "package.json").write_text("{}", encoding="utf-8")

            paths = CompanionPaths.discover(project)
            config = build_companion_config(paths)

            self.assertEqual(paths.project_root, project.resolve())
            self.assertEqual(paths.workspace_root, workspace.resolve())
            self.assertEqual(config.allowed_roots, (workspace.resolve(),))
            self.assertTrue(config.system_credentials_enabled)
            self.assertTrue(config.is_origin_allowed("http://127.0.0.1:8765"))

    def test_detects_missing_stale_and_current_web_builds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            project = workspace / "visualization-web"
            source = project / "src" / "main.tsx"
            source.parent.mkdir(parents=True)
            source.write_text("export {};", encoding="utf-8")
            (project / "package.json").write_text("{}", encoding="utf-8")
            paths = CompanionPaths.discover(project)

            self.assertFalse(web_build_is_current(paths))
            paths.static_root.mkdir()
            index = paths.static_root / "index.html"
            index.write_text("built", encoding="utf-8")
            input_time = max(
                source.stat().st_mtime_ns,
                (project / "package.json").stat().st_mtime_ns,
            )
            os.utime(index, ns=(input_time + 1_000_000, input_time + 1_000_000))
            self.assertTrue(web_build_is_current(paths))

            os.utime(source, ns=(input_time + 2_000_000, input_time + 2_000_000))
            self.assertFalse(web_build_is_current(paths))

    def test_rejects_a_directory_that_is_not_the_web_project(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(CompanionLaunchError):
                CompanionPaths.discover(temporary)


if __name__ == "__main__":
    unittest.main()
