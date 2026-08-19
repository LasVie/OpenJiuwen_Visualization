"""Server-only OpenRouter adapter that projects chat streams into Runtime Trace V1."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http import HTTPStatus
from typing import Any, Callable, Iterator, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener

from .trace_store import RuntimeTraceStore, TraceStoreError


LOGGER = logging.getLogger(__name__)
OPENROUTER_API_VERSION = "1.0.0"
OPENROUTER_PROVIDER_ID = "openrouter"
OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "openrouter/free"
MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_~.-]+/[A-Za-z0-9_~.:/-]+$")

MAX_INPUT_CHARACTERS = 64_000
MAX_SYSTEM_CHARACTERS = 32_000
MIN_OUTPUT_TOKENS = 16
MAX_OUTPUT_TOKENS = 4_096
DEFAULT_OUTPUT_TOKENS = 512
MAX_STREAM_EVENTS = 4_096
MAX_STREAM_BYTES = 8 * 1024 * 1024
MAX_STREAM_LINE_BYTES = 1024 * 1024
MAX_OUTPUT_CHARACTERS = 1_000_000
MAX_ACTIVE_INVOCATIONS = 4
MAX_JOB_RECORDS = 64


class OpenRouterProviderError(ValueError):
    """Stable local API error for OpenRouter configuration or execution."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.BAD_GATEWAY,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _safe_header(value: str, name: str, *, maximum: int) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\r" in normalized or "\n" in normalized:
        raise ValueError(f"{name} must be a non-empty single-line value of at most {maximum} characters.")
    return normalized


def _model_id(value: str) -> str:
    normalized = _safe_header(value, "OpenRouter model id", maximum=240)
    if not MODEL_ID_PATTERN.fullmatch(normalized):
        raise ValueError(f"Invalid OpenRouter model id: {normalized}")
    return normalized


