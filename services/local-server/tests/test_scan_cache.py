from __future__ import annotations

import unittest
from pathlib import Path

from openjiuwen_visualization_server.repository import RepositoryIdentity
from openjiuwen_visualization_server.scan_cache import DefinitionScanCache
from openjiuwen_visualization_server.scanner import ScanManifest, ScanOptions


class _Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


class _StubScanner:
    def __init__(self) -> None:
        self.fingerprint = "first"
        self.cacheable = True
        self.bypass_reason: str | None = None
        self.manifest_sequence: list[str] = []
        self.padding = ""
        self.scans = 0

    def manifest(self, identity, options, *, max_hashed_bytes):  # type: ignore[no-untyped-def]
        del identity, options, max_hashed_bytes
        return ScanManifest(
            fingerprint=(
                self.manifest_sequence.pop(0)
                if self.manifest_sequence
                else self.fingerprint
            ),
            python_files=3,
            bytes_hashed=120,
            truncated=False,
            cacheable=self.cacheable,
            bypass_reason=self.bypass_reason,
        )

    def scan(self, identity, options):  # type: ignore[no-untyped-def]
        del options
        self.scans += 1
        return {
            "apiVersion": "1.0.0",
            "repository": identity.to_api_dict(),
            "graph": {"schemaVersion": "1.0.0", "nodes": [], "edges": []},
            "statistics": {
                "pythonFiles": 3,
                "symbols": 0,
                "nodes": 0,
                "edges": 0,
                "durationMs": 17,
                "truncated": False,
            },
            "warnings": [self.padding] if self.padding else [],
        }


def _identity(name: str = "repo") -> RepositoryIdentity:
    root = Path("C:/workspace") / name
    return RepositoryIdentity(
        id=name,
        name=name,
        owner="local-repository",
        root=root,
        scan_root=root,
        revision="a" * 40,
        branch="main",
        dirty=False,
    )


class DefinitionScanCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = _Clock()
        self.scanner = _StubScanner()
        self.cache = DefinitionScanCache(
            self.scanner,  # type: ignore[arg-type]
            max_entries=2,
            ttl_seconds=5,
            clock=self.clock,
        )

    def test_returns_deep_copied_memory_hit(self) -> None:
        first = self.cache.scan(_identity())
        second = self.cache.scan(_identity())

        self.assertEqual(first["statistics"]["cache"]["status"], "miss")  # type: ignore[index]
        self.assertEqual(second["statistics"]["cache"]["status"], "hit")  # type: ignore[index]
        self.assertEqual(self.scanner.scans, 1)
        second["graph"]["nodes"].append({"id": "mutated"})  # type: ignore[index,union-attr]
        third = self.cache.scan(_identity())
        self.assertEqual(third["graph"]["nodes"], [])  # type: ignore[index]

    def test_invalidates_when_manifest_changes_or_entry_expires(self) -> None:
        self.cache.scan(_identity())
        self.scanner.fingerprint = "second"
        changed = self.cache.scan(_identity())
        self.clock.value += 6
        expired = self.cache.scan(_identity())

        self.assertEqual(changed["statistics"]["cache"]["status"], "miss")  # type: ignore[index]
        self.assertEqual(expired["statistics"]["cache"]["status"], "miss")  # type: ignore[index]
        self.assertEqual(self.scanner.scans, 3)

    def test_evicts_least_recently_used_entry(self) -> None:
        cache = DefinitionScanCache(
            self.scanner,  # type: ignore[arg-type]
            max_entries=1,
            ttl_seconds=30,
            clock=self.clock,
        )
        cache.scan(_identity("first"))
        cache.scan(_identity("second"))
        result = cache.scan(_identity("first"))

        self.assertEqual(result["statistics"]["cache"]["status"], "miss")  # type: ignore[index]
        self.assertEqual(self.scanner.scans, 3)

    def test_bypasses_cache_when_manifest_validation_is_not_bounded(self) -> None:
        self.scanner.cacheable = False
        self.scanner.bypass_reason = "manifest-byte-limit"
        first = self.cache.scan(_identity())
        second = self.cache.scan(_identity())

        self.assertEqual(first["statistics"]["cache"]["status"], "bypass")  # type: ignore[index]
        self.assertEqual(
            second["statistics"]["cache"]["bypassReason"],  # type: ignore[index]
            "manifest-byte-limit",
        )
        self.assertEqual(self.scanner.scans, 2)

    def test_does_not_store_a_scan_when_inputs_change_during_parsing(self) -> None:
        self.scanner.manifest_sequence = ["before", "after"]
        raced = self.cache.scan(_identity())
        self.scanner.fingerprint = "after"
        stable = self.cache.scan(_identity())

        self.assertEqual(raced["statistics"]["cache"]["status"], "bypass")  # type: ignore[index]
        self.assertEqual(
            raced["statistics"]["cache"]["bypassReason"],  # type: ignore[index]
            "manifest-changed-during-scan",
        )
        self.assertEqual(stable["statistics"]["cache"]["status"], "miss")  # type: ignore[index]
        self.assertEqual(self.scanner.scans, 2)

    def test_bypasses_results_larger_than_the_per_entry_memory_budget(self) -> None:
        self.scanner.padding = "x" * 2_000
        cache = DefinitionScanCache(
            self.scanner,  # type: ignore[arg-type]
            max_entries=2,
            ttl_seconds=30,
            max_entry_bytes=1_000,
            max_total_bytes=2_000,
            clock=self.clock,
        )
        first = cache.scan(_identity())
        second = cache.scan(_identity())

        self.assertEqual(first["statistics"]["cache"]["status"], "bypass")  # type: ignore[index]
        self.assertEqual(
            first["statistics"]["cache"]["bypassReason"],  # type: ignore[index]
            "result-byte-limit",
        )
        self.assertGreater(
            first["statistics"]["cache"]["resultBytes"],  # type: ignore[index]
            1_000,
        )
        self.assertEqual(second["statistics"]["cache"]["status"], "bypass")  # type: ignore[index]
        self.assertEqual(self.scanner.scans, 2)


if __name__ == "__main__":
    unittest.main()
