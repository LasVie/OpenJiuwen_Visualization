from __future__ import annotations

import json
import threading
import unittest
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator

from openjiuwen_visualization_server.app import LocalRepositoryApi
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.openrouter_provider import (
    OPENROUTER_CHAT_COMPLETIONS_URL,
    OpenRouterChatRequest,
    OpenRouterHttpTransport,
    OpenRouterProviderConfig,
    OpenRouterProviderError,
    OpenRouterRuntimeAdapter,
)
from openjiuwen_visualization_server.trace_store import RuntimeTraceStore


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALLOWED_ORIGIN = "http://127.0.0.1:4173"


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = BytesIO(body)
        self.headers = {
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Generation-Id": "gen-test-1",
        }
        self.status = 200
        self.closed = False

    def readline(self, maximum: int = -1) -> bytes:
        return self._body.readline(maximum)

    def read(self, maximum: int = -1) -> bytes:
        return self._body.read(maximum)

    def geturl(self) -> str:
        return OPENROUTER_CHAT_COMPLETIONS_URL

    def close(self) -> None:
        self.closed = True


class FakeOpener:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.request: Any = None
        self.timeout: float | None = None

    def open(self, request: Any, *, timeout: float) -> FakeResponse:
        self.request = request
        self.timeout = timeout
        return self.response


class StaticStream:
    generation_id = "gen-static"

    def __init__(self, frames: list[dict[str, Any]]) -> None:
        self.frames = frames
        self.closed = False

    def __iter__(self) -> Iterator[dict[str, Any]]:
        yield from self.frames

    def close(self) -> None:
        self.closed = True


class StaticTransport:
    def __init__(self, stream: StaticStream) -> None:
        self.stream = stream
        self.request: OpenRouterChatRequest | None = None

    def open_stream(self, request: OpenRouterChatRequest) -> StaticStream:
        self.request = request
        return self.stream


class BlockingStream:
    generation_id = "gen-blocking"

    def __init__(self) -> None:
        self.started = threading.Event()
        self.closed = threading.Event()

    def __iter__(self) -> Iterator[dict[str, Any]]:
        yield {
            "model": "test/resolved",
            "choices": [{"delta": {"content": "partial"}}],
        }
        self.started.set()
        self.closed.wait(2)
        raise OSError("stream closed")

    def close(self) -> None:
        self.closed.set()


class BlockingTransport:
    def __init__(self, stream: BlockingStream) -> None:
        self.stream = stream

    def open_stream(self, request: OpenRouterChatRequest) -> BlockingStream:
        return self.stream


class BlockingBeforeFirstFrameStream:
    generation_id = "gen-before-first-frame"

    def __init__(self) -> None:
        self.iteration_started = threading.Event()
        self.closed = threading.Event()

    def __iter__(self) -> Iterator[dict[str, Any]]:
        self.iteration_started.set()
        self.closed.wait(2)
        if False:
            yield {}

    def close(self) -> None:
        self.closed.set()


class DelayedOpenTransport:
    def __init__(self, stream: BlockingBeforeFirstFrameStream) -> None:
        self.stream = stream
        self.started = threading.Event()
        self.release = threading.Event()

    def open_stream(
        self,
        request: OpenRouterChatRequest,
    ) -> BlockingBeforeFirstFrameStream:
        self.started.set()
        self.release.wait(2)
        return self.stream


class OpenRouterProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RuntimeTraceStore()
        self.trace, self.trace_token = self.store.create(
            owner="agent-core",
            label="OpenRouter test",
            max_tokens=8_192,
        )

    def test_environment_config_registers_an_allowlist_without_exposing_the_key(self) -> None:
        config = OpenRouterProviderConfig.from_environment(
            {
                "OPENROUTER_API_KEY": "sk-or-test-secret",
                "OPENJIUWEN_OPENROUTER_MODELS": "openrouter/free, openai/test-model,openrouter/free",
                "OPENJIUWEN_OPENROUTER_DEFAULT_MODEL": "openai/test-model",
                "OPENJIUWEN_OPENROUTER_SITE_URL": "https://visualization.example",
            }
        )

        descriptor = config.public_descriptor()

        self.assertTrue(config.configured)
        self.assertEqual(config.models, ("openrouter/free", "openai/test-model"))
        self.assertEqual(descriptor["provider"]["defaultModelId"], "openai/test-model")
        self.assertNotIn("sk-or-test-secret", json.dumps(descriptor))
        self.assertNotIn("apiKey", json.dumps(descriptor))

    def test_defaults_to_the_free_router_and_reports_unconfigured(self) -> None:
        config = OpenRouterProviderConfig.from_environment({})

        self.assertFalse(config.configured)
        self.assertEqual(config.models, ("openrouter/free",))
        self.assertEqual(config.public_descriptor()["provider"]["status"], "unconfigured")

    def test_http_transport_uses_fixed_endpoint_and_parses_comments(self) -> None:
        response = FakeResponse(
            b": OPENROUTER PROCESSING\n\n"
            b"data: {\"model\":\"test/resolved\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n"
            b"data: [DONE]\n\n"
        )
        opener = FakeOpener(response)
        config = OpenRouterProviderConfig(api_key="server-secret")
        transport = OpenRouterHttpTransport(config, opener=opener)  # type: ignore[arg-type]

        stream = transport.open_stream(
            OpenRouterChatRequest(
                model_id="openrouter/free",
                input_text="hello",
                system_prompt=None,
                max_output_tokens=64,
            )
        )
        frames = list(stream)

        self.assertEqual(len(frames), 2)
        self.assertEqual(stream.generation_id, "gen-test-1")
        self.assertEqual(opener.request.full_url, OPENROUTER_CHAT_COMPLETIONS_URL)
        self.assertEqual(opener.request.get_header("Authorization"), "Bearer server-secret")
        payload = json.loads(opener.request.data)
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["model"], "openrouter/free")
        self.assertNotIn("stream_options", payload)
        self.assertNotIn("usage", payload)

    def test_successful_stream_becomes_context_model_usage_and_terminal_events(self) -> None:
        stream = StaticStream(
            [
                {
                    "model": "test/resolved-model",
                    "choices": [{"delta": {"content": "Hello "}}],
                },
                {
                    "model": "test/resolved-model",
                    "choices": [{"delta": {"content": "world"}}],
                },
                {
                    "model": "test/resolved-model",
                    "choices": [{"delta": {}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": 7,
                        "completion_tokens": 2,
                        "total_tokens": 9,
                        "prompt_tokens_details": {"cached_tokens": 3},
                        "completion_tokens_details": {"reasoning_tokens": 1},
                        "cost": 0.0001234,
                    },
                },
            ]
        )
        transport = StaticTransport(stream)
        adapter = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="server-only-secret", models=("test/model",), default_model="test/model"),
            self.store,
            transport=transport,
        )

        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "modelId": "test/model",
                "input": "full user prompt",
                "systemPrompt": "system policy",
                "maxOutputTokens": 64,
            },
            self.trace_token,
        )
        invocation_id = accepted["invocation"]["id"]
        self.assertTrue(adapter.wait_for_terminal(invocation_id))
        metadata, events = self.store.snapshot(self.trace["id"])

        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(
            [event["kind"] for event in events],
            [
                "agent.user_message",
                "context.snapshot",
                "model.call",
                "model.stream",
                "model.stream",
                "model.usage",
                "model.call",
                "context.delta",
                "trace.status",
            ],
        )
        self.assertEqual(events[1]["context"]["messages"][1]["raw"], "full user prompt")
        self.assertEqual(events[5]["model"]["usage"]["costMicros"], 123)
        self.assertEqual(events[5]["model"]["usage"]["cachedInputTokens"], 3)
        self.assertEqual(events[7]["context"]["messages"][0]["raw"], "Hello world")
        self.assertEqual(events[6]["details"][0]["value"], "test/resolved-model")
        self.assertTrue(stream.closed)
        self.assertNotIn("server-only-secret", json.dumps(events))
        self.assertEqual(transport.request.max_output_tokens, 64)

    def test_cancellation_closes_the_upstream_stream_and_preserves_partial_output(self) -> None:
        stream = BlockingStream()
        adapter = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="secret"),
            self.store,
            transport=BlockingTransport(stream),
        )
        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "input": "cancel this request",
                "maxOutputTokens": 64,
            },
            self.trace_token,
        )
        invocation_id = accepted["invocation"]["id"]
        self.assertTrue(stream.started.wait(1))

        cancelled = adapter.cancel(invocation_id, self.trace_token)

        self.assertEqual(cancelled["invocation"]["status"], "cancelling")
        self.assertTrue(adapter.wait_for_terminal(invocation_id))
        metadata, events = self.store.snapshot(self.trace["id"])
        self.assertEqual(metadata["status"], "completed")
        self.assertIn("model.cancel", [event["kind"] for event in events])
        partial_context = [
            event
            for event in events
            if event["kind"] == "context.delta"
        ][0]
        self.assertEqual(partial_context["context"]["messages"][0]["raw"], "partial")
        self.assertTrue(stream.closed.is_set())

    def test_cancellation_during_connect_stops_before_waiting_for_the_first_frame(self) -> None:
        stream = BlockingBeforeFirstFrameStream()
        transport = DelayedOpenTransport(stream)
        adapter = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="secret"),
            self.store,
            transport=transport,
        )
        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "input": "cancel while connecting",
                "maxOutputTokens": 64,
            },
            self.trace_token,
        )
        invocation_id = accepted["invocation"]["id"]
        self.assertTrue(transport.started.wait(1))

        adapter.cancel(invocation_id, self.trace_token)
        transport.release.set()

        self.assertTrue(adapter.wait_for_terminal(invocation_id, 0.5))
        self.assertFalse(stream.iteration_started.is_set())
        self.assertTrue(stream.closed.is_set())
        _, events = self.store.snapshot(self.trace["id"])
        self.assertIn("model.cancel", [event["kind"] for event in events])

    def test_upstream_error_closes_the_trace_without_copying_error_text_into_metadata(self) -> None:
        stream = StaticStream(
            [
                {"choices": [{"delta": {"content": "partial"}}]},
                {
                    "error": {
                        "code": "provider_failed",
                        "message": "echoed confidential prompt",
                        "metadata": {"error_type": "server"},
                    }
                },
            ]
        )
        adapter = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="secret"),
            self.store,
            transport=StaticTransport(stream),
        )
        accepted = adapter.start(
            {
                "traceId": self.trace["id"],
                "input": "confidential prompt",
                "maxOutputTokens": 64,
            },
            self.trace_token,
        )

        self.assertTrue(adapter.wait_for_terminal(accepted["invocation"]["id"]))
        metadata, events = self.store.snapshot(self.trace["id"])
        model_error = next(
            event
            for event in events
            if event["kind"] == "model.call" and event["phase"] == "error"
        )
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(model_error["details"][0]["value"], "openrouter_server")
        self.assertNotIn("echoed confidential prompt", model_error["summary"])
        self.assertNotIn("echoed confidential prompt", json.dumps(model_error))

    def test_rejects_missing_configuration_tokens_and_unregistered_models(self) -> None:
        unconfigured = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key=None),
            self.store,
            transport=StaticTransport(StaticStream([])),
        )
        with self.assertRaisesRegex(OpenRouterProviderError, "OPENJIUWEN_OPENROUTER_API_KEY"):
            unconfigured.start(
                {"traceId": self.trace["id"], "input": "hello"},
                self.trace_token,
            )

        configured = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="secret"),
            self.store,
            transport=StaticTransport(StaticStream([])),
        )
        with self.assertRaises(OpenRouterProviderError) as invalid_token:
            configured.start(
                {"traceId": self.trace["id"], "input": "hello"},
                "wrong-token",
            )
        self.assertEqual(invalid_token.exception.code, "invalid_trace_token")
        with self.assertRaises(OpenRouterProviderError) as invalid_model:
            configured.start(
                {
                    "traceId": self.trace["id"],
                    "modelId": "paid/not-registered",
                    "input": "hello",
                },
                self.trace_token,
            )
        self.assertEqual(invalid_model.exception.code, "openrouter_model_not_allowed")

    def test_loopback_api_exposes_registry_and_invocation_route(self) -> None:
        stream = StaticStream(
            [
                {
                    "choices": [{"delta": {"content": "API response"}}],
                },
                {
                    "choices": [{"delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4},
                },
            ]
        )
        adapter = OpenRouterRuntimeAdapter(
            OpenRouterProviderConfig(api_key="secret"),
            self.store,
            transport=StaticTransport(stream),
        )
        api = LocalRepositoryApi(
            LocalServiceConfig.create(
                allowed_roots=[REPOSITORY_ROOT],
                allowed_origins=[ALLOWED_ORIGIN],
            ),
            trace_store=self.store,
            openrouter_adapter=adapter,
        )

        registry = api.dispatch(
            "GET",
            "/api/v1/model-providers/openrouter",
            origin=ALLOWED_ORIGIN,
        )
        accepted = api.dispatch(
            "POST",
            "/api/v1/model-providers/openrouter/invocations",
            body={
                "traceId": self.trace["id"],
                "input": "API prompt",
                "maxOutputTokens": 64,
            },
            origin=ALLOWED_ORIGIN,
            trace_token=self.trace_token,
        )

        self.assertEqual(registry.status, 200)
        self.assertTrue(registry.body["provider"]["configured"])
        self.assertEqual(accepted.status, 202)
        invocation_id = accepted.body["invocation"]["id"]
        self.assertTrue(adapter.wait_for_terminal(invocation_id))


if __name__ == "__main__":
    unittest.main()
