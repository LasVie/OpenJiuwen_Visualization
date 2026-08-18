"""Dependency-free loopback API for repository inspection and runtime traces."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .config import LocalServiceConfig, PathAccessError
from .git_changes import GitChangeError, GitChangeInspector, GitChangeOptions
from .repository import RepositoryResolutionError, RepositoryResolver
from .scanner import (
    PythonRepositoryScanner,
    ScanOptions,
    ToolCatalogOptions,
    ToolCatalogScanner,
)
from .trace_store import API_VERSION as TRACE_API_VERSION
from .trace_store import RuntimeTraceStore, TraceStoreError


LOGGER = logging.getLogger(__name__)
TRACE_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)$")
TRACE_EVENTS_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)/events$")
TRACE_STREAM_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)/stream$")


@dataclass(frozen=True, slots=True)
class ApiResponse:
    status: int
    body: dict[str, object]


def _error(status: int, code: str, message: str) -> ApiResponse:
    return ApiResponse(status, {"error": {"code": code, "message": message}})


def _boolean_option(options: dict[str, Any], name: str, default: bool) -> bool:
    value = options.get(name, default)
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean.")
    return value


def _integer_option(options: dict[str, Any], name: str, default: int) -> int:
    value = options.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer.")
    return value


def _reject_json_constant(constant: str) -> None:
    raise ValueError(f"Non-finite JSON number is not allowed: {constant}")


class LocalRepositoryApi:
    def __init__(
        self,
        config: LocalServiceConfig,
        *,
        resolver: RepositoryResolver | None = None,
        scanner: PythonRepositoryScanner | None = None,
        tool_catalog_scanner: ToolCatalogScanner | None = None,
        trace_store: RuntimeTraceStore | None = None,
        change_inspector: GitChangeInspector | None = None,
    ) -> None:
        self.config = config
        self._resolver = resolver or RepositoryResolver(config)
        self._scanner = scanner or PythonRepositoryScanner()
        self._tool_catalog_scanner = tool_catalog_scanner or ToolCatalogScanner()
        self.trace_store = trace_store or RuntimeTraceStore()
        self._change_inspector = change_inspector or GitChangeInspector()

    def dispatch(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        origin: str | None = None,
        trace_token: str | None = None,
    ) -> ApiResponse:
        if not self.config.is_origin_allowed(origin):
            return _error(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Origin is not allowed.")

        split_path = urlsplit(path)
        route = split_path.path.rstrip("/") or "/"
        if method == "GET" and route == "/api/v1/health":
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "apiVersion": "1.0.0",
                    "mode": "read-only",
                    "capabilities": [
                        "repository.read",
                        "repository.tools.read",
                        "git.change.read",
                        "trace.ephemeral",
                    ],
                    "traceStorage": "memory-only",
                },
            )
        if method == "GET" and route == "/api/v1/repositories":
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "allowedRoots": [str(root) for root in self.config.allowed_roots],
                    "repositories": [
                        identity.to_api_dict()
                        for identity in self._resolver.discover()
                    ],
                    "writeOperations": False,
                },
            )
        if method == "POST" and route == "/api/v1/repositories/scan":
            return self._scan(body or {})
        if method == "POST" and route == "/api/v1/repositories/tools":
            return self._tool_catalog(body or {})
        if method == "POST" and route == "/api/v1/repositories/changes":
            return self._changes(body or {})
        if method == "POST" and route == "/api/v1/traces":
            return self._create_trace(body or {})
        trace_match = TRACE_ROUTE.fullmatch(route)
        if method == "GET" and trace_match:
            return self._trace_snapshot(trace_match.group(1), split_path.query)
        events_match = TRACE_EVENTS_ROUTE.fullmatch(route)
        if method == "POST" and events_match:
            return self._append_trace(events_match.group(1), trace_token, body or {})
        return _error(HTTPStatus.NOT_FOUND, "not_found", "API route was not found.")

    def _create_trace(self, body: dict[str, Any]) -> ApiResponse:
        try:
            metadata, write_token = self.trace_store.create(
                owner=body.get("owner", "agent-core"),
                label=body.get("label", "Agent Core trace"),
                max_tokens=body.get("maxTokens", 8192),
            )
        except TraceStoreError as exc:
            return _error(exc.status, exc.code, str(exc))
        trace_id = metadata["id"]
        return ApiResponse(
            HTTPStatus.CREATED,
            {
                "apiVersion": TRACE_API_VERSION,
                "trace": metadata,
                "writeToken": write_token,
                "endpoints": {
                    "events": f"/api/v1/traces/{trace_id}/events",
                    "snapshot": f"/api/v1/traces/{trace_id}",
                    "stream": f"/api/v1/traces/{trace_id}/stream",
                },
                "storage": "memory-only",
            },
        )

    def _append_trace(
        self,
        trace_id: str,
        trace_token: str | None,
        body: dict[str, Any],
    ) -> ApiResponse:
        try:
            metadata, accepted = self.trace_store.append(
                trace_id,
                trace_token,
                body.get("events"),
            )
        except TraceStoreError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(
            HTTPStatus.ACCEPTED,
            {
                "apiVersion": TRACE_API_VERSION,
                "trace": metadata,
                "accepted": len(accepted),
                "lastSequence": metadata["lastSequence"],
                "storage": "memory-only",
            },
        )

    def _trace_snapshot(self, trace_id: str, query: str) -> ApiResponse:
        raw_after = parse_qs(query).get("after", ["0"])[0]
        try:
            after = int(raw_after)
            metadata, events = self.trace_store.snapshot(trace_id, after=after)
        except TraceStoreError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_cursor", "after must be an integer.")
        return ApiResponse(
            HTTPStatus.OK,
            {
                "apiVersion": TRACE_API_VERSION,
                "trace": metadata,
                "events": events,
                "storage": "memory-only",
            },
        )

    def _scan(self, body: dict[str, Any]) -> ApiResponse:
        repository_path = body.get("path")
        if not isinstance(repository_path, str) or not repository_path.strip():
            return _error(HTTPStatus.BAD_REQUEST, "invalid_path", "path must be a non-empty string.")
        raw_options = body.get("options", {})
        if not isinstance(raw_options, dict):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", "options must be an object.")

        try:
            options = ScanOptions(
                include_tests=_boolean_option(raw_options, "includeTests", False),
                include_functions=_boolean_option(raw_options, "includeFunctions", False),
                max_files=_integer_option(raw_options, "maxFiles", 5_000),
                max_file_bytes=_integer_option(raw_options, "maxFileBytes", 1_000_000),
                max_edges=_integer_option(raw_options, "maxEdges", 20_000),
            )
            identity = self._resolver.resolve(repository_path)
            result = self._scanner.scan(identity, options)
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(HTTPStatus.UNPROCESSABLE_ENTITY, "repository_unavailable", str(exc))
        except ValueError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", str(exc))
        except Exception:
            LOGGER.exception("Repository scan failed")
            return _error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "scan_failed",
                "Repository scan failed without modifying the target repository.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _changes(self, body: dict[str, Any]) -> ApiResponse:
        repository_path = body.get("path")
        if not isinstance(repository_path, str) or not repository_path.strip():
            return _error(HTTPStatus.BAD_REQUEST, "invalid_path", "path must be a non-empty string.")
        raw_options = body.get("options", {})
        if not isinstance(raw_options, dict):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", "options must be an object.")
        mode = body.get("mode", "working-tree")
        if not isinstance(mode, str):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_change_mode", "mode must be a string.")
        base = body.get("base")
        head = body.get("head")
        if base is not None and not isinstance(base, str):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_git_ref", "base must be a string.")
        if head is not None and not isinstance(head, str):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_git_ref", "head must be a string.")

        try:
            identity = self._resolver.resolve(repository_path)
            result = self._change_inspector.inspect(
                identity,
                GitChangeOptions(
                    mode=mode,
                    base=base,
                    head=head,
                    include_untracked=_boolean_option(raw_options, "includeUntracked", True),
                    max_files=_integer_option(raw_options, "maxFiles", 500),
                ),
            )
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(HTTPStatus.UNPROCESSABLE_ENTITY, "repository_unavailable", str(exc))
        except GitChangeError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", str(exc))
        except Exception:
            LOGGER.exception("Git comparison failed")
            return _error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "git_change_failed",
                "Git comparison failed without modifying the target repository.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _tool_catalog(self, body: dict[str, Any]) -> ApiResponse:
        repository_path = body.get("path")
        if not isinstance(repository_path, str) or not repository_path.strip():
            return _error(HTTPStatus.BAD_REQUEST, "invalid_path", "path must be a non-empty string.")
        raw_options = body.get("options", {})
        if not isinstance(raw_options, dict):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", "options must be an object.")

        try:
            options = ToolCatalogOptions(
                include_tests=_boolean_option(raw_options, "includeTests", False),
                max_files=_integer_option(raw_options, "maxFiles", 5_000),
                max_file_bytes=_integer_option(raw_options, "maxFileBytes", 1_000_000),
                max_tools=_integer_option(raw_options, "maxTools", 5_000),
                max_registration_sites=_integer_option(
                    raw_options,
                    "maxRegistrationSites",
                    10_000,
                ),
            )
            identity = self._resolver.resolve(repository_path)
            result = self._tool_catalog_scanner.scan(identity, options)
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(HTTPStatus.UNPROCESSABLE_ENTITY, "repository_unavailable", str(exc))
        except ValueError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", str(exc))
        except Exception:
            LOGGER.exception("Tool catalog scan failed")
            return _error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "tool_catalog_failed",
                "Tool catalog scan failed without importing or modifying target code.",
            )
        return ApiResponse(HTTPStatus.OK, result)


class LocalRepositoryHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], api: LocalRepositoryApi):
        super().__init__(server_address, LocalRepositoryRequestHandler)
        self.api = api


class LocalRepositoryRequestHandler(BaseHTTPRequestHandler):
    server_version = "OpenJiuwenLocal/0.2"
    sys_version = ""

    @property
    def _api(self) -> LocalRepositoryApi:
        return self.server.api  # type: ignore[attr-defined, no-any-return]

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin")
        if not self._api.config.is_origin_allowed(origin):
            self._write_response(
                _error(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Origin is not allowed."),
                origin,
            )
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._write_common_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Trace-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin")
        split_path = urlsplit(self.path)
        stream_match = TRACE_STREAM_ROUTE.fullmatch(split_path.path.rstrip("/"))
        if stream_match:
            self._stream_trace_events(stream_match.group(1), split_path.query, origin)
            return
        self._write_response(self._api.dispatch("GET", self.path, origin=origin), origin)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin")
        if not self._api.config.is_origin_allowed(origin):
            self._write_response(
                _error(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Origin is not allowed."),
                origin,
            )
            return
        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._write_response(
                _error(HTTPStatus.BAD_REQUEST, "invalid_json", str(exc)),
                origin,
            )
            return
        self._write_response(
            self._api.dispatch(
                "POST",
                self.path,
                body=body,
                origin=origin,
                trace_token=self.headers.get("X-Trace-Token"),
            ),
            origin,
        )

    def _stream_trace_events(self, trace_id: str, query: str, origin: str | None) -> None:
        if not self._api.config.is_origin_allowed(origin):
            self._write_response(
                _error(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Origin is not allowed."),
                origin,
            )
            return
        query_after = parse_qs(query).get("after", ["0"])[0]
        raw_after = self.headers.get("Last-Event-ID") or query_after
        try:
            after = int(raw_after)
            metadata, events = self._api.trace_store.snapshot(trace_id, after=after)
        except TraceStoreError as exc:
            self._write_response(_error(exc.status, exc.code, str(exc)), origin)
            return
        except ValueError:
            self._write_response(
                _error(HTTPStatus.BAD_REQUEST, "invalid_cursor", "after must be an integer."),
                origin,
            )
            return

        self.send_response(HTTPStatus.OK)
        self._write_common_headers(origin)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(b": ready\n\n")
            self.wfile.flush()
            stream_deadline = time.monotonic() + 55
            while True:
                for event in events:
                    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    frame = (
                        f"id: {event['sequence']}\n"
                        f"event: trace.event\n"
                        f"data: {payload}\n\n"
                    )
                    self.wfile.write(frame.encode("utf-8"))
                    after = event["sequence"]
                if events:
                    self.wfile.flush()
                if metadata["status"] != "open":
                    payload = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(f"event: trace.end\ndata: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    break

                remaining = stream_deadline - time.monotonic()
                if remaining <= 0:
                    break
                metadata, events = self._api.trace_store.wait_for_events(
                    trace_id,
                    after=after,
                    timeout_seconds=min(15, remaining),
                )
                if not events:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            LOGGER.debug("Trace stream client disconnected")

    def _read_json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("application/json"):
            raise ValueError("Content-Type must be application/json.")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length is invalid.") from exc
        if content_length <= 0:
            return {}
        if content_length > self._api.config.max_request_bytes:
            raise ValueError("Request body exceeds the configured size limit.")
        raw_body = self.rfile.read(content_length)
        try:
            value = json.loads(
                raw_body.decode("utf-8"),
                parse_constant=_reject_json_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body is not valid UTF-8 JSON.") from exc
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object.")
        return value

    def _write_response(self, response: ApiResponse, origin: str | None) -> None:
        payload = json.dumps(response.body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(response.status)
        self._write_common_headers(origin)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            LOGGER.debug("Client disconnected before the response completed")

    def _write_common_headers(self, origin: str | None) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if origin and self._api.config.is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def log_message(self, message_format: str, *args: object) -> None:
        LOGGER.info("%s - %s", self.address_string(), message_format % args)


def create_http_server(
    config: LocalServiceConfig,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
) -> LocalRepositoryHttpServer:
    return LocalRepositoryHttpServer((host, port), LocalRepositoryApi(config))
