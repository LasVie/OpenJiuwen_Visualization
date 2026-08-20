"""Command line entry points for serving and smoke-testing repository scans."""

from __future__ import annotations

import argparse
import ipaddress
import json
import logging
from collections.abc import Sequence

from .app import LocalRepositoryApi, create_http_server
from .config import LocalServiceConfig


DEFAULT_ORIGINS = (
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--allow-root",
        action="append",
        required=True,
        help="Directory the service may read. Repeat for multiple roots.",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Run the loopback HTTP service.")
    _add_common_arguments(serve)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--allow-origin", action="append", default=[])
    serve.add_argument(
        "--archive-path",
        help="SQLite archive path inside an allowed root.",
    )
    serve.add_argument("--archive-retention-days", type=int, default=30)
    serve.add_argument("--archive-max-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    serve.add_argument(
        "--development-session-path",
        help="Development analysis Session SQLite path inside an allowed root.",
    )
    serve.add_argument("--development-session-retention-days", type=int, default=30)
    serve.add_argument(
        "--development-session-max-bytes",
        type=int,
        default=2 * 1024 * 1024 * 1024,
    )
    serve.add_argument(
        "--plugin-host-path",
        help="Plugin Host SQLite path inside an allowed root.",
    )
    serve.add_argument(
        "--connection-settings-path",
        help="Connection settings SQLite path inside an allowed root.",
    )
    serve.add_argument(
        "--managed-source-root",
        help="Directory for public GitHub repository checkouts.",
    )
    serve.add_argument(
        "--disable-system-credential-store",
        action="store_true",
        help="Disable write-only operating-system credential storage.",
    )
    serve.add_argument(
        "--development-execution-path",
        help="Controlled Development execution SQLite path inside an allowed root.",
    )
    serve.add_argument(
        "--development-worktree-root",
        help="Directory for isolated controlled Development worktrees.",
    )
    serve.add_argument(
        "--allow-unsigned-plugins",
        action="store_true",
        help=(
            "Enable declarative discovery of unsigned local manifests. "
            "V1 never executes their code."
        ),
    )
    serve.add_argument(
        "--plugin-dev-root",
        action="append",
        default=[],
        help=(
            "Explicit path scope for unsigned *.openjiuwen-plugin.json manifests. "
            "Repeat for multiple roots."
        ),
    )

    scan = subparsers.add_parser("scan", help="Scan one repository and print JSON.")
    _add_common_arguments(scan)
    scan.add_argument("--path", required=True)
    scan.add_argument("--include-tests", action="store_true")
    scan.add_argument("--include-functions", action="store_true")
    scan.add_argument("--max-files", type=int, default=5_000)
    scan.add_argument("--max-edges", type=int, default=20_000)
    scan.add_argument("--summary", action="store_true")
    return parser


def _loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _config(arguments: argparse.Namespace) -> LocalServiceConfig:
    origins = arguments.allow_origin if hasattr(arguments, "allow_origin") else []
    return LocalServiceConfig.create(
        allowed_roots=arguments.allow_root,
        allowed_origins=origins or DEFAULT_ORIGINS,
        archive_path=getattr(arguments, "archive_path", None),
        archive_retention_days=getattr(arguments, "archive_retention_days", 30),
        archive_max_bytes=getattr(
            arguments,
            "archive_max_bytes",
            2 * 1024 * 1024 * 1024,
        ),
        development_session_path=getattr(
            arguments, "development_session_path", None
        ),
        development_session_retention_days=getattr(
            arguments, "development_session_retention_days", 30
        ),
        development_session_max_bytes=getattr(
            arguments,
            "development_session_max_bytes",
            2 * 1024 * 1024 * 1024,
        ),
        development_execution_path=getattr(
            arguments, "development_execution_path", None
        ),
        development_worktree_root=getattr(
            arguments, "development_worktree_root", None
        ),
        plugin_host_path=getattr(arguments, "plugin_host_path", None),
        connection_settings_path=getattr(
            arguments, "connection_settings_path", None
        ),
        managed_source_root=getattr(arguments, "managed_source_root", None),
        system_credentials_enabled=(
            getattr(arguments, "command", None) == "serve"
            and not getattr(arguments, "disable_system_credential_store", False)
        ),
        allow_unsigned_plugins=getattr(arguments, "allow_unsigned_plugins", False),
        plugin_developer_roots=getattr(arguments, "plugin_dev_root", ()),
    )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _build_parser().parse_args(argv)
    config = _config(arguments)

    if arguments.command == "serve":
        if not _loopback_host(arguments.host):
            raise SystemExit("The local service only binds to a loopback host.")
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
        server = create_http_server(config, host=arguments.host, port=arguments.port)
        print(
            f"OpenJiuwen local companion service listening on "
            f"http://{arguments.host}:{arguments.port}",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0

    api = LocalRepositoryApi(
        config,
        archive_enabled=False,
        plugin_host_enabled=False,
    )
    response = api.dispatch(
        "POST",
        "/api/v1/repositories/scan",
        body={
            "path": arguments.path,
            "options": {
                "includeTests": arguments.include_tests,
                "includeFunctions": arguments.include_functions,
                "maxFiles": arguments.max_files,
                "maxEdges": arguments.max_edges,
            },
        },
    )
    output: object = response.body
    if arguments.summary and response.status == 200:
        output = {
            "repository": response.body["repository"],
            "statistics": response.body["statistics"],
            "warnings": response.body["warnings"],
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if response.status == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
