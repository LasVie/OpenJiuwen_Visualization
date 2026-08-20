from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.openrouter_credentials import (
    OPENROUTER_SECRET_HANDLE_ID,
    OpenRouterCredentialController,
    OpenRouterCredentialError,
)
from openjiuwen_visualization_server.openrouter_provider import (
    OpenRouterProviderConfig,
    OpenRouterRuntimeAdapter,
)
from openjiuwen_visualization_server.secret_store import (
    MemorySecretStore,
    UnavailableSecretStore,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


class OpenRouterCredentialControllerTests(unittest.TestCase):
    def test_system_credential_wins_and_value_never_enters_descriptor_or_repr(self) -> None:
        secret = "sk-or-system-secret"
        config = OpenRouterProviderConfig(api_key="injected-secret")
        controller = OpenRouterCredentialController(
            config,
            MemorySecretStore({OPENROUTER_SECRET_HANDLE_ID: secret}),
            environment={"OPENROUTER_API_KEY": "environment-secret"},
        )

        descriptor = controller.descriptor()
        encoded = json.dumps(descriptor)

        self.assertEqual(config.api_key, secret)
        self.assertEqual(descriptor["credential"]["source"], "system-credential")
        self.assertTrue(descriptor["credential"]["configured"])
        self.assertEqual(descriptor["credential"]["exposure"], "write-only")
        self.assertNotIn(secret, encoded)
        self.assertNotIn(secret, repr(config))

    def test_set_is_immediate_and_delete_restores_environment_fallback(self) -> None:
        config = OpenRouterProviderConfig(api_key=None)
        store = MemorySecretStore()
        controller = OpenRouterCredentialController(
            config,
            store,
            environment={"OPENJIUWEN_OPENROUTER_API_KEY": "environment-secret"},
        )

        saved = controller.set("  sk-or-web-configured  ")
        self.assertEqual(config.api_key, "sk-or-web-configured")
        self.assertEqual(saved["credential"]["source"], "system-credential")
        self.assertTrue(saved["credential"]["canDelete"])

        deleted = controller.delete()
        self.assertEqual(config.api_key, "environment-secret")
        self.assertEqual(deleted["credential"]["source"], "environment")
        self.assertFalse(deleted["credential"]["canDelete"])

    def test_unavailable_store_and_unmanaged_delete_fail_closed(self) -> None:
        controller = OpenRouterCredentialController(
            OpenRouterProviderConfig(api_key=None),
            UnavailableSecretStore(),
            environment={},
        )

        with self.assertRaises(OpenRouterCredentialError) as write_context:
            controller.set("sk-or-secret")
        self.assertEqual(write_context.exception.code, "secret_store_unavailable")
        with self.assertRaises(OpenRouterCredentialError) as delete_context:
            controller.delete()
        self.assertEqual(delete_context.exception.code, "credential_not_managed")


class OpenRouterCredentialApiTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime_temp = REPOSITORY_ROOT / ".runtime-temp"
        runtime_temp.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="openrouter-settings-",
            dir=runtime_temp,
        )
        root = Path(self.temporary.name)
        config = LocalServiceConfig.create(
            allowed_roots=[REPOSITORY_ROOT],
            allowed_origins=[ALLOWED_ORIGIN],
            archive_path=root / "archive.sqlite3",
            development_session_path=root / "development.sqlite3",
            development_execution_path=root / "executions.sqlite3",
            development_worktree_root=root / "worktrees",
            plugin_host_path=root / "plugin-host.sqlite3",
        )
        provider = OpenRouterProviderConfig(api_key=None)
        self.controller = OpenRouterCredentialController(
            provider,
            MemorySecretStore(),
            environment={},
        )
        self.api = LocalRepositoryApi(
            config,
            openrouter_credentials=self.controller,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_write_only_settings_route_updates_provider_and_audits_metadata(self) -> None:
        secret = "sk-or-api-route-secret"
        initial = self.api.dispatch("GET", "/api/v1/settings", origin=ALLOWED_ORIGIN)
        saved = self.api.dispatch(
            "POST",
            "/api/v1/settings/openrouter/credential",
            body={"apiKey": secret},
            origin=ALLOWED_ORIGIN,
        )
        provider = self.api.dispatch(
            "GET",
            "/api/v1/model-providers/openrouter",
            origin=ALLOWED_ORIGIN,
        )
        audit = self.api.dispatch(
            "GET",
            "/api/v1/plugin-host/audit",
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(initial.status, 200)
        self.assertFalse(initial.body["settings"]["openRouter"]["configured"])
        self.assertEqual(saved.status, 200)
        self.assertTrue(saved.body["credential"]["configured"])
        self.assertTrue(provider.body["provider"]["configured"])
        encoded = json.dumps(
            {"saved": saved.body, "provider": provider.body, "audit": audit.body}
        )
        self.assertNotIn(secret, encoded)
        self.assertEqual(
            audit.body["events"][-1]["action"],
            "plugin.secret.stored",
        )

        deleted = self.api.dispatch(
            "DELETE",
            "/api/v1/settings/openrouter/credential",
            origin=ALLOWED_ORIGIN,
        )
        self.assertEqual(deleted.status, 200)
        self.assertFalse(deleted.body["credential"]["configured"])

    def test_invalid_payload_never_echoes_credential(self) -> None:
        secret = "sk-or-should-not-return"
        response = self.api.dispatch(
            "POST",
            "/api/v1/settings/openrouter/credential",
            body={"apiKey": secret, "unexpected": secret},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(response.status, 400)
        self.assertNotIn(secret, json.dumps(response.body))

    def test_active_invocation_blocks_replacement(self) -> None:
        provider = self.controller.config
        busy_adapter = OpenRouterRuntimeAdapter(provider, RuntimeTraceStore())
        busy_adapter._jobs["busy"] = type(  # type: ignore[attr-defined]
            "BusyJob",
            (),
            {"state": "running"},
        )()
        self.api.openrouter_adapter = busy_adapter

        response = self.api.dispatch(
            "POST",
            "/api/v1/settings/openrouter/credential",
            body={"apiKey": "sk-or-replacement"},
            origin=ALLOWED_ORIGIN,
        )

        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"]["code"], "provider_busy")


if __name__ == "__main__":
    unittest.main()
