from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.scanner import ToolCatalogOptions, ToolCatalogScanner


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "sample_project"


class ToolCatalogScannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        config = LocalServiceConfig.create(allowed_roots=[REPOSITORY_ROOT])
        cls.identity = RepositoryResolver(config).resolve(FIXTURE_ROOT)

    def test_indexes_tool_declarations_and_registration_paths(self) -> None:
        result = ToolCatalogScanner().scan(self.identity)
        tools = {item["name"]: item for item in result["tools"]}
        sites = result["registrationSites"]

        self.assertEqual(result["schemaVersion"], "1.0.0")
        self.assertFalse(result["writeOperations"])
        self.assertEqual(tools["weather_lookup"]["kind"], "tool-class")
        self.assertTrue(tools["weather_lookup"]["card"]["stateless"])
        self.assertEqual(tools["city_search"]["kind"], "decorated-function")
        self.assertEqual(tools["city_search"]["card"]["parameters"], ["query", "limit"])
        self.assertEqual(tools["city_card"]["kind"], "tool-card")
        self.assertEqual(tools["city_card"]["card"]["parameters"], ["city"])
        self.assertTrue(tools["weather_lookup"]["registrationSiteIds"])
        self.assertTrue(tools["city_search"]["registrationSiteIds"])
        self.assertTrue(tools["city_card"]["registrationSiteIds"])
        self.assertTrue(any(site["confidence"] == "dynamic" for site in sites))
        self.assertGreaterEqual(result["statistics"]["linkedRegistrations"], 3)

    def test_applies_catalog_limits(self) -> None:
        result = ToolCatalogScanner().scan(
            self.identity,
            ToolCatalogOptions(max_tools=1, max_registration_sites=1),
        )

        self.assertEqual(len(result["tools"]), 1)
        self.assertLessEqual(len(result["registrationSites"]), 1)
        self.assertTrue(result["statistics"]["truncated"])


if __name__ == "__main__":
    unittest.main()