def _optional_site_url(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    normalized = _safe_header(value, "OpenRouter site URL", maximum=2_000)
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("OpenRouter site URL must be an absolute HTTP(S) URL without credentials.")
    return normalized


@dataclass(frozen=True, slots=True)
class OpenRouterProviderConfig:
    """Credential-bearing configuration that never crosses the loopback API."""

    api_key: str | None
    models: tuple[str, ...] = (DEFAULT_OPENROUTER_MODEL,)
    default_model: str = DEFAULT_OPENROUTER_MODEL
    site_url: str | None = None
    app_name: str | None = "OpenJiuwen Visualization"
    request_timeout_seconds: float = 120.0

    def __post_init__(self) -> None:
        normalized_key = self.api_key.strip() if isinstance(self.api_key, str) else None
        if normalized_key:
            _safe_header(normalized_key, "OpenRouter API key", maximum=4_096)
        object.__setattr__(self, "api_key", normalized_key or None)

        normalized_models = tuple(dict.fromkeys(_model_id(model) for model in self.models))
        if not normalized_models:
            raise ValueError("At least one OpenRouter model must be registered.")
        normalized_default = _model_id(self.default_model)
        if normalized_default not in normalized_models:
            raise ValueError("The default OpenRouter model must be in the registered model allowlist.")
        object.__setattr__(self, "models", normalized_models)
        object.__setattr__(self, "default_model", normalized_default)
        object.__setattr__(self, "site_url", _optional_site_url(self.site_url))
        if self.app_name is not None and self.app_name.strip():
            object.__setattr__(
                self,
                "app_name",
                _safe_header(self.app_name, "OpenRouter app name", maximum=120),
            )
        else:
            object.__setattr__(self, "app_name", None)
        if not 5 <= self.request_timeout_seconds <= 600:
            raise ValueError("OpenRouter request timeout must be between 5 and 600 seconds.")

    @property
    def configured(self) -> bool:
        return self.api_key is not None

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> "OpenRouterProviderConfig":
        values = os.environ if environment is None else environment
        raw_models = values.get("OPENJIUWEN_OPENROUTER_MODELS", "")
        models = tuple(
            model.strip()
            for model in raw_models.split(",")
            if model.strip()
        ) or (DEFAULT_OPENROUTER_MODEL,)
        default_model = values.get("OPENJIUWEN_OPENROUTER_DEFAULT_MODEL", "").strip()
        return cls(
            api_key=(
                values.get("OPENJIUWEN_OPENROUTER_API_KEY")
                or values.get("OPENROUTER_API_KEY")
            ),
            models=models,
            default_model=default_model or models[0],
            site_url=values.get("OPENJIUWEN_OPENROUTER_SITE_URL"),
            app_name=values.get(
                "OPENJIUWEN_OPENROUTER_APP_NAME",
                "OpenJiuwen Visualization",
            ),
        )

    def public_descriptor(self) -> dict[str, object]:
        return {
            "apiVersion": OPENROUTER_API_VERSION,
            "provider": {
                "id": OPENROUTER_PROVIDER_ID,
                "label": "OpenRouter",
                "status": "ready" if self.configured else "unconfigured",
                "configured": self.configured,
                "protocol": "openrouter.chat-completions",
                "credentialPolicy": "local-service-only",
                "streaming": True,
                "cancellation": True,
                "usage": True,
                "models": [
                    {
                        "id": model,
                        "label": model,
                        "default": model == self.default_model,
                    }
                    for model in self.models
                ],
                "defaultModelId": self.default_model,
                "limits": {
                    "maxInputCharacters": MAX_INPUT_CHARACTERS,
                    "maxSystemCharacters": MAX_SYSTEM_CHARACTERS,
                    "minOutputTokens": MIN_OUTPUT_TOKENS,
                    "maxOutputTokens": MAX_OUTPUT_TOKENS,
                    "defaultOutputTokens": DEFAULT_OUTPUT_TOKENS,
                    "maxActiveInvocations": MAX_ACTIVE_INVOCATIONS,
                },
                "network": {
                    "origin": "https://openrouter.ai",
                    "endpoint": "/api/v1/chat/completions",
                },
            },
        }


@dataclass(frozen=True, slots=True)
class OpenRouterChatRequest:
    model_id: str
    input_text: str
    system_prompt: str | None
    max_output_tokens: int

    def messages(self) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        messages.append({"role": "user", "content": self.input_text})
        return messages


class OpenRouterStream(Protocol):
    generation_id: str | None

    def __iter__(self) -> Iterator[dict[str, Any]]: ...

    def close(self) -> None: ...


class OpenRouterTransport(Protocol):
    def open_stream(self, request: OpenRouterChatRequest) -> OpenRouterStream: ...


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def _safe_upstream_text(value: object, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    compact = " ".join(value.split())
    return compact[:600] or fallback


def _upstream_error(raw_body: bytes, status: int) -> OpenRouterProviderError:
    code = f"openrouter_http_{status}"
    message = f"OpenRouter returned HTTP {status}."
    try:
        value = json.loads(raw_body.decode("utf-8"))
        error = value.get("error") if isinstance(value, dict) else None
        if isinstance(error, dict):
            metadata = error.get("metadata")
            error_type = metadata.get("error_type") if isinstance(metadata, dict) else None
            raw_code = error_type or error.get("code")
            if isinstance(raw_code, (str, int)):
                code = f"openrouter_{str(raw_code).lower().replace(' ', '_')[:80]}"
            message = _safe_upstream_text(error.get("message"), message)
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    return OpenRouterProviderError(code, message)


class _HttpOpenRouterStream:
    def __init__(self, response: Any) -> None:
        self._response = response
        self._closed = False
        self._lock = threading.Lock()
        self.generation_id = response.headers.get("X-Generation-Id")

    def __iter__(self) -> Iterator[dict[str, Any]]:
        data_lines: list[str] = []
        total_bytes = 0
        event_count = 0

        while True:
            raw_line = self._response.readline(MAX_STREAM_LINE_BYTES + 1)
            if len(raw_line) > MAX_STREAM_LINE_BYTES:
                raise OpenRouterProviderError(
                    "openrouter_stream_line_limit",
                    "OpenRouter sent an oversized streaming frame.",
                )
            if not raw_line:
                if data_lines:
                    value = self._parse_data(data_lines)
                    if value is not None:
                        yield value
                break
            total_bytes += len(raw_line)
            if total_bytes > MAX_STREAM_BYTES:
                raise OpenRouterProviderError(
                    "openrouter_stream_byte_limit",
                    "OpenRouter response exceeded the local stream byte limit.",
                )
            try:
                line = raw_line.decode("utf-8").rstrip("\r\n")
            except UnicodeDecodeError as exc:
                raise OpenRouterProviderError(
                    "openrouter_stream_encoding",
                    "OpenRouter stream was not valid UTF-8.",
                ) from exc

            if not line:
                if not data_lines:
                    continue
                value = self._parse_data(data_lines)
                data_lines = []
                if value is None:
                    break
                event_count += 1
                if event_count > MAX_STREAM_EVENTS:
                    raise OpenRouterProviderError(
                        "openrouter_stream_event_limit",
                        "OpenRouter response exceeded the local stream event limit.",
                    )
                yield value
                continue
            if line.startswith(":"):
                continue
            if line == "data":
                data_lines.append("")
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))

    @staticmethod
    def _parse_data(lines: list[str]) -> dict[str, Any] | None:
        payload = "\n".join(lines)
        if payload == "[DONE]":
            return None
        try:
            value = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise OpenRouterProviderError(
                "openrouter_stream_json",
                "OpenRouter sent an invalid JSON streaming frame.",
            ) from exc
        if not isinstance(value, dict):
            raise OpenRouterProviderError(
                "openrouter_stream_shape",
                "OpenRouter sent an unsupported streaming frame.",
            )
        return value

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._response.close()


