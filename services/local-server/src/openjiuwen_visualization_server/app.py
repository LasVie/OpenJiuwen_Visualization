"""Small dependency-free HTTP API for local repository inspection."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .config import LocalServiceConfig, PathAccessError
from .repository import RepositoryResolutionError, RepositoryResolver
from .scanner import PythonRepositoryScanner, ScanOptions


LOGGER = logging.getLogger(__name__)


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


class LocalRepositoryApi:
    def __init__(
        self,
        config: LocalServiceConfig,
        *,
        resolver: RepositoryResolver | None = None,
        scanner: PythonRepositoryScanner | None = None,
    ) -> None:
        self.config = config
        self._resolver = resolver or RepositoryResolver(config)
        self._scanner = scanner or PythonRepositoryScanner()

    def dispatch(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        origin: str | None = None,
    ) -> ApiResponse:
        if not self.config.is_origin_allowed(origin):
            return _error(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Origin is not allowed.")

        route = urlsplit(path).path.rstrip("/") or "/"
        if method == "GET" and route == "/api/v1/health":
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "apiVersion": "1.0.0",
                    "mode": "read-only",
                },
            )
        if method == "GET" and route == "/api/v1/repositories":
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "allowedRoots": [str(root) for root in self.config.allowed_roots],
                    "writeOperations": False,
                },
            )
        if method == "POST" and route == "/api/v1/repositories/scan":
            return self._scan(body or {})
        return _error(HTTPStatus.NOT_FOUND, "not_found", "API route was not found.")

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


class LocalRepositoryHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], api: LocalRepositoryApi):
        super().__init__(server_address, LocalRepositoryRequestHandler)
        self.api = api


class LocalRepositoryRequestHandler(BaseHTTPRequestHandler):
    server_version = "OpenJiuwenLocal/0.1"
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin")
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
            self._api.dispatch("POST", self.path, body=body, origin=origin),
            origin,
        )

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
            value = json.loads(raw_body.decode("utf-8"))
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
        self.wfile.write(payload)

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
