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

    api = LocalRepositoryApi(config)
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