class OpenRouterHttpTransport:
    """Fixed-origin, redirect-rejecting Chat Completions transport."""

    def __init__(
        self,
        config: OpenRouterProviderConfig,
        *,
        opener: OpenerDirector | None = None,
    ) -> None:
        self._config = config
        self._opener = opener or build_opener(_RejectRedirects())

    def open_stream(self, request: OpenRouterChatRequest) -> OpenRouterStream:
        if not self._config.api_key:
            raise OpenRouterProviderError(
                "openrouter_unconfigured",
                "OpenRouter is not configured in the local service.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        payload = json.dumps(
            {
                "model": request.model_id,
                "messages": request.messages(),
                "max_tokens": request.max_output_tokens,
                "stream": True,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "OpenJiuwen-Visualization/0.1",
        }
        if self._config.site_url:
            headers["HTTP-Referer"] = self._config.site_url
        if self._config.app_name:
            headers["X-OpenRouter-Title"] = self._config.app_name
        http_request = Request(
            OPENROUTER_CHAT_COMPLETIONS_URL,
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            response = self._opener.open(
                http_request,
                timeout=self._config.request_timeout_seconds,
            )
        except HTTPError as exc:
            raw_body = exc.read(64 * 1024)
            raise _upstream_error(raw_body, exc.code) from exc
        except (URLError, OSError, TimeoutError) as exc:
            raise OpenRouterProviderError(
                "openrouter_network_error",
                "The local service could not reach OpenRouter.",
            ) from exc

        if response.geturl().rstrip("/") != OPENROUTER_CHAT_COMPLETIONS_URL.rstrip("/"):
            response.close()
            raise OpenRouterProviderError(
                "openrouter_redirect_rejected",
                "OpenRouter redirected the fixed API endpoint; the request was stopped.",
            )
        content_type = response.headers.get("Content-Type", "").lower()
        if content_type and not content_type.startswith("text/event-stream"):
            raw_body = response.read(64 * 1024)
            response.close()
            raise _upstream_error(raw_body, getattr(response, "status", 502))
        return _HttpOpenRouterStream(response)


def _required_input(value: Any, name: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise OpenRouterProviderError(
            "invalid_openrouter_request",
            f"{name} must be a non-empty string.",
            status=HTTPStatus.BAD_REQUEST,
        )
    if len(value) > maximum:
        raise OpenRouterProviderError(
            "invalid_openrouter_request",
            f"{name} exceeds {maximum} characters.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return value


def _optional_input(value: Any, name: str, *, maximum: int) -> str | None:
    if value is None or value == "":
        return None
    return _required_input(value, name, maximum=maximum)


def _estimated_tokens(value: str) -> int:
    if not value:
        return 0
    return max(1, (len(value) + 3) // 4)


def _content_delta(frame: dict[str, Any]) -> str:
    choices = frame.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    delta = choices[0].get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        fragments: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str):
                fragments.append(text)
        return "".join(fragments)
    return ""


def _finish_reason(frame: dict[str, Any]) -> str | None:
    choices = frame.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    value = choices[0].get("finish_reason")
    return _safe_upstream_text(value, "") or None


def _resolved_model(frame: dict[str, Any]) -> str | None:
    value = frame.get("model")
    if isinstance(value, str) and value.strip():
        return value.strip()[:240]
    return None


def _integer_field(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and value >= 0 and value.is_integer():
        return int(value)
    return None


def _usage(frame: dict[str, Any]) -> dict[str, Any] | None:
    raw = frame.get("usage")
    if not isinstance(raw, dict):
        return None
    input_tokens = _integer_field(raw.get("prompt_tokens"))
    if input_tokens is None:
        input_tokens = _integer_field(raw.get("input_tokens"))
    output_tokens = _integer_field(raw.get("completion_tokens"))
    if output_tokens is None:
        output_tokens = _integer_field(raw.get("output_tokens"))
    if input_tokens is None or output_tokens is None:
        return None
    total_tokens = _integer_field(raw.get("total_tokens"))
    if total_tokens is None:
        total_tokens = input_tokens + output_tokens
    normalized: dict[str, Any] = {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
    }
    input_details = raw.get("prompt_tokens_details")
    if not isinstance(input_details, dict):
        input_details = raw.get("input_tokens_details")
    if isinstance(input_details, dict):
        cached_tokens = _integer_field(input_details.get("cached_tokens"))
        if cached_tokens is not None:
            normalized["cachedInputTokens"] = cached_tokens
    output_details = raw.get("completion_tokens_details")
    if not isinstance(output_details, dict):
        output_details = raw.get("output_tokens_details")
    if isinstance(output_details, dict):
        reasoning_tokens = _integer_field(output_details.get("reasoning_tokens"))
        if reasoning_tokens is not None:
            normalized["reasoningTokens"] = reasoning_tokens
    raw_cost = raw.get("cost")
    if raw_cost is not None and not isinstance(raw_cost, bool):
        try:
            cost_micros = int(
                (Decimal(str(raw_cost)) * Decimal(1_000_000)).quantize(
                    Decimal("1"),
                    rounding=ROUND_HALF_UP,
                )
            )
            if cost_micros >= 0:
                normalized["costMicros"] = cost_micros
                normalized["currency"] = "USD"
        except (InvalidOperation, ValueError, OverflowError):
            pass
    return normalized


def _frame_error(frame: dict[str, Any]) -> OpenRouterProviderError | None:
    raw_error = frame.get("error")
    if not isinstance(raw_error, dict):
        return None
    metadata = raw_error.get("metadata")
    raw_code = metadata.get("error_type") if isinstance(metadata, dict) else None
    raw_code = raw_code or raw_error.get("code") or "stream_error"
    code = re.sub(r"[^a-z0-9_.-]+", "_", str(raw_code).lower())[:80]
    return OpenRouterProviderError(
        f"openrouter_{code}",
        _safe_upstream_text(raw_error.get("message"), "OpenRouter stream failed."),
    )


@dataclass(slots=True)
class _InvocationJob:
    id: str
    trace_id: str
    model_id: str
    started_at: float
    state: str = "accepted"
    event_number: int = 0
    cancel_event: threading.Event = field(default_factory=threading.Event)
    done_event: threading.Event = field(default_factory=threading.Event)
    stream: OpenRouterStream | None = None


class OpenRouterRuntimeAdapter:
    """Runs bounded OpenRouter calls and writes only normalized events to a trace."""

    def __init__(
        self,
        config: OpenRouterProviderConfig,
        trace_store: RuntimeTraceStore,
        *,
        transport: OpenRouterTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.config = config
        self._trace_store = trace_store
        self._transport = transport or OpenRouterHttpTransport(config)
        self._clock = clock
        self._id_factory = id_factory or (lambda: "or_" + secrets.token_urlsafe(16))
        self._jobs: dict[str, _InvocationJob] = {}
        self._lock = threading.RLock()

    def descriptor(self) -> dict[str, object]:
        return self.config.public_descriptor()

    def start(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> dict[str, object]:
        unknown_fields = set(body) - {
            "traceId",
            "modelId",
            "input",
            "systemPrompt",
            "maxOutputTokens",
        }
        if unknown_fields:
            raise OpenRouterProviderError(
                "invalid_openrouter_request",
                f"Unsupported OpenRouter request field: {sorted(unknown_fields)[0]}",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not self.config.configured:
            raise OpenRouterProviderError(
                "openrouter_unconfigured",
                "Set OPENJIUWEN_OPENROUTER_API_KEY or OPENROUTER_API_KEY in the local service environment.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        trace_id = _required_input(body.get("traceId"), "traceId", maximum=240)
        try:
            trace = self._trace_store.authorize_writer(
                trace_id,
                trace_token,
                owner="agent-core",
            )
        except TraceStoreError as exc:
            raise OpenRouterProviderError(exc.code, str(exc), status=exc.status) from exc
        model_id = body.get("modelId", self.config.default_model)
        if not isinstance(model_id, str) or model_id not in self.config.models:
            raise OpenRouterProviderError(
                "openrouter_model_not_allowed",
                "modelId must be one of the models registered by the local service.",
                status=HTTPStatus.BAD_REQUEST,
            )
        input_text = _required_input(
            body.get("input"),
            "input",
            maximum=MAX_INPUT_CHARACTERS,
        )
        system_prompt = _optional_input(
            body.get("systemPrompt"),
            "systemPrompt",
            maximum=MAX_SYSTEM_CHARACTERS,
        )
        max_output_tokens = body.get("maxOutputTokens", DEFAULT_OUTPUT_TOKENS)
        if (
            isinstance(max_output_tokens, bool)
            or not isinstance(max_output_tokens, int)
            or not MIN_OUTPUT_TOKENS <= max_output_tokens <= MAX_OUTPUT_TOKENS
        ):
            raise OpenRouterProviderError(
                "invalid_openrouter_request",
                f"maxOutputTokens must be an integer between {MIN_OUTPUT_TOKENS} and {MAX_OUTPUT_TOKENS}.",
                status=HTTPStatus.BAD_REQUEST,
            )

        with self._lock:
            self._prune_jobs_locked()
            if sum(job.state in {"accepted", "running", "cancelling"} for job in self._jobs.values()) >= MAX_ACTIVE_INVOCATIONS:
                raise OpenRouterProviderError(
                    "openrouter_capacity_reached",
                    "The local OpenRouter invocation limit has been reached.",
                    status=HTTPStatus.TOO_MANY_REQUESTS,
                )
            if any(
                job.trace_id == trace_id and job.state in {"accepted", "running", "cancelling"}
                for job in self._jobs.values()
            ):
                raise OpenRouterProviderError(
                    "openrouter_trace_busy",
                    "This trace already has an active OpenRouter invocation.",
                    status=HTTPStatus.CONFLICT,
                )
            invocation_id = self._id_factory()
            while invocation_id in self._jobs:
                invocation_id = self._id_factory()
            job = _InvocationJob(
                id=invocation_id,
                trace_id=trace_id,
                model_id=model_id,
                started_at=self._clock(),
            )
            self._jobs[invocation_id] = job

        request = OpenRouterChatRequest(
            model_id=model_id,
            input_text=input_text,
            system_prompt=system_prompt,
            max_output_tokens=max_output_tokens,
        )
        worker = threading.Thread(
            target=self._run_job,
            args=(job, trace_token, request, int(trace["maxTokens"])),
            name=f"openrouter-{invocation_id}",
            daemon=True,
        )
        worker.start()
        return {
            "apiVersion": OPENROUTER_API_VERSION,
            "invocation": {
                "id": invocation_id,
                "traceId": trace_id,
                "providerId": OPENROUTER_PROVIDER_ID,
                "modelId": model_id,
                "status": "accepted",
                "cancellationEndpoint": f"/api/v1/model-providers/openrouter/invocations/{invocation_id}/cancel",
            },
        }

    def cancel(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> dict[str, object]:
        with self._lock:
            job = self._jobs.get(invocation_id)
            if job is None:
                raise OpenRouterProviderError(
                    "openrouter_invocation_not_found",
                    "OpenRouter invocation was not found.",
                    status=HTTPStatus.NOT_FOUND,
                )
            try:
                self._trace_store.authorize_writer(
                    job.trace_id,
                    trace_token,
                    owner="agent-core",
                )
            except TraceStoreError as exc:
                raise OpenRouterProviderError(exc.code, str(exc), status=exc.status) from exc
            if job.state not in {"accepted", "running", "cancelling"}:
                raise OpenRouterProviderError(
                    "openrouter_invocation_finished",
                    "OpenRouter invocation has already finished.",
                    status=HTTPStatus.CONFLICT,
                )
            job.state = "cancelling"
            job.cancel_event.set()
            stream = job.stream
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass
        return {
            "apiVersion": OPENROUTER_API_VERSION,
            "invocation": {
                "id": job.id,
                "traceId": job.trace_id,
                "providerId": OPENROUTER_PROVIDER_ID,
                "modelId": job.model_id,
                "status": "cancelling",
            },
        }

    def wait_for_terminal(self, invocation_id: str, timeout_seconds: float = 2) -> bool:
        with self._lock:
            job = self._jobs.get(invocation_id)
        return bool(job and job.done_event.wait(timeout_seconds))

    def _run_job(
        self,
        job: _InvocationJob,
        trace_token: str | None,
        request: OpenRouterChatRequest,
        trace_max_tokens: int,
    ) -> None:
        output_parts: list[str] = []
        output_characters = 0
        finish_reason = "stream_ended"
        resolved_model: str | None = None
        latest_usage: dict[str, Any] | None = None
        generation_id: str | None = None
        input_estimate = _estimated_tokens((request.system_prompt or "") + request.input_text)
        try:
            with self._lock:
                if job.state == "accepted":
                    job.state = "running"
            self._append(
                job,
                trace_token,
                self._initial_events(job, request, input_estimate, trace_max_tokens),
            )
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token, output_parts, latest_usage)
                return

            stream = self._transport.open_stream(request)
            generation_id = stream.generation_id
            with self._lock:
                job.stream = stream
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token, output_parts, latest_usage)
                return
            for frame in stream:
                if job.cancel_event.is_set():
                    self._complete_cancelled(job, trace_token, output_parts, latest_usage)
                    return
                frame_error = _frame_error(frame)
                if frame_error:
                    raise frame_error
                resolved_model = _resolved_model(frame) or resolved_model
                delta = _content_delta(frame)
                if delta:
                    output_characters += len(delta)
                    if output_characters > MAX_OUTPUT_CHARACTERS:
                        raise OpenRouterProviderError(
                            "openrouter_output_limit",
                            "OpenRouter output exceeded the local text limit.",
                        )
                    output_parts.append(delta)
                    self._append(
                        job,
                        trace_token,
                        [
                            self._event(
                                job,
                                "model.stream",
                                "instant",
                                title="OpenRouter stream delta",
                                model={**self._model_identity(job), "delta": delta},
                            )
                        ],
                    )
                usage = _usage(frame)
                if usage is not None and usage != latest_usage:
                    previous_total = latest_usage.get("totalTokens", input_estimate) if latest_usage else input_estimate
                    latest_usage = usage
                    self._append(
                        job,
                        trace_token,
                        [
                            self._event(
                                job,
                                "model.usage",
                                "instant",
                                title="OpenRouter usage",
                                token={
                                    "used": usage["totalTokens"],
                                    "delta": usage["totalTokens"] - previous_total,
                                    "budget": trace_max_tokens,
                                },
                                model={**self._model_identity(job), "usage": usage},
                            )
                        ],
                    )
                finish_reason = _finish_reason(frame) or finish_reason

            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token, output_parts, latest_usage)
                return
            self._complete_success(
                job,
                trace_token,
                output_parts,
                latest_usage,
                finish_reason,
                resolved_model,
                generation_id,
            )
        except Exception as exc:  # The worker must always terminate its trace.
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token, output_parts, latest_usage)
            else:
                error = exc if isinstance(exc, OpenRouterProviderError) else OpenRouterProviderError(
                    "openrouter_internal_error",
                    "The local OpenRouter adapter failed unexpectedly.",
                )
                self._complete_failed(job, trace_token, output_parts, latest_usage, error)
        finally:
            with self._lock:
                stream = job.stream
                job.stream = None
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
            job.done_event.set()

    def _initial_events(
        self,
        job: _InvocationJob,
        request: OpenRouterChatRequest,
        input_estimate: int,
        trace_max_tokens: int,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if request.system_prompt:
            messages.append(
                {
                    "id": f"{job.id}:system",
                    "role": "system",
                    "label": "OpenRouter system prompt",
                    "raw": request.system_prompt,
                    "tokens": _estimated_tokens(request.system_prompt),
                    "source": "openrouter.request · estimated tokens",
                }
            )
        messages.append(
            {
                "id": f"{job.id}:user",
                "role": "user",
                "label": "OpenRouter user input",
                "raw": request.input_text,
                "tokens": _estimated_tokens(request.input_text),
                "source": "openrouter.request · estimated tokens",
            }
        )
        return [
            self._event(
                job,
                "agent.user_message",
                "instant",
                title="OpenRouter input received",
                summary="本地 Provider adapter 接收输入；正文只进入所属 Context。",
                activeNodeIds=["input"],
            ),
            self._event(
                job,
                "context.snapshot",
                "instant",
                title="OpenRouter request context",
                summary="即将发送给 OpenRouter 的完整文本上下文。",
                token={"used": input_estimate, "delta": input_estimate, "budget": trace_max_tokens},
                context={"operation": "replace", "messages": messages},
                activeNodeIds=["context"],
            ),
            self._event(
                job,
                "model.call",
                "start",
                title="OpenRouter request started",
                summary="本地服务向固定 OpenRouter Chat Completions 端点发起流式请求。",
                model={
                    **self._model_identity(job),
                    "budget": {
                        "maxOutputTokens": request.max_output_tokens,
                        "maxTotalTokens": trace_max_tokens,
                        "currency": "USD",
                    },
                },
            ),
        ]

    def _complete_success(
        self,
        job: _InvocationJob,
        trace_token: str | None,
        output_parts: list[str],
        latest_usage: dict[str, Any] | None,
        finish_reason: str,
        resolved_model: str | None,
        generation_id: str | None,
    ) -> None:
        output = "".join(output_parts)
        details = []
        if resolved_model:
            details.append({"label": "resolved model", "value": resolved_model})
        if generation_id:
            details.append({"label": "generation", "value": generation_id[:240]})
        events = [
            self._event(
                job,
                "model.call",
                "end",
                title="OpenRouter request completed",
                durationMs=self._elapsed_ms(job),
                details=details,
                model={**self._model_identity(job), "finishReason": finish_reason},
                activeNodeIds=["model", "output"],
            )
        ]
        if output:
            events.append(self._assistant_context_event(job, output, latest_usage, cancelled=False))
        events.append(
            self._event(
                job,
                "trace.status",
                "end",
                title="OpenRouter trace complete",
                summary="Provider 流、用量与 Context 已归一化到同一内存 Trace。",
                activeNodeIds=["output"],
            )
        )
        self._append(job, trace_token, events)
        with self._lock:
            job.state = "completed"

    def _complete_cancelled(
        self,
        job: _InvocationJob,
        trace_token: str | None,
        output_parts: list[str],
        latest_usage: dict[str, Any] | None,
    ) -> None:
        output = "".join(output_parts)
        events: list[dict[str, Any]] = []
        if output:
            events.append(self._assistant_context_event(job, output, latest_usage, cancelled=True))
        events.extend(
            [
                self._event(
                    job,
                    "model.cancel",
                    "instant",
                    title="OpenRouter request cancelled",
                    model={**self._model_identity(job), "cancelReason": "operator_requested"},
                ),
                self._event(
                    job,
                    "trace.status",
                    "end",
                    title="OpenRouter trace cancelled",
                    summary="上游流已关闭；已保留取消前收到的 Context 与输出增量。",
                    activeNodeIds=["output"],
                ),
            ]
        )
        self._append(job, trace_token, events)
        with self._lock:
            job.state = "cancelled"

    def _complete_failed(
        self,
        job: _InvocationJob,
        trace_token: str | None,
        output_parts: list[str],
        latest_usage: dict[str, Any] | None,
        error: OpenRouterProviderError,
    ) -> None:
        output = "".join(output_parts)
        events: list[dict[str, Any]] = []
        if output:
            events.append(self._assistant_context_event(job, output, latest_usage, cancelled=True))
        events.extend(
            [
                self._event(
                    job,
                    "model.call",
                    "error",
                    title="OpenRouter request failed",
                    summary="OpenRouter 调用失败；错误类型已保留，正文不会写入 Provider 元数据。",
                    durationMs=self._elapsed_ms(job),
                    details=[{"label": "error", "value": error.code}],
                    model={**self._model_identity(job), "finishReason": "error"},
                    activeNodeIds=["model"],
                ),
                self._event(
                    job,
                    "trace.status",
                    "error",
                    title="OpenRouter trace failed",
                    summary=f"Provider adapter stopped with {error.code}.",
                ),
            ]
        )
        try:
            self._append(job, trace_token, events)
        except (TraceStoreError, OpenRouterProviderError):
            LOGGER.warning("Could not close failed OpenRouter trace %s", job.trace_id)
        with self._lock:
            job.state = "failed"

    def _assistant_context_event(
        self,
        job: _InvocationJob,
        output: str,
        latest_usage: dict[str, Any] | None,
        *,
        cancelled: bool,
    ) -> dict[str, Any]:
        output_tokens = (
            latest_usage.get("outputTokens")
            if latest_usage is not None
            else _estimated_tokens(output)
        )
        return self._event(
            job,
            "context.delta",
            "instant",
            title="OpenRouter response appended",
            summary="取消前的部分响应已进入 Context。" if cancelled else "完整模型响应已进入 Context。",
            context={
                "operation": "append",
                "messages": [
                    {
                        "id": f"{job.id}:assistant",
                        "role": "assistant",
                        "label": "OpenRouter partial response" if cancelled else "OpenRouter response",
                        "raw": output,
                        "tokens": output_tokens,
                        "source": "openrouter.response" if latest_usage else "openrouter.response · estimated tokens",
                    }
                ],
            },
            activeNodeIds=["context", "output"],
        )

    @staticmethod
    def _model_identity(job: _InvocationJob) -> dict[str, Any]:
        return {
            "invocationId": job.id,
            "providerId": OPENROUTER_PROVIDER_ID,
            "modelId": job.model_id,
            "source": "live",
        }

    def _event(
        self,
        job: _InvocationJob,
        kind: str,
        phase: str,
        **values: Any,
    ) -> dict[str, Any]:
        job.event_number += 1
        return {
            "eventId": f"{job.id}:{job.event_number}",
            "kind": kind,
            "phase": phase,
            "timestampMs": self._elapsed_ms(job),
            "spanId": f"{job.id}:model",
            **values,
        }

    def _elapsed_ms(self, job: _InvocationJob) -> int:
        return max(0, round((self._clock() - job.started_at) * 1_000))

    def _append(
        self,
        job: _InvocationJob,
        trace_token: str | None,
        events: list[dict[str, Any]],
    ) -> None:
        self._trace_store.append(job.trace_id, trace_token, events)

    def _prune_jobs_locked(self) -> None:
        if len(self._jobs) < MAX_JOB_RECORDS:
            return
        terminal = sorted(
            (
                job
                for job in self._jobs.values()
                if job.state not in {"accepted", "running", "cancelling"}
            ),
            key=lambda job: job.started_at,
        )
        for job in terminal[: max(1, len(self._jobs) - MAX_JOB_RECORDS + 1)]:
            self._jobs.pop(job.id, None)
