from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "sample_project"
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


class LocalRepositoryApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
        )
        cls.api = LocalRepositoryApi(config)

    def test_reports_read_only_health_and_scans_an_authorized_scope(self) -> None:
        health = self.api.dispatch("GET", "/api/v1/health", origin=ALLOWED_ORIGIN)
        catalog = self.api.dispatch(
            "GET",
            "/api/v1/repositories",
            origin=ALLOWED_ORIGIN,
        )
        scan = self.api.dispatch(
            "POST",
            "/api/v1/repositories/scan",
            body={"path": str(FIXTURE_ROOT)},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(health.status, 200)
        self.assertEqual(health.body["mode"], "read-only")
        self.assertEqual(catalog.status, 200)
        self.assertFalse(catalog.body["writeOperations"])
        self.assertTrue(
            any(
                repository["path"] == str(REPOSITORY_ROOT)
                for repository in catalog.body["repositories"]
            )
        )
        self.assertEqual(scan.status, 200)
        self.assertGreater(scan.body["statistics"]["nodes"], 5)
        self.assertEqual(scan.body["repository"]["scanScope"], str(FIXTURE_ROOT))

    def test_rejects_untrusted_origins_and_paths(self) -> None:
        origin_response = self.api.dispatch(
            "GET",
            "/api/v1/health",
            origin="https://example.com",
        )
        path_response = self.api.dispatch(
            "POST",
            "/api/v1/repositories/scan",
            body={"path": str(REPOSITORY_ROOT.parent)},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(origin_response.status, 403)
        self.assertEqual(origin_response.body["error"]["code"], "origin_not_allowed")
        self.assertEqual(path_response.status, 403)
        self.assertEqual(path_response.body["error"]["code"], "path_not_allowed")


if __name__ == "__main__":
    unittest.main()
