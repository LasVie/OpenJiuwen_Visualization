from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.development_sessions import (
    DevelopmentSessionError,
    DevelopmentSessionStore,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
STAGES = (
    "intent",
    "scope",
    "evidence",
    "diagnosis",
    "impact",
    "change-plan",
    "test-plan",
    "patch-outline",
    "boundary",
)


def analysis(*, secret: str = "LOCAL-DEVELOPMENT-INTENT") -> dict:
    source = {
        "repository": "OpenJiuwen_Visualization",
        "path": "src/features/development-assistant/model.ts",
        "revision": "a" * 40,
        "symbol": "projectDevelopmentAnalysis",
        "startLine": 1,
        "endLine": 20,
    }
    return {
        "repository": {
            "id": "repository:visualization",
            "name": "OpenJiuwen_Visualization",
            "owner": "visualization",
            "path": str(REPOSITORY_ROOT),
            "scanScope": str(REPOSITORY_ROOT),
            "revision": "a" * 40,
            "branch": "main",
            "dirty": False,
        },
        "intent": f"{secret}，保持只读边界。",
        "terms": ["development", "session"],
        "evidence": [{
            "id": "evidence:one",
            "node": {
                "id": "node:one",
                "kind": "function",
                "plane": "definition",
                "level": 3,
                "owner": "visualization",
                "label": "projectDevelopmentAnalysis",
                "summary": "Deterministic projection.",
                "evidence": [{
                    "provenance": "static",
                    "confidence": "exact",
                    "source": source,
                }],
                "contributedBy": "test",
            },
            "source": source,
            "score": 100,
            "matchedTerms": ["development"],
            "confidence": "exact",
            "reason": "Exact symbol.",
        }],
        "impacts": [],
        "changes": [],
        "tests": [{
            "id": "test:one",
            "title": "Focused test",
            "detail": "Keep the contract.",
            "kind": "focused",
            "source": source,
            "evidenceLabel": "projectDevelopmentAnalysis",
        }],
        "patchOutlines": [{
            "id": "patch:one",
            "path": source["path"],
            "symbol": source["symbol"],
            "title": "Read-only outline",
            "preview": (
                "*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***\n"
                "*** Update File: src/features/development-assistant/model.ts"
            ),
            "applicable": False,
            "basis": "structural-outline",
        }],
        "stages": [
            {
                "id": f"development-stage:{kind}",
                "kind": kind,
                "ordinal": ordinal,
                "label": kind,
                "summary": "bounded",
            }
            for ordinal, kind in enumerate(STAGES, start=1)
        ],
        "diagnosis": "One exact definition.",
        "warnings": ["No repository write is available."],
        "readOnly": True,
        "repositoryWrite": False,
    }


class DevelopmentSessionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="development-sessions-")
        self.path = Path(self.temp.name) / "development.sqlite3"
        self.store = DevelopmentSessionStore(self.path)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_persists_metadata_and_requires_explicit_restore_for_full_analysis(self) -> None:
        created = self.store.create_session(analysis(), label="Session boundary")
        session_id = created["session"]["id"]
        listing = self.store.list_sessions()
        serialized_listing = json.dumps(listing, ensure_ascii=False)

        self.assertTrue(created["analysisStored"])
        self.assertEqual(listing["storage"]["journalMode"], "wal")
        self.assertEqual(listing["storage"]["databaseFile"], "development.sqlite3")
        self.assertEqual(listing["sessions"][0]["id"], session_id)
        self.assertNotIn("LOCAL-DEVELOPMENT-INTENT", serialized_listing)
        self.assertFalse(listing["fullAnalysisIncluded"])

        restored = self.store.get_session(session_id)
        exported = self.store.export_session(session_id)
        self.assertIn("LOCAL-DEVELOPMENT-INTENT", restored["analysis"]["intent"])
        self.assertTrue(restored["fullAnalysisIncluded"])
        self.assertTrue(restored["localOnly"])
        self.assertTrue(exported["containsFullAnalysis"])
        self.assertTrue(exported["localSource"])

        deleted = self.store.delete_session(session_id)
        self.assertTrue(deleted["deletedFullAnalysis"])
        with self.assertRaises(DevelopmentSessionError) as missing:
            self.store.get_session(session_id)
        self.assertEqual(missing.exception.status, 404)

    def test_reopens_an_existing_schema_without_losing_sessions(self) -> None:
        created = self.store.create_session(analysis())
        reopened = DevelopmentSessionStore(self.path)

        restored = reopened.get_session(created["session"]["id"])
        self.assertEqual(restored["analysis"]["repository"]["branch"], "main")
        self.assertEqual(reopened.descriptor()["schemaVersion"], 1)

    def test_rejects_write_semantics_and_unbounded_source_paths(self) -> None:
        writable = analysis()
        writable["repositoryWrite"] = True
        with self.assertRaises(DevelopmentSessionError) as write_error:
            self.store.create_session(writable)
        self.assertEqual(write_error.exception.code, "development_write_forbidden")

        applicable = analysis()
        applicable["patchOutlines"][0]["applicable"] = True
        with self.assertRaises(DevelopmentSessionError) as patch_error:
            self.store.create_session(applicable)
        self.assertEqual(patch_error.exception.code, "development_write_forbidden")

        traversal = analysis()
        traversal["evidence"][0]["source"]["path"] = "../outside.py"
        with self.assertRaises(DevelopmentSessionError) as path_error:
            self.store.create_session(traversal)
        self.assertEqual(path_error.exception.code, "invalid_development_session")

        nested_traversal = analysis()
        nested_traversal["changes"] = [{
            "id": "change:one",
            "target": {
                **nested_traversal["evidence"][0],
                "source": {
                    **nested_traversal["evidence"][0]["source"],
                    "path": "../nested.py",
                },
            },
        }]
        with self.assertRaises(DevelopmentSessionError) as nested_path_error:
            self.store.create_session(nested_traversal)
        self.assertEqual(
            nested_path_error.exception.code, "invalid_development_session"
        )


if __name__ == "__main__":
    unittest.main()
