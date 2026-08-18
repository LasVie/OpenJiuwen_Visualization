from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.repository import RepositoryResolver
from openjiuwen_visualization_server.scanner import PythonRepositoryScanner, ScanOptions
from openjiuwen_visualization_server.config import LocalServiceConfig


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "sample_project"


class PythonRepositoryScannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = LocalServiceConfig.create(allowed_roots=[REPOSITORY_ROOT])
        cls.identity = RepositoryResolver(cls.config).resolve(FIXTURE_ROOT)

    def test_builds_stable_hierarchy_and_openjiuwen_semantics(self) -> None:
        scanner = PythonRepositoryScanner()
        first = scanner.scan(self.identity)
        second = scanner.scan(self.identity)
        graph = first["graph"]
        nodes = graph["nodes"]
        edges = graph["edges"]
        nodes_by_label = {node["label"]: node for node in nodes}

        self.assertEqual(first["apiVersion"], "1.0.0")
        self.assertEqual(graph["schemaVersion"], "1.0.0")
        self.assertEqual(nodes_by_label["DeepAgent"]["kind"], "agent")
        self.assertEqual(nodes_by_label["SafetyRail"]["kind"], "rail")
        self.assertEqual(nodes_by_label["WeatherTool"]["kind"], "tool")
        self.assertEqual(nodes_by_label["DeepAgent"]["contributedBy"], "openjiuwen.local-repository")
        self.assertIn(":DeepAgent", nodes_by_label["DeepAgent"]["id"])
        self.assertEqual(
            [node["id"] for node in nodes],
            [node["id"] for node in second["graph"]["nodes"]],
        )
        self.assertTrue(any(edge["kind"] == "imports" for edge in edges))
        self.assertTrue(any(edge["kind"] == "inherits" for edge in edges))
        self.assertFalse(any(node["label"] == "helper" for node in nodes))

    def test_can_include_top_level_functions_explicitly(self) -> None:
        result = PythonRepositoryScanner().scan(
            self.identity,
            ScanOptions(include_functions=True),
        )
        helper = next(node for node in result["graph"]["nodes"] if node["label"] == "helper")

        self.assertEqual(helper["kind"], "function")
        self.assertEqual(helper["attributes"]["parameterCount"], 0)

    def test_applies_the_edge_limit_to_package_hierarchy(self) -> None:
        result = PythonRepositoryScanner().scan(
            self.identity,
            ScanOptions(max_edges=1),
        )

        self.assertEqual(len(result["graph"]["edges"]), 1)
        self.assertTrue(result["statistics"]["truncated"])
        self.assertIn("Edge scan stopped at maxEdges=1.", result["warnings"])


if __name__ == "__main__":
    unittest.main()
