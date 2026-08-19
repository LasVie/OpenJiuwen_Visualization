from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.plugin_host import (
    OPENROUTER_HOST_PLUGIN_ID,
    TOOL_CATALOG_HOST_PLUGIN_ID,
    PluginHost,
    PluginHostError,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "sample_project"
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


class PluginHostTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="plugin-host-",
            dir=runtime_temp,
        )
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_bundled_plugins_are_trusted_and_secret_values_never_leave_host(self) -> None:
        secret = "not-for-descriptor"
        host = PluginHost(
            self.root / "host.sqlite3",
            secret_resolvers={"openrouter.default": lambda: bool(secret)},
        )

        descriptor = host.descriptor()
        encoded = json.dumps(descriptor, ensure_ascii=False)
        plugins = descriptor["host"]["plugins"]
        openrouter = next(
            plugin for plugin in plugins if plugin["id"] == OPENROUTER_HOST_PLUGIN_ID
        )

        self.assertEqual(descriptor["host"]["storage"]["journalMode"], "wal")
        self.assertEqual(openrouter["trust"]["level"], "bundled-trusted")
        self.assertTrue(openrouter["trust"]["automatic"])
        self.assertEqual(openrouter["status"], "active")
        self.assertTrue(openrouter["secretHandles"][0]["resolved"])
        self.assertEqual(
            openrouter["secretHandles"][0]["exposure"],
            "opaque-handle-only",
        )
        self.assertNotIn(secret, encoded)

    def test_revoked_permission_blocks_and_persists_without_recording_secrets(self) -> None:
        database = self.root / "host.sqlite3"
        host = PluginHost(database)
        host.set_permission(
            OPENROUTER_HOST_PLUGIN_ID,
            "network.openrouter.invoke",
            False,
        )

        restarted = PluginHost(database)
        authorization = restarted.authorize(OPENROUTER_HOST_PLUGIN_ID)
        audit = restarted.audit_events()

        self.assertFalse(authorization.allowed)
        self.assertEqual(authorization.code, "permission_required")
        self.assertEqual(audit["events"][0]["action"], "plugin.permission.changed")
        self.assertEqual(audit["events"][0]["detailCode"], "revoked")
        with self.assertRaises(PluginHostError) as context:
            restarted.set_permission(
                OPENROUTER_HOST_PLUGIN_ID,
                "provider.registry.read",
                False,
            )
        self.assertEqual(context.exception.code, "permission_policy_fixed")

    def test_unsigned_manifests_require_developer_scope_and_confirmation(self) -> None:
        manifest = self.root / "sample.openjiuwen-plugin.json"
        manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0.0",
                    "id": "local.example.observer",
                    "name": "Local observer",
                    "version": "0.1.0",
                    "description": "A declarative developer manifest.",
                    "group": "integration",
                    "capabilities": ["local.example.observe"],
                    "permissions": [
                        {
                            "id": "repository.example.read",
                            "label": "Read example metadata",
                            "description": "Read-only developer capability.",
                            "kind": "read",
                            "grantMode": "install",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        host = PluginHost(
            self.root / "host.sqlite3",
            allow_unsigned_plugins=True,
            developer_roots=[self.root],
        )
        plugin = next(
            item
            for item in host.descriptor()["host"]["plugins"]
            if item["id"] == "local.example.observer"
        )

        self.assertEqual(plugin["trust"]["level"], "unsigned-local")
        self.assertFalse(plugin["trust"]["executable"])
        self.assertEqual(plugin["runtime"]["mode"], "declarative-only")
        with self.assertRaises(PluginHostError) as context:
            host.set_enabled("local.example.observer", True)
        self.assertEqual(
            context.exception.code,
            "unsigned_plugin_confirmation_required",
        )
        host.set_enabled("local.example.observer", True, confirmed=True)
        self.assertEqual(
            host.authorize("local.example.observer").code,
            "permission_required",
        )
        host.set_permission(
            "local.example.observer",
            "repository.example.read",
            True,
        )
        self.assertTrue(host.authorize("local.example.observer").allowed)

    def test_api_uses_host_as_final_provider_and_tool_authority(self) -> None:
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
            archive_path=self.root / "archive.sqlite3",
            plugin_host_path=self.root / "host.sqlite3",
        )
        api = LocalRepositoryApi(config)
        disabled = api.dispatch(
            "POST",
            f"/api/v1/plugin-host/plugins/{OPENROUTER_HOST_PLUGIN_ID}/state",
            body={"enabled": False},
            origin=ALLOWED_ORIGIN,
        )
        provider = api.dispatch(
            "GET",
            "/api/v1/model-providers/openrouter",
            origin=ALLOWED_ORIGIN,
        )
        invocation = api.dispatch(
            "POST",
            "/api/v1/model-providers/openrouter/invocations",
            body={},
            origin=ALLOWED_ORIGIN,
        )
        tool_disabled = api.dispatch(
            "POST",
            f"/api/v1/plugin-host/plugins/{TOOL_CATALOG_HOST_PLUGIN_ID}/state",
            body={"enabled": False},
            origin=ALLOWED_ORIGIN,
        )
        tools = api.dispatch(
            "POST",
            "/api/v1/repositories/tools",
            body={"path": str(FIXTURE_ROOT)},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(disabled.status, 200)
        self.assertEqual(provider.body["provider"]["status"], "disabled")
        self.assertFalse(provider.body["provider"]["configured"])
        self.assertEqual(invocation.status, 503)
        self.assertEqual(invocation.body["error"]["code"], "plugin_disabled")
        self.assertEqual(tool_disabled.status, 200)
        self.assertEqual(tools.status, 503)


if __name__ == "__main__":
    unittest.main()
