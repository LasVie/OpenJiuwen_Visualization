from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi, create_http_server
from openjiuwen_visualization_server.config import LocalServiceConfig


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "sample_project"
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


def development_analysis() -> dict:
    source = {
        "repository": "OpenJiuwen_Visualization",
        "path": "src/features/development-assistant/model.ts",
        "revision": "b" * 40,
        "symbol": "projectDevelopmentAnalysis",
    }
    stage_kinds = (
        "intent", "scope", "evidence", "diagnosis", "impact",
        "change-plan", "test-plan", "patch-outline", "boundary",
    )
    return {
        "repository": {
            "id": "repository:visualization",
            "name": "OpenJiuwen_Visualization",
            "owner": "visualization",
            "path": str(REPOSITORY_ROOT),
            "scanScope": str(REPOSITORY_ROOT),
            "revision": "b" * 40,
            "branch": "main",
            "dirty": False,
        },
        "intent": "API-DEVELOPMENT-RAW-INTENT",
        "terms": ["development"],
        "evidence": [{
            "id": "evidence:one",
            "node": {
                "id": "node:one",
                "label": "analysis",
                "evidence": [{"source": source}],
            },
            "source": source,
            "score": 1,
            "matchedTerms": ["development"],
            "confidence": "exact",
            "reason": "exact",
        }],
        "impacts": [],
        "changes": [],
        "tests": [],
        "patchOutlines": [{
            "id": "patch:one",
            "path": source["path"],
            "title": "outline",
            "preview": "*** READ-ONLY STRUCTURAL OUTLINE — NOT AN APPLICABLE PATCH ***",
            "applicable": False,
            "basis": "structural-outline",
        }],
        "stages": [
            {
                "id": f"development-stage:{kind}",
                "kind": kind,
                "ordinal": index,
                "label": kind,
                "summary": "bounded",
            }
            for index, kind in enumerate(stage_kinds, start=1)
        ],
        "diagnosis": "One exact definition.",
        "warnings": [],
        "readOnly": True,
        "repositoryWrite": False,
    }


class LocalRepositoryApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        cls.archive_temp = tempfile.TemporaryDirectory(
            prefix="archive-api-",
            dir=runtime_temp,
        )
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
            archive_path=Path(cls.archive_temp.name) / "archive.sqlite3",
            development_session_path=(
                Path(cls.archive_temp.name) / "development-sessions.sqlite3"
            ),
        )
        cls.api = LocalRepositoryApi(config)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.archive_temp.cleanup()

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
        self.assertIn("repository.tools.read", health.body["capabilities"])
        self.assertIn("repository.source.read", health.body["capabilities"])
        self.assertIn("repository.scan.cache.memory", health.body["capabilities"])
        self.assertIn("github.pull-request.read", health.body["capabilities"])
        self.assertIn("trace.archive.sqlite", health.body["capabilities"])
        self.assertIn("development.session.sqlite", health.body["capabilities"])
        self.assertEqual(health.body["traceStorage"], "memory-live+sqlite-archive")
        self.assertEqual(health.body["archiveStorage"]["journalMode"], "wal")
        self.assertEqual(
            health.body["developmentSessionStorage"]["journalMode"], "wal"
        )

    def test_persists_restores_exports_and_deletes_development_sessions(self) -> None:
        created = self.api.dispatch(
            "POST",
            "/api/v1/development/sessions",
            body={"analysis": development_analysis(), "label": "API session"},
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(created.status, 201)
        session_id = created.body["session"]["id"]

        listing = self.api.dispatch(
            "GET",
            "/api/v1/development/sessions?limit=100&offset=0",
            origin=ALLOWED_ORIGIN,
        )
        restored = self.api.dispatch(
            "GET",
            f"/api/v1/development/sessions/{session_id}",
            origin=ALLOWED_ORIGIN,
        )
        exported = self.api.dispatch(
            "GET",
            f"/api/v1/development/sessions/{session_id}/export",
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(listing.status, 200)
        self.assertNotIn(
            "API-DEVELOPMENT-RAW-INTENT",
            json.dumps(listing.body, ensure_ascii=False),
        )
        self.assertEqual(restored.status, 200)
        self.assertEqual(
            restored.body["analysis"]["intent"], "API-DEVELOPMENT-RAW-INTENT"
        )
        self.assertTrue(exported.body["containsFullAnalysis"])

        deleted = self.api.dispatch(
            "DELETE",
            f"/api/v1/development/sessions/{session_id}",
            origin=ALLOWED_ORIGIN,
        )
        missing = self.api.dispatch(
            "GET",
            f"/api/v1/development/sessions/{session_id}",
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(deleted.status, 200)
        self.assertTrue(deleted.body["deletedFullAnalysis"])
        self.assertEqual(missing.status, 404)

    def test_rejects_development_sessions_outside_authorized_repository_scope(self) -> None:
        payload = development_analysis()
        payload["repository"]["path"] = str(REPOSITORY_ROOT.parent)
        response = self.api.dispatch(
            "POST",
            "/api/v1/development/sessions",
            body={"analysis": payload},
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(response.body["error"]["code"], "path_not_allowed")

    def test_reuses_a_validated_memory_only_definition_scan(self) -> None:
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
        )
        api = LocalRepositoryApi(config, archive_enabled=False)
        first = api.dispatch(
            "POST",
            "/api/v1/repositories/scan",
            body={"path": str(FIXTURE_ROOT)},
            origin=ALLOWED_ORIGIN,
        )
        second = api.dispatch(
            "POST",
            "/api/v1/repositories/scan",
            body={"path": str(FIXTURE_ROOT)},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(first.status, 200)
        self.assertEqual(first.body["statistics"]["cache"]["status"], "miss")
        self.assertEqual(second.body["statistics"]["cache"]["status"], "hit")
        self.assertEqual(
            first.body["graph"]["nodes"],
            second.body["graph"]["nodes"],
        )

    def test_reports_static_tool_catalog_without_importing_target_code(self) -> None:
        catalog = self.api.dispatch(
            "POST",
            "/api/v1/repositories/tools",
            body={"path": str(FIXTURE_ROOT), "options": {"includeTests": False}},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(catalog.status, 200)
        self.assertEqual(catalog.body["schemaVersion"], "1.0.0")
        self.assertFalse(catalog.body["writeOperations"])
        self.assertGreaterEqual(catalog.body["statistics"]["tools"], 3)
        self.assertTrue(
            any(tool["name"] == "weather_lookup" for tool in catalog.body["tools"])
        )

    def test_reads_a_bounded_source_excerpt_inside_the_selected_repository(self) -> None:
        source = self.api.dispatch(
            "POST",
            "/api/v1/repositories/source",
            body={
                "path": str(REPOSITORY_ROOT),
                "relativePath": "services/local-server/tests/fixtures/sample_project/openjiuwen/deep_agent.py",
                "startLine": 10,
                "endLine": 13,
                "revision": "not-the-current-revision",
                "options": {"contextLines": 2, "maxLines": 30},
            },
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(source.status, 200)
        self.assertEqual(source.body["source"]["language"], "python")
        self.assertFalse(source.body["source"]["revisionMatches"])
        self.assertEqual(source.body["range"]["focusStartLine"], 10)
        self.assertTrue(source.body["readOnly"])
        self.assertFalse(source.body["writeOperations"])

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

    def test_reports_worktree_changes_without_git_writes(self) -> None:
        changes = self.api.dispatch(
            "POST",
            "/api/v1/repositories/changes",
            body={
                "path": str(REPOSITORY_ROOT),
                "mode": "working-tree",
                "options": {"includeUntracked": True, "maxFiles": 100},
            },
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(changes.status, 200)
        self.assertEqual(changes.body["apiVersion"], "1.0.0")
        self.assertEqual(changes.body["comparison"]["mode"], "working-tree")
        self.assertFalse(changes.body["writeOperations"])
        self.assertIsInstance(changes.body["files"], list)

    def test_routes_structured_github_pull_request_reads_through_the_server_adapter(self) -> None:
        captured: dict[str, object] = {}

        class StubGitHubInspector:
            def inspect(self, identity, reference, options):  # type: ignore[no-untyped-def]
                captured.update(
                    identity=identity,
                    reference=reference,
                    options=options,
                )
                return {
                    "apiVersion": "1.0.0",
                    "repository": identity.to_api_dict(),
                    "comparison": {
                        "mode": "github-pr",
                        "base": {"requested": "develop", "resolved": "1" * 40},
                        "head": {"requested": "feature", "resolved": "2" * 40},
                        "mergeBase": None,
                    },
                    "pullRequest": {"number": reference.number},
                    "files": [],
                    "statistics": {
                        "files": 0,
                        "additions": 0,
                        "deletions": 0,
                        "binaryFiles": 0,
                        "truncated": False,
                    },
                    "warnings": [],
                    "remoteOperations": {
                        "networkRead": True,
                        "mutation": False,
                        "authenticated": False,
                    },
                    "writeOperations": False,
                }

        api = LocalRepositoryApi(
            self.api.config,
            github_pull_request_inspector=StubGitHubInspector(),  # type: ignore[arg-type]
            archive_enabled=False,
        )
        response = api.dispatch(
            "POST",
            "/api/v1/repositories/github/pull-request",
            body={
                "path": str(REPOSITORY_ROOT),
                "owner": "LasVie",
                "repository": "agent-core",
                "pullNumber": 42,
                "options": {"maxFiles": 125},
            },
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["comparison"]["mode"], "github-pr")
        self.assertEqual(captured["reference"].owner, "LasVie")
        self.assertEqual(captured["reference"].number, 42)
        self.assertEqual(captured["options"].max_files, 125)

    def test_creates_memory_only_trace_and_accepts_token_scoped_events(self) -> None:
        created = self.api.dispatch(
            "POST",
            "/api/v1/traces",
            body={"owner": "agent-core", "label": "API trace", "maxTokens": 16384},
            origin=ALLOWED_ORIGIN,
        )
        trace = created.body["trace"]
        write_token = created.body["writeToken"]
        appended = self.api.dispatch(
            "POST",
            f"/api/v1/traces/{trace['id']}/events",
            body={
                "events": [
                    {
                        "eventId": "invoke-1",
                        "kind": "agent.invoke",
                        "phase": "start",
                        "timestampMs": 0,
                        "spanId": "invoke",
                    }
                ]
            },
            origin=ALLOWED_ORIGIN,
            trace_token=write_token,
        )
        snapshot = self.api.dispatch(
            "GET",
            f"/api/v1/traces/{trace['id']}?after=0",
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(created.status, 201)
        self.assertEqual(created.body["storage"], "memory-only")
        self.assertEqual(appended.status, 202)
        self.assertEqual(appended.body["accepted"], 1)
        self.assertEqual(snapshot.body["events"][0]["kind"], "agent.invoke")

        denied = self.api.dispatch(
            "POST",
            f"/api/v1/traces/{trace['id']}/events",
            body={"events": [{"eventId": "missing"}]},
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(denied.status, 403)

    def test_archive_routes_default_to_redacted_and_gate_full_local_text(self) -> None:
        created = self.api.dispatch(
            "POST",
            "/api/v1/traces",
            body={"owner": "agent-core", "label": "Archive API trace", "maxTokens": 8192},
            origin=ALLOWED_ORIGIN,
        )
        trace = created.body["trace"]
        token = created.body["writeToken"]
        appended = self.api.dispatch(
            "POST",
            f"/api/v1/traces/{trace['id']}/events",
            body={
                "events": [
                    {
                        "eventId": "raw-context",
                        "kind": "context.delta",
                        "phase": "instant",
                        "timestampMs": 1,
                        "spanId": "context",
                        "summary": "用户消息已加入 Context；正文默认隐藏。",
                        "context": {
                            "operation": "append",
                            "messages": [
                                {
                                    "id": "user-1",
                                    "role": "user",
                                    "label": "User input",
                                    "raw": "API-RAW-SECRET",
                                    "preview": "用户请求（已脱敏）",
                                    "tokens": 5,
                                    "source": "runtime.input",
                                }
                            ],
                        },
                    },
                    {
                        "eventId": "archive-terminal",
                        "kind": "trace.status",
                        "phase": "end",
                        "timestampMs": 2,
                        "spanId": "trace",
                        "summary": "运行完成。",
                    },
                ]
            },
            origin=ALLOWED_ORIGIN,
            trace_token=token,
        )
        listing = self.api.dispatch(
            "GET",
            "/api/v1/archive/sessions?limit=100&offset=0",
            origin=ALLOWED_ORIGIN,
        )
        preview = self.api.dispatch(
            "GET",
            f"/api/v1/archive/sessions/{trace['id']}",
            origin=ALLOWED_ORIGIN,
        )
        raw = self.api.dispatch(
            "POST",
            f"/api/v1/archive/sessions/{trace['id']}/raw",
            body={"mode": "context"},
            origin=ALLOWED_ORIGIN,
        )
        exported = self.api.dispatch(
            "GET",
            f"/api/v1/archive/sessions/{trace['id']}/export",
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(appended.status, 202)
        self.assertTrue(appended.body["archived"])
        self.assertEqual(listing.status, 200)
        self.assertTrue(any(item["id"] == trace["id"] for item in listing.body["sessions"]))
        self.assertNotIn("API-RAW-SECRET", json.dumps(preview.body, ensure_ascii=False))
        self.assertFalse(preview.body["rawIncluded"])
        self.assertIn("API-RAW-SECRET", json.dumps(raw.body, ensure_ascii=False))
        self.assertTrue(raw.body["rawIncluded"])
        self.assertIn("API-RAW-SECRET", json.dumps(exported.body, ensure_ascii=False))
        self.assertTrue(exported.body["containsFullText"])

        deleted = self.api.dispatch(
            "DELETE",
            f"/api/v1/archive/sessions/{trace['id']}",
            origin=ALLOWED_ORIGIN,
        )
        missing = self.api.dispatch(
            "GET",
            f"/api/v1/archive/sessions/{trace['id']}",
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(deleted.status, 200)
        self.assertTrue(deleted.body["deletedFullText"])
        self.assertEqual(missing.status, 404)

    def test_http_stream_delivers_ordered_event_and_terminal_frame(self) -> None:
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
            archive_path=Path(self.archive_temp.name) / "http-archive.sqlite3",
        )
        server = create_http_server(config, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
        try:
            connection.request(
                "POST",
                "/api/v1/traces",
                body=json.dumps({"owner": "agent-core", "label": "SSE trace"}),
                headers={"Content-Type": "application/json", "Origin": ALLOWED_ORIGIN},
            )
            created_response = connection.getresponse()
            created = json.loads(created_response.read())
            trace_id = created["trace"]["id"]
            token = created["writeToken"]

            connection.request(
                "POST",
                f"/api/v1/traces/{trace_id}/events",
                body=json.dumps(
                    {
                        "events": [
                            {
                                "eventId": "terminal",
                                "kind": "trace.status",
                                "phase": "end",
                                "timestampMs": 25,
                                "spanId": "trace",
                            }
                        ]
                    }
                ),
                headers={
                    "Content-Type": "application/json",
                    "Origin": ALLOWED_ORIGIN,
                    "X-Trace-Token": token,
                },
            )
            appended_response = connection.getresponse()
            appended_response.read()

            connection.request(
                "GET",
                f"/api/v1/traces/{trace_id}/stream?after=0",
                headers={"Origin": ALLOWED_ORIGIN},
            )
            stream_response = connection.getresponse()
            stream_body = stream_response.read().decode("utf-8")

            self.assertEqual(stream_response.status, 200)
            self.assertEqual(stream_response.getheader("Content-Type"), "text/event-stream; charset=utf-8")
            self.assertIn("event: trace.event", stream_body)
            self.assertIn('"sequence":1', stream_body)
            self.assertIn("event: trace.end", stream_body)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
