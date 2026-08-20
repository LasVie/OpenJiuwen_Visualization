"""Dependency-free loopback API for repository inspection and runtime traces."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from .agent_core_runtime import (
    AgentCoreRuntimeAdapter,
    AgentCoreRuntimeConfig,
    AgentCoreRuntimeError,
)
from .config import LocalServiceConfig, PathAccessError
from .development_sessions import (
    DEVELOPMENT_SESSION_API_VERSION,
    DevelopmentSessionError,
    DevelopmentSessionStore,
)
from .development_execution import (
    DEVELOPMENT_EXECUTION_API_VERSION,
    DevelopmentExecutionError,
    DevelopmentExecutionStore,
)
from .git_changes import GitChangeError, GitChangeInspector, GitChangeOptions
from .github_pull_requests import (
    GitHubPullRequestError,
    GitHubPullRequestInspector,
    GitHubPullRequestOptions,
    GitHubPullRequestReference,
)
from .jiuwenswarm_runtime import (
    JiuwenSwarmRuntimeAdapter,
    JiuwenSwarmRuntimeConfig,
    JiuwenSwarmRuntimeError,
)
from .openrouter_provider import (
    OpenRouterProviderConfig,
    OpenRouterProviderError,
    OpenRouterRuntimeAdapter,
)
from .openrouter_credentials import (
    OPENROUTER_SECRET_HANDLE_ID,
    OpenRouterCredentialController,
    OpenRouterCredentialError,
)
from .plugin_host import (
    DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
    OPENROUTER_HOST_PLUGIN_ID,
    TOOL_CATALOG_HOST_PLUGIN_ID,
    PluginAuthorization,
    PluginHost,
    PluginHostError,
)
from .repository import RepositoryResolutionError, RepositoryResolver
from .repository_connections import (
    REPOSITORY_CONNECTION_API_VERSION,
    RepositoryConnectionError,
    RepositoryConnectionStore,
)
from .secret_store import system_secret_store
from .scan_cache import DefinitionScanCache
from .source_reader import SourceReadError, SourceReadOptions, SourceReader
from .subagent_runtime import (
    SubagentRuntimeAdapter,
    SubagentRuntimeConfig,
    SubagentRuntimeError,
)
from .swarmflow_runtime import (
    SwarmFlowRuntimeAdapter,
    SwarmFlowRuntimeConfig,
    SwarmFlowRuntimeError,
)
from .scanner import (
    PythonRepositoryScanner,
    ScanOptions,
    ToolCatalogOptions,
    ToolCatalogScanner,
)
from .trace_store import API_VERSION as TRACE_API_VERSION
from .trace_store import RuntimeTraceStore, TraceStoreError
from .trace_archive import (
    ARCHIVE_API_VERSION,
    TraceArchiveError,
    TraceArchiveStore,
)


LOGGER = logging.getLogger(__name__)
TRACE_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)$")
TRACE_EVENTS_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)/events$")
TRACE_STREAM_ROUTE = re.compile(r"^/api/v1/traces/([^/]+)/stream$")
ARCHIVE_SESSION_ROUTE = re.compile(r"^/api/v1/archive/sessions/([^/]+)$")
ARCHIVE_RAW_ROUTE = re.compile(r"^/api/v1/archive/sessions/([^/]+)/raw$")
ARCHIVE_EXPORT_ROUTE = re.compile(r"^/api/v1/archive/sessions/([^/]+)/export$")
DEVELOPMENT_SESSION_ROUTE = re.compile(r"^/api/v1/development/sessions/([^/]+)$")
DEVELOPMENT_SESSION_EXPORT_ROUTE = re.compile(
    r"^/api/v1/development/sessions/([^/]+)/export$"
)
DEVELOPMENT_EXECUTION_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)$"
)
DEVELOPMENT_EXECUTION_APPLY_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)/apply$"
)
DEVELOPMENT_EXECUTION_TEST_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)/tests$"
)
DEVELOPMENT_EXECUTION_COMMIT_PREVIEW_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)/commit-preview$"
)
DEVELOPMENT_EXECUTION_COMMIT_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)/commit$"
)
DEVELOPMENT_EXECUTION_ROLLBACK_ROUTE = re.compile(
    r"^/api/v1/development/executions/([^/]+)/rollback$"
)
OPENROUTER_CANCEL_ROUTE = re.compile(
    r"^/api/v1/model-providers/openrouter/invocations/([^/]+)/cancel$"
)
AGENT_CORE_CANCEL_ROUTE = re.compile(
    r"^/api/v1/agent-core/invocations/([^/]+)/cancel$"
)
JIUWENSWARM_CANCEL_ROUTE = re.compile(
    r"^/api/v1/jiuwenswarm/invocations/([^/]+)/cancel$"
)
SUBAGENT_CANCEL_ROUTE = re.compile(
    r"^/api/v1/subagents/invocations/([^/]+)/cancel$"
)
SWARMFLOW_CANCEL_ROUTE = re.compile(
    r"^/api/v1/swarmflows/invocations/([^/]+)/cancel$"
)
PLUGIN_STATE_ROUTE = re.compile(
    r"^/api/v1/plugin-host/plugins/([^/]+)/state$"
)
PLUGIN_PERMISSION_ROUTE = re.compile(
    r"^/api/v1/plugin-host/plugins/([^/]+)/permissions/([^/]+)$"
)
REPOSITORY_CONNECTION_ROUTE = re.compile(
    r"^/api/v1/settings/repositories/(agent-core|jiuwenswarm)$"
)
REPOSITORY_CONNECTION_SYNC_ROUTE = re.compile(
    r"^/api/v1/settings/repositories/(agent-core|jiuwenswarm)/sync$"
)


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
        scan_cache: DefinitionScanCache | None = None,
        tool_catalog_scanner: ToolCatalogScanner | None = None,
        trace_store: RuntimeTraceStore | None = None,
        change_inspector: GitChangeInspector | None = None,
        github_pull_request_inspector: GitHubPullRequestInspector | None = None,
        source_reader: SourceReader | None = None,
        openrouter_adapter: OpenRouterRuntimeAdapter | None = None,
        openrouter_credentials: OpenRouterCredentialController | None = None,
        agent_core_adapter: AgentCoreRuntimeAdapter | None = None,
        jiuwenswarm_adapter: JiuwenSwarmRuntimeAdapter | None = None,
        subagent_adapter: SubagentRuntimeAdapter | None = None,
        swarmflow_adapter: SwarmFlowRuntimeAdapter | None = None,
        archive_store: TraceArchiveStore | None = None,
        archive_enabled: bool = True,
        development_session_store: DevelopmentSessionStore | None = None,
        development_sessions_enabled: bool = True,
        development_execution_store: DevelopmentExecutionStore | None = None,
        development_execution_enabled: bool = True,
        plugin_host: PluginHost | None = None,
        plugin_host_enabled: bool = True,
        repository_connections: RepositoryConnectionStore | None = None,
    ) -> None:
        self.config = config
        self._resolver = resolver or RepositoryResolver(config)
        self._scan_cache = scan_cache or DefinitionScanCache(
            scanner or PythonRepositoryScanner()
        )
        self._tool_catalog_scanner = tool_catalog_scanner or ToolCatalogScanner()
        archive_path = config.archive_path or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "runtime-archive.sqlite3"
        )
        self.archive_store = (
            archive_store
            if archive_store is not None
            else TraceArchiveStore(
                archive_path,
                retention_days=config.archive_retention_days,
                max_bytes=config.archive_max_bytes,
            )
            if archive_enabled
            else None
        )
        self.trace_store = trace_store or RuntimeTraceStore()
        self.trace_store.set_archive_sink(self.archive_store)
        development_session_path = config.development_session_path or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "development-sessions.sqlite3"
        )
        self.development_session_store = (
            development_session_store
            if development_session_store is not None
            else DevelopmentSessionStore(
                development_session_path,
                retention_days=config.development_session_retention_days,
                max_bytes=config.development_session_max_bytes,
            )
            if development_sessions_enabled
            else None
        )
        development_execution_path = config.development_execution_path or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "development-executions.sqlite3"
        )
        development_worktree_root = config.development_worktree_root or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "development-worktrees"
        )
        self.development_execution_store = (
            development_execution_store
            if development_execution_store is not None
            else DevelopmentExecutionStore(
                development_execution_path,
                development_worktree_root,
            )
            if development_execution_enabled
            else None
        )
        self._change_inspector = change_inspector or GitChangeInspector()
        self._github_pull_request_inspector = (
            github_pull_request_inspector or GitHubPullRequestInspector()
        )
        self._source_reader = source_reader or SourceReader()
        provider_config = (
            openrouter_adapter.config
            if openrouter_adapter is not None
            else openrouter_credentials.config
            if openrouter_credentials is not None
            else OpenRouterProviderConfig.from_environment()
        )
        self.openrouter_credentials = (
            openrouter_credentials
            if openrouter_credentials is not None
            else OpenRouterCredentialController(
                provider_config,
                system_secret_store(enabled=config.system_credentials_enabled),
            )
        )
        if self.openrouter_credentials.config is not provider_config:
            raise ValueError(
                "OpenRouter credential controller and runtime adapter must share one config."
            )
        self._provider_control_lock = threading.RLock()
        plugin_host_path = config.plugin_host_path or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "plugin-host.sqlite3"
        )
        self.plugin_host = (
            plugin_host
            if plugin_host is not None
            else PluginHost(
                plugin_host_path,
                secret_resolvers={
                    "openrouter.default": lambda: provider_config.configured,
                },
                allow_unsigned_plugins=config.allow_unsigned_plugins,
                developer_roots=config.plugin_developer_roots,
            )
            if plugin_host_enabled
            else None
        )
        self.openrouter_adapter = openrouter_adapter or OpenRouterRuntimeAdapter(
            provider_config,
            self.trace_store,
        )
        self.agent_core_adapter = agent_core_adapter or AgentCoreRuntimeAdapter(
            AgentCoreRuntimeConfig.from_environment(provider_config),
            self.trace_store,
        )
        self.jiuwenswarm_adapter = jiuwenswarm_adapter or JiuwenSwarmRuntimeAdapter(
            JiuwenSwarmRuntimeConfig.from_environment(provider_config),
            self.trace_store,
        )
        self.subagent_adapter = subagent_adapter or SubagentRuntimeAdapter(
            SubagentRuntimeConfig.from_environment(provider_config),
            self.trace_store,
        )
        self.swarmflow_adapter = swarmflow_adapter or SwarmFlowRuntimeAdapter(
            SwarmFlowRuntimeConfig.from_environment(provider_config),
            self.trace_store,
        )
        connection_settings_path = config.connection_settings_path or (
            config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "connection-settings.sqlite3"
        )
        self.repository_connections = repository_connections or RepositoryConnectionStore(
            config,
            self._resolver,
            default_paths={
                "agent-core": self.agent_core_adapter.config.source_root,
                "jiuwenswarm": self.jiuwenswarm_adapter.config.source_root,
            },
            database_path=connection_settings_path,
        )
        self._apply_repository_connections()

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
            openrouter_authorization = self._host_authorization(
                OPENROUTER_HOST_PLUGIN_ID
            )
            tool_authorization = self._host_authorization(
                TOOL_CATALOG_HOST_PLUGIN_ID
            )
            development_execution_authorization = self._host_authorization(
                DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID
            )
            openrouter_ready = (
                openrouter_authorization.allowed
                and self.openrouter_adapter.config.configured
            )
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "apiVersion": "1.0.0",
                    "mode": "read-only",
                    "capabilities": [
                        "repository.read",
                        "repository.scan.cache.memory",
                        *(
                            ["repository.tools.read"]
                            if tool_authorization.allowed
                            else []
                        ),
                        "repository.source.read",
                        "repository.binding.local",
                        "repository.binding.github.public",
                        "git.change.read",
                        "github.pull-request.read",
                        "trace.ephemeral",
                        *(["trace.archive.sqlite"] if self.archive_store else []),
                        *(
                            ["development.session.sqlite"]
                            if self.development_session_store
                            else []
                        ),
                        *(
                            ["development.execution.controlled"]
                            if self.development_execution_store
                            and development_execution_authorization.allowed
                            else []
                        ),
                        "model.provider.openrouter.registry",
                        *(["model.provider.openrouter.invoke"] if openrouter_ready else []),
                        "runtime.agent-core.registry",
                        "runtime.jiuwenswarm.registry",
                        "runtime.subagent.registry",
                        "runtime.swarmflow.registry",
                        "plugin.host.registry",
                        "plugin.host.audit.local",
                    ],
                    "traceStorage": "memory-live+sqlite-archive"
                    if self.archive_store
                    else "memory-only",
                    "archiveStorage": self.archive_store.descriptor()
                    if self.archive_store
                    else None,
                    "developmentSessionStorage": self.development_session_store.descriptor()
                    if self.development_session_store
                    else None,
                    "developmentExecutionStorage": {
                        "apiVersion": DEVELOPMENT_EXECUTION_API_VERSION,
                        **self.development_execution_store.descriptor(),
                    }
                    if self.development_execution_store
                    else None,
                    "pluginHost": {
                        "enabled": self.plugin_host is not None,
                        "openRouterStatus": openrouter_authorization.plugin_status,
                        "toolCatalogStatus": tool_authorization.plugin_status,
                        "developmentExecutorStatus": development_execution_authorization.plugin_status,
                    },
                },
            )
        if method == "GET" and route == "/api/v1/plugin-host":
            if self.plugin_host is None:
                return _error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "plugin_host_disabled",
                    "Plugin Host is disabled for this service process.",
                )
            return ApiResponse(HTTPStatus.OK, self.plugin_host.descriptor())
        if method == "GET" and route == "/api/v1/plugin-host/audit":
            return self._plugin_host_audit(split_path.query)
        if method == "GET" and route == "/api/v1/settings":
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "apiVersion": "1.0.0",
                    "settings": {
                        "openRouter": self.openrouter_credentials.descriptor()[
                            "credential"
                        ],
                        "repositories": self.repository_connections.descriptor(),
                        "service": {
                            "transport": "loopback-http",
                            "remoteAccess": False,
                        },
                    },
                },
            )
        if method == "GET" and route == "/api/v1/model-providers/openrouter":
            return ApiResponse(HTTPStatus.OK, self._provider_descriptor())
        if method == "GET" and route == "/api/v1/agent-core":
            refresh = parse_qs(split_path.query).get("refresh", ["0"])[0] == "1"
            return ApiResponse(
                HTTPStatus.OK,
                self._runtime_descriptor(
                    self.agent_core_adapter.descriptor(refresh=refresh)
                ),
            )
        if method == "GET" and route == "/api/v1/jiuwenswarm":
            refresh = parse_qs(split_path.query).get("refresh", ["0"])[0] == "1"
            return ApiResponse(
                HTTPStatus.OK,
                self._runtime_descriptor(
                    self.jiuwenswarm_adapter.descriptor(refresh=refresh)
                ),
            )
        if method == "GET" and route == "/api/v1/subagents":
            refresh = parse_qs(split_path.query).get("refresh", ["0"])[0] == "1"
            return ApiResponse(
                HTTPStatus.OK,
                self._runtime_descriptor(
                    self.subagent_adapter.descriptor(refresh=refresh)
                ),
            )
        if method == "GET" and route == "/api/v1/swarmflows":
            refresh = parse_qs(split_path.query).get("refresh", ["0"])[0] == "1"
            return ApiResponse(
                HTTPStatus.OK,
                self._runtime_descriptor(
                    self.swarmflow_adapter.descriptor(refresh=refresh)
                ),
            )
        if method == "GET" and route == "/api/v1/repositories":
            repositories = {
                identity.id: identity
                for identity in self._resolver.discover()
            }
            repositories.update(
                {
                    identity.id: identity
                    for identity in self.repository_connections.identities()
                }
            )
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "allowedRoots": [str(root) for root in self.config.allowed_roots],
                    "repositories": [
                        identity.to_api_dict()
                        for identity in sorted(
                            repositories.values(),
                            key=lambda item: (item.owner, item.name.casefold()),
                        )
                    ],
                    "writeOperations": False,
                },
            )
        if method == "GET" and route == "/api/v1/archive":
            if self.archive_store is None:
                return _error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "archive_disabled",
                    "Trace archive is disabled.",
                )
            return ApiResponse(
                HTTPStatus.OK,
                {
                    "apiVersion": ARCHIVE_API_VERSION,
                    "storage": self.archive_store.descriptor(),
                },
            )
        if method == "GET" and route == "/api/v1/archive/sessions":
            return self._archive_list(split_path.query)
        if method == "GET" and route == "/api/v1/development/sessions":
            return self._development_session_list(split_path.query)
        if method == "POST" and route == "/api/v1/development/sessions":
            return self._development_session_create(body or {})
        if method == "GET" and route == "/api/v1/development/executions":
            return self._development_execution_list(split_path.query)
        if method == "POST" and route == "/api/v1/development/executions":
            return self._development_execution_preview(body or {})
        if method == "POST" and route == "/api/v1/repositories/scan":
            return self._scan(body or {})
        if method == "POST" and route == "/api/v1/repositories/source":
            return self._source(body or {})
        if method == "POST" and route == "/api/v1/repositories/tools":
            return self._tool_catalog(body or {})
        if method == "POST" and route == "/api/v1/repositories/changes":
            return self._changes(body or {})
        if method == "POST" and route == "/api/v1/repositories/github/pull-request":
            return self._github_pull_request(body or {})
        if method == "POST" and route == "/api/v1/traces":
            return self._create_trace(body or {})
        if method == "POST" and route == "/api/v1/model-providers/openrouter/invocations":
            return self._start_openrouter(body or {}, trace_token)
        if method == "POST" and route == "/api/v1/settings/openrouter/credential":
            return self._set_openrouter_credential(body or {})
        repository_sync_match = REPOSITORY_CONNECTION_SYNC_ROUTE.fullmatch(route)
        if method == "POST" and repository_sync_match:
            return self._sync_repository_connection(repository_sync_match.group(1))
        repository_connection_match = REPOSITORY_CONNECTION_ROUTE.fullmatch(route)
        if method == "POST" and repository_connection_match:
            return self._set_repository_connection(
                repository_connection_match.group(1),
                body or {},
            )
        if method == "POST" and route == "/api/v1/agent-core/invocations":
            return self._start_agent_core(body or {}, trace_token)
        if method == "POST" and route == "/api/v1/jiuwenswarm/invocations":
            return self._start_jiuwenswarm(body or {}, trace_token)
        if method == "POST" and route == "/api/v1/subagents/invocations":
            return self._start_subagent(body or {}, trace_token)
        if method == "POST" and route == "/api/v1/swarmflows/invocations":
            return self._start_swarmflow(body or {}, trace_token)
        plugin_state_match = PLUGIN_STATE_ROUTE.fullmatch(route)
        if method == "POST" and plugin_state_match:
            return self._set_plugin_state(
                unquote(plugin_state_match.group(1)),
                body or {},
            )
        plugin_permission_match = PLUGIN_PERMISSION_ROUTE.fullmatch(route)
        if method == "POST" and plugin_permission_match:
            return self._set_plugin_permission(
                unquote(plugin_permission_match.group(1)),
                unquote(plugin_permission_match.group(2)),
                body or {},
            )
        openrouter_cancel_match = OPENROUTER_CANCEL_ROUTE.fullmatch(route)
        if method == "POST" and openrouter_cancel_match:
            return self._cancel_openrouter(openrouter_cancel_match.group(1), trace_token)
        agent_core_cancel_match = AGENT_CORE_CANCEL_ROUTE.fullmatch(route)
        if method == "POST" and agent_core_cancel_match:
            return self._cancel_agent_core(agent_core_cancel_match.group(1), trace_token)
        jiuwenswarm_cancel_match = JIUWENSWARM_CANCEL_ROUTE.fullmatch(route)
        if method == "POST" and jiuwenswarm_cancel_match:
            return self._cancel_jiuwenswarm(jiuwenswarm_cancel_match.group(1), trace_token)
        subagent_cancel_match = SUBAGENT_CANCEL_ROUTE.fullmatch(route)
        if method == "POST" and subagent_cancel_match:
            return self._cancel_subagent(subagent_cancel_match.group(1), trace_token)
        swarmflow_cancel_match = SWARMFLOW_CANCEL_ROUTE.fullmatch(route)
        if method == "POST" and swarmflow_cancel_match:
            return self._cancel_swarmflow(swarmflow_cancel_match.group(1), trace_token)
        archive_raw_match = ARCHIVE_RAW_ROUTE.fullmatch(route)
        if method == "POST" and archive_raw_match:
            return self._archive_raw(archive_raw_match.group(1), body or {})
        archive_export_match = ARCHIVE_EXPORT_ROUTE.fullmatch(route)
        if method == "GET" and archive_export_match:
            return self._archive_export(archive_export_match.group(1))
        archive_session_match = ARCHIVE_SESSION_ROUTE.fullmatch(route)
        if method == "GET" and archive_session_match:
            return self._archive_session(archive_session_match.group(1), split_path.query)
        if method == "DELETE" and archive_session_match:
            return self._archive_delete(archive_session_match.group(1))
        development_export_match = DEVELOPMENT_SESSION_EXPORT_ROUTE.fullmatch(route)
        if method == "GET" and development_export_match:
            return self._development_session_export(
                unquote(development_export_match.group(1))
            )
        development_session_match = DEVELOPMENT_SESSION_ROUTE.fullmatch(route)
        if method == "GET" and development_session_match:
            return self._development_session_get(
                unquote(development_session_match.group(1))
            )
        if method == "DELETE" and development_session_match:
            return self._development_session_delete(
                unquote(development_session_match.group(1))
            )
        if method == "DELETE" and route == "/api/v1/settings/openrouter/credential":
            return self._delete_openrouter_credential()
        repository_connection_match = REPOSITORY_CONNECTION_ROUTE.fullmatch(route)
        if method == "DELETE" and repository_connection_match:
            return self._reset_repository_connection(
                repository_connection_match.group(1)
            )
        development_apply_match = DEVELOPMENT_EXECUTION_APPLY_ROUTE.fullmatch(route)
        if method == "POST" and development_apply_match:
            return self._development_execution_apply(
                unquote(development_apply_match.group(1)), body or {}
            )
        development_test_match = DEVELOPMENT_EXECUTION_TEST_ROUTE.fullmatch(route)
        if method == "POST" and development_test_match:
            return self._development_execution_test(
                unquote(development_test_match.group(1)), body or {}
            )
        development_commit_preview_match = (
            DEVELOPMENT_EXECUTION_COMMIT_PREVIEW_ROUTE.fullmatch(route)
        )
        if method == "POST" and development_commit_preview_match:
            return self._development_execution_commit_preview(
                unquote(development_commit_preview_match.group(1)), body or {}
            )
        development_commit_match = DEVELOPMENT_EXECUTION_COMMIT_ROUTE.fullmatch(route)
        if method == "POST" and development_commit_match:
            return self._development_execution_commit(
                unquote(development_commit_match.group(1)), body or {}
            )
        development_rollback_match = DEVELOPMENT_EXECUTION_ROLLBACK_ROUTE.fullmatch(route)
        if method == "POST" and development_rollback_match:
            return self._development_execution_rollback(
                unquote(development_rollback_match.group(1)), body or {}
            )
        development_execution_match = DEVELOPMENT_EXECUTION_ROUTE.fullmatch(route)
        if method == "GET" and development_execution_match:
            return self._development_execution_get(
                unquote(development_execution_match.group(1))
            )
        trace_match = TRACE_ROUTE.fullmatch(route)
        if method == "GET" and trace_match:
            return self._trace_snapshot(trace_match.group(1), split_path.query)
        events_match = TRACE_EVENTS_ROUTE.fullmatch(route)
        if method == "POST" and events_match:
            return self._append_trace(events_match.group(1), trace_token, body or {})
        return _error(HTTPStatus.NOT_FOUND, "not_found", "API route was not found.")

    def _host_authorization(self, plugin_id: str) -> PluginAuthorization:
        if self.plugin_host is None:
            return PluginAuthorization(
                True,
                "host_bypass_internal",
                "Plugin Host is disabled for this internal API instance.",
                "active",
            )
        try:
            return self.plugin_host.authorize(plugin_id)
        except PluginHostError as exc:
            return PluginAuthorization(False, exc.code, str(exc), "blocked")

    def _host_gate(self, plugin_id: str) -> ApiResponse | None:
        authorization = self._host_authorization(plugin_id)
        if authorization.allowed:
            return None
        status = (
            HTTPStatus.SERVICE_UNAVAILABLE
            if authorization.code == "plugin_disabled"
            else HTTPStatus.FORBIDDEN
        )
        return _error(status, authorization.code, authorization.message)

    def _provider_descriptor(self) -> dict[str, object]:
        descriptor = self.openrouter_adapter.descriptor()
        provider = descriptor.get("provider")
        authorization = self._host_authorization(OPENROUTER_HOST_PLUGIN_ID)
        if isinstance(provider, dict):
            provider["host"] = {
                "pluginId": OPENROUTER_HOST_PLUGIN_ID,
                "status": authorization.plugin_status,
                "diagnostic": {
                    "code": authorization.code,
                    "message": authorization.message,
                },
            }
            if not authorization.allowed:
                provider["status"] = (
                    "disabled"
                    if authorization.plugin_status == "disabled"
                    else "blocked"
                )
                provider["configured"] = False
        return descriptor

    def _runtime_descriptor(self, descriptor: dict[str, object]) -> dict[str, object]:
        runtime = descriptor.get("runtime")
        authorization = self._host_authorization(OPENROUTER_HOST_PLUGIN_ID)
        if isinstance(runtime, dict):
            runtime["host"] = {
                "pluginId": OPENROUTER_HOST_PLUGIN_ID,
                "status": authorization.plugin_status,
            }
            if not authorization.allowed:
                runtime["status"] = "unavailable"
                runtime["configured"] = False
                runtime["diagnostic"] = {
                    "code": authorization.code,
                    "message": authorization.message,
                }
        return descriptor

    def _plugin_host_audit(self, query: str) -> ApiResponse:
        if self.plugin_host is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "plugin_host_disabled",
                "Plugin Host is disabled for this service process.",
            )
        parameters = parse_qs(query)
        try:
            after = int(parameters.get("after", ["0"])[0])
            limit = int(parameters.get("limit", ["100"])[0])
            return ApiResponse(
                HTTPStatus.OK,
                self.plugin_host.audit_events(after=after, limit=limit),
            )
        except (ValueError, PluginHostError) as exc:
            if isinstance(exc, PluginHostError):
                return _error(exc.status, exc.code, str(exc))
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_audit_cursor",
                "after and limit must be integers.",
            )

    def _set_plugin_state(
        self,
        plugin_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        if self.plugin_host is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "plugin_host_disabled",
                "Plugin Host is disabled for this service process.",
            )
        unknown = set(body) - {"enabled", "confirmed"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_plugin_state",
                f"Unsupported plugin state field: {sorted(unknown)[0]}",
            )
        confirmed = body.get("confirmed", False)
        if not isinstance(confirmed, bool):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_plugin_state",
                "confirmed must be a boolean.",
            )
        try:
            result = self.plugin_host.set_enabled(
                plugin_id,
                body.get("enabled"),
                confirmed=confirmed,
            )
        except PluginHostError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _set_plugin_permission(
        self,
        plugin_id: str,
        permission_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        if self.plugin_host is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "plugin_host_disabled",
                "Plugin Host is disabled for this service process.",
            )
        unknown = set(body) - {"granted"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_permission_grant",
                f"Unsupported permission field: {sorted(unknown)[0]}",
            )
        try:
            result = self.plugin_host.set_permission(
                plugin_id,
                permission_id,
                body.get("granted"),
            )
        except PluginHostError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _active_provider_invocations(self) -> int:
        return sum(
            int(getattr(adapter, "active_invocations", 0))
            for adapter in (
                self.openrouter_adapter,
                self.agent_core_adapter,
                self.jiuwenswarm_adapter,
                self.subagent_adapter,
                self.swarmflow_adapter,
            )
        )

    def _apply_repository_connections(self) -> None:
        agent_core_root = self.repository_connections.effective_path("agent-core")
        jiuwenswarm_root = self.repository_connections.effective_path("jiuwenswarm")
        self.agent_core_adapter.rebind_source_root(agent_core_root)
        self.jiuwenswarm_adapter.rebind_source_roots(
            jiuwenswarm_root,
            agent_core_root,
        )
        self.subagent_adapter.rebind_agent_core_root(agent_core_root)
        self.swarmflow_adapter.rebind_source_roots(
            jiuwenswarm_root,
            agent_core_root,
        )

    @staticmethod
    def _repository_connection_response(
        connection: dict[str, object],
    ) -> ApiResponse:
        return ApiResponse(
            HTTPStatus.OK,
            {
                "apiVersion": REPOSITORY_CONNECTION_API_VERSION,
                "connection": connection,
            },
        )

    def _set_repository_connection(
        self,
        slot: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        kind = body.get("kind")
        allowed_fields = (
            {"kind", "path"}
            if kind == "local"
            else {"kind", "url", "ref"}
            if kind == "github"
            else {"kind"}
        )
        unknown = set(body) - allowed_fields
        if unknown or kind not in {"local", "github"}:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_repository_connection",
                "Repository connection must be local(path) or github(url, optional ref).",
            )
        with self._provider_control_lock:
            if self._active_provider_invocations():
                return _error(
                    HTTPStatus.CONFLICT,
                    "runtime_busy",
                    "Stop active model and Agent runs before changing repository sources.",
                )
            try:
                connection = (
                    self.repository_connections.bind_local(slot, body.get("path"))
                    if kind == "local"
                    else self.repository_connections.bind_github(
                        slot,
                        body.get("url"),
                        body.get("ref"),
                    )
                )
                self._apply_repository_connections()
            except RepositoryConnectionError as exc:
                return _error(exc.status, exc.code, str(exc))
            return self._repository_connection_response(connection)

    def _sync_repository_connection(self, slot: str) -> ApiResponse:
        with self._provider_control_lock:
            if self._active_provider_invocations():
                return _error(
                    HTTPStatus.CONFLICT,
                    "runtime_busy",
                    "Stop active model and Agent runs before synchronizing repository sources.",
                )
            try:
                connection = self.repository_connections.sync(slot)
                self._apply_repository_connections()
            except RepositoryConnectionError as exc:
                return _error(exc.status, exc.code, str(exc))
            return self._repository_connection_response(connection)

    def _reset_repository_connection(self, slot: str) -> ApiResponse:
        with self._provider_control_lock:
            if self._active_provider_invocations():
                return _error(
                    HTTPStatus.CONFLICT,
                    "runtime_busy",
                    "Stop active model and Agent runs before resetting repository sources.",
                )
            try:
                connection = self.repository_connections.reset(slot)
                self._apply_repository_connections()
            except RepositoryConnectionError as exc:
                return _error(exc.status, exc.code, str(exc))
            return self._repository_connection_response(connection)

    def _record_openrouter_secret_event(
        self,
        *,
        operation: str,
        outcome: str,
        detail_code: str,
    ) -> None:
        if self.plugin_host is None:
            return
        try:
            self.plugin_host.record_secret_event(
                OPENROUTER_HOST_PLUGIN_ID,
                OPENROUTER_SECRET_HANDLE_ID,
                operation=operation,
                outcome=outcome,
                detail_code=detail_code,
            )
        except PluginHostError:
            LOGGER.exception("OpenRouter credential audit failed")

    def _set_openrouter_credential(self, body: dict[str, Any]) -> ApiResponse:
        unknown = set(body) - {"apiKey"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_openrouter_credential",
                "The credential request contains unsupported fields.",
            )
        with self._provider_control_lock:
            if self._active_provider_invocations():
                return _error(
                    HTTPStatus.CONFLICT,
                    "provider_busy",
                    "Stop active model and Agent runs before changing the OpenRouter credential.",
                )
            try:
                result = self.openrouter_credentials.set(body.get("apiKey"))
            except OpenRouterCredentialError as exc:
                self._record_openrouter_secret_event(
                    operation="stored",
                    outcome="failed",
                    detail_code=exc.code,
                )
                return _error(exc.status, exc.code, str(exc))
            self._record_openrouter_secret_event(
                operation="stored",
                outcome="allowed",
                detail_code="system_credential_updated",
            )
            return ApiResponse(HTTPStatus.OK, result)

    def _delete_openrouter_credential(self) -> ApiResponse:
        with self._provider_control_lock:
            if self._active_provider_invocations():
                return _error(
                    HTTPStatus.CONFLICT,
                    "provider_busy",
                    "Stop active model and Agent runs before deleting the OpenRouter credential.",
                )
            try:
                result = self.openrouter_credentials.delete()
            except OpenRouterCredentialError as exc:
                self._record_openrouter_secret_event(
                    operation="deleted",
                    outcome="failed",
                    detail_code=exc.code,
                )
                return _error(exc.status, exc.code, str(exc))
            self._record_openrouter_secret_event(
                operation="deleted",
                outcome="allowed",
                detail_code="system_credential_removed",
            )
            return ApiResponse(HTTPStatus.OK, result)

    def _start_openrouter(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> ApiResponse:
        with self._provider_control_lock:
            denied = self._host_gate(OPENROUTER_HOST_PLUGIN_ID)
            if denied is not None:
                return denied
            try:
                result = self.openrouter_adapter.start(body, trace_token)
            except OpenRouterProviderError as exc:
                return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _cancel_openrouter(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> ApiResponse:
        try:
            result = self.openrouter_adapter.cancel(invocation_id, trace_token)
        except OpenRouterProviderError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _start_agent_core(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> ApiResponse:
        with self._provider_control_lock:
            denied = self._host_gate(OPENROUTER_HOST_PLUGIN_ID)
            if denied is not None:
                return denied
            try:
                result = self.agent_core_adapter.start(body, trace_token)
            except AgentCoreRuntimeError as exc:
                return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _cancel_agent_core(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> ApiResponse:
        try:
            result = self.agent_core_adapter.cancel(invocation_id, trace_token)
        except AgentCoreRuntimeError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _start_jiuwenswarm(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> ApiResponse:
        with self._provider_control_lock:
            denied = self._host_gate(OPENROUTER_HOST_PLUGIN_ID)
            if denied is not None:
                return denied
            try:
                result = self.jiuwenswarm_adapter.start(body, trace_token)
            except JiuwenSwarmRuntimeError as exc:
                return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _cancel_jiuwenswarm(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> ApiResponse:
        try:
            result = self.jiuwenswarm_adapter.cancel(invocation_id, trace_token)
        except JiuwenSwarmRuntimeError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _start_subagent(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> ApiResponse:
        with self._provider_control_lock:
            denied = self._host_gate(OPENROUTER_HOST_PLUGIN_ID)
            if denied is not None:
                return denied
            try:
                result = self.subagent_adapter.start(body, trace_token)
            except SubagentRuntimeError as exc:
                return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _cancel_subagent(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> ApiResponse:
        try:
            result = self.subagent_adapter.cancel(invocation_id, trace_token)
        except SubagentRuntimeError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _start_swarmflow(
        self,
        body: dict[str, Any],
        trace_token: str | None,
    ) -> ApiResponse:
        with self._provider_control_lock:
            denied = self._host_gate(OPENROUTER_HOST_PLUGIN_ID)
            if denied is not None:
                return denied
            try:
                result = self.swarmflow_adapter.start(body, trace_token)
            except SwarmFlowRuntimeError as exc:
                return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

    def _cancel_swarmflow(
        self,
        invocation_id: str,
        trace_token: str | None,
    ) -> ApiResponse:
        try:
            result = self.swarmflow_adapter.cancel(invocation_id, trace_token)
        except SwarmFlowRuntimeError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.ACCEPTED, result)

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
                "archive": {
                    "enabled": self.archive_store is not None,
                    "engine": "sqlite" if self.archive_store is not None else None,
                },
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
                "archived": self.archive_store is not None,
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

    def _archive_list(self, query: str) -> ApiResponse:
        if self.archive_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "archive_disabled",
                "Trace archive is disabled.",
            )
        values = parse_qs(query)
        try:
            result = self.archive_store.list_sessions(
                limit=int(values.get("limit", ["50"])[0]),
                offset=int(values.get("offset", ["0"])[0]),
            )
        except TraceArchiveError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_pagination",
                "Archive pagination is invalid.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _archive_session(self, trace_id: str, query: str) -> ApiResponse:
        if self.archive_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "archive_disabled",
                "Trace archive is disabled.",
            )
        values = parse_qs(query)
        try:
            result = self.archive_store.get_session(
                trace_id,
                after=int(values.get("after", ["0"])[0]),
                limit=int(values.get("limit", ["500"])[0]),
            )
        except TraceArchiveError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_pagination",
                "Archive event pagination is invalid.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _archive_raw(self, trace_id: str, body: dict[str, Any]) -> ApiResponse:
        if self.archive_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "archive_disabled",
                "Trace archive is disabled.",
            )
        mode = body.get("mode")
        try:
            if mode == "events":
                sequences = body.get("sequences")
                if not isinstance(sequences, list):
                    raise TraceArchiveError(
                        "invalid_raw_request",
                        "sequences must be an array.",
                    )
                result = self.archive_store.reveal_events(trace_id, sequences)
            elif mode == "context":
                result = self.archive_store.reveal_context(trace_id)
            else:
                raise TraceArchiveError(
                    "invalid_raw_request",
                    "mode must be events or context.",
                )
        except TraceArchiveError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _archive_export(self, trace_id: str) -> ApiResponse:
        if self.archive_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "archive_disabled",
                "Trace archive is disabled.",
            )
        try:
            result = self.archive_store.export_session(trace_id)
        except TraceArchiveError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _archive_delete(self, trace_id: str) -> ApiResponse:
        if self.archive_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "archive_disabled",
                "Trace archive is disabled.",
            )
        try:
            result = self.archive_store.delete_session(trace_id)
        except TraceArchiveError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_session_list(self, query: str) -> ApiResponse:
        if self.development_session_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_sessions_disabled",
                "Development Session persistence is disabled.",
            )
        values = parse_qs(query)
        try:
            result = self.development_session_store.list_sessions(
                limit=int(values.get("limit", ["50"])[0]),
                offset=int(values.get("offset", ["0"])[0]),
            )
        except DevelopmentSessionError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_pagination",
                "Development Session pagination is invalid.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _development_session_create(self, body: dict[str, Any]) -> ApiResponse:
        if self.development_session_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_sessions_disabled",
                "Development Session persistence is disabled.",
            )
        unknown = set(body) - {"analysis", "label"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_development_session",
                f"Unsupported Development Session field: {sorted(unknown)[0]}",
            )
        analysis = body.get("analysis")
        repository = analysis.get("repository") if isinstance(analysis, dict) else None
        repository_path = repository.get("path") if isinstance(repository, dict) else None
        try:
            if not isinstance(repository_path, str):
                raise DevelopmentSessionError(
                    "invalid_development_session",
                    "analysis.repository.path must be a string.",
                )
            self.config.authorize_directory(repository_path)
            result = self.development_session_store.create_session(
                analysis,
                label=body.get("label"),
            )
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except DevelopmentSessionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.CREATED, result)

    def _development_session_get(self, session_id: str) -> ApiResponse:
        if self.development_session_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_sessions_disabled",
                "Development Session persistence is disabled.",
            )
        try:
            result = self.development_session_store.get_session(session_id)
        except DevelopmentSessionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_session_export(self, session_id: str) -> ApiResponse:
        if self.development_session_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_sessions_disabled",
                "Development Session persistence is disabled.",
            )
        try:
            result = self.development_session_store.export_session(session_id)
        except DevelopmentSessionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_session_delete(self, session_id: str) -> ApiResponse:
        if self.development_session_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_sessions_disabled",
                "Development Session persistence is disabled.",
            )
        try:
            result = self.development_session_store.delete_session(session_id)
        except DevelopmentSessionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_list(self, query: str) -> ApiResponse:
        denied = self._host_gate(DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID)
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        values = parse_qs(query)
        try:
            result = self.development_execution_store.list_executions(
                limit=int(values.get("limit", ["50"])[0]),
                offset=int(values.get("offset", ["0"])[0]),
            )
        except (ValueError, DevelopmentExecutionError) as exc:
            if isinstance(exc, DevelopmentExecutionError):
                return _error(exc.status, exc.code, str(exc))
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_pagination",
                "Controlled execution pagination is invalid.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_preview(self, body: dict[str, Any]) -> ApiResponse:
        denied = self._host_gate(DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID)
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        unknown = set(body) - {
            "repositoryPath",
            "baseRevision",
            "intent",
            "unifiedDiff",
        }
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_execution_preview",
                f"Unsupported execution preview field: {sorted(unknown)[0]}",
            )
        repository_path = body.get("repositoryPath")
        if not isinstance(repository_path, str):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_path",
                "repositoryPath must be a string.",
            )
        try:
            identity = self._resolver.resolve(repository_path)
            result = self.development_execution_store.create_preview(
                identity,
                expected_revision=body.get("baseRevision"),
                intent=body.get("intent"),
                patch=body.get("unifiedDiff"),
            )
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                "repository_unavailable",
                str(exc),
            )
        except DevelopmentExecutionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.CREATED, result)

    def _development_execution_get(self, execution_id: str) -> ApiResponse:
        denied = self._host_gate(DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID)
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        try:
            result = self.development_execution_store.get_execution(execution_id)
        except DevelopmentExecutionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_operation_gate(
        self,
        execution_id: str,
        permission_id: str,
        *,
        confirmed: object,
        approval_sha256: object,
    ) -> ApiResponse | None:
        if confirmed is not True:
            if self.plugin_host is not None and isinstance(approval_sha256, str):
                try:
                    self.plugin_host.authorize_operation(
                        DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
                        permission_id,
                        confirmed=False,
                        target=execution_id,
                        preview_sha256=approval_sha256,
                    )
                except PluginHostError:
                    pass
            return _error(
                HTTPStatus.CONFLICT,
                "operation_confirmation_required",
                "This exact controlled operation requires explicit confirmation.",
            )
        if not isinstance(approval_sha256, str):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_operation_digest",
                "Approval digest must be a lowercase SHA-256 value.",
            )
        if self.plugin_host is None:
            if not re.fullmatch(r"[0-9a-f]{64}", approval_sha256):
                return _error(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_operation_digest",
                    "Approval digest must be a lowercase SHA-256 value.",
                )
            return None
        try:
            authorization = self.plugin_host.authorize_operation(
                DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
                permission_id,
                confirmed=True,
                target=execution_id,
                preview_sha256=approval_sha256,
            )
        except PluginHostError as exc:
            return _error(exc.status, exc.code, str(exc))
        if authorization.allowed:
            return None
        status = (
            HTTPStatus.SERVICE_UNAVAILABLE
            if authorization.code == "plugin_disabled"
            else HTTPStatus.FORBIDDEN
        )
        return _error(status, authorization.code, authorization.message)

    def _record_development_operation(
        self,
        execution_id: str,
        permission_id: str,
        *,
        outcome: str,
        detail_code: str,
    ) -> None:
        if self.plugin_host is None:
            return
        try:
            self.plugin_host.record_operation_result(
                DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
                permission_id,
                target=execution_id,
                outcome=outcome,
                detail_code=detail_code,
            )
        except PluginHostError:
            LOGGER.exception("Plugin Host could not record controlled operation result")

    def _development_execution_identity(self, execution_id: str):
        if self.development_execution_store is None:
            raise DevelopmentExecutionError(
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        value = self.development_execution_store.get_execution(execution_id)
        execution = value.get("execution")
        repository = execution.get("repository") if isinstance(execution, dict) else None
        path = repository.get("path") if isinstance(repository, dict) else None
        if not isinstance(path, str):
            raise DevelopmentExecutionError(
                "invalid_execution_repository",
                "Stored execution repository is invalid.",
            )
        return self._resolver.resolve(path)

    def _development_execution_apply(
        self,
        execution_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        unknown = set(body) - {"previewSha256", "confirmed"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_apply_request",
                f"Unsupported patch apply field: {sorted(unknown)[0]}",
            )
        preview_sha256 = body.get("previewSha256")
        denied = self._development_operation_gate(
            execution_id,
            "repository.patch.apply",
            confirmed=body.get("confirmed"),
            approval_sha256=preview_sha256,
        )
        if denied is not None:
            return denied
        try:
            identity = self._development_execution_identity(execution_id)
            assert self.development_execution_store is not None
            result = self.development_execution_store.apply(
                execution_id,
                preview_sha256=preview_sha256,
                identity=identity,
            )
        except (PathAccessError, RepositoryResolutionError) as exc:
            self._record_development_operation(
                execution_id,
                "repository.patch.apply",
                outcome="failed",
                detail_code="repository_changed",
            )
            return _error(HTTPStatus.CONFLICT, "repository_changed", str(exc))
        except DevelopmentExecutionError as exc:
            self._record_development_operation(
                execution_id,
                "repository.patch.apply",
                outcome="failed",
                detail_code=exc.code,
            )
            return _error(exc.status, exc.code, str(exc))
        self._record_development_operation(
            execution_id,
            "repository.patch.apply",
            outcome="allowed",
            detail_code="isolated_patch_applied",
        )
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_test(
        self,
        execution_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        unknown = set(body) - {
            "previewSha256",
            "profileId",
            "planSha256",
            "confirmed",
        }
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_test_request",
                f"Unsupported test field: {sorted(unknown)[0]}",
            )
        plan_sha256 = body.get("planSha256")
        denied = self._development_operation_gate(
            execution_id,
            "repository.test.run",
            confirmed=body.get("confirmed"),
            approval_sha256=plan_sha256,
        )
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        try:
            result = self.development_execution_store.run_test(
                execution_id,
                preview_sha256=body.get("previewSha256"),
                profile_id=body.get("profileId"),
                plan_sha256=plan_sha256,
            )
        except DevelopmentExecutionError as exc:
            self._record_development_operation(
                execution_id,
                "repository.test.run",
                outcome="failed",
                detail_code=exc.code,
            )
            return _error(exc.status, exc.code, str(exc))
        execution = result.get("execution")
        test = execution.get("lastTest") if isinstance(execution, dict) else None
        passed = isinstance(test, dict) and test.get("status") == "passed"
        self._record_development_operation(
            execution_id,
            "repository.test.run",
            outcome="allowed" if passed else "failed",
            detail_code="test_passed" if passed else "test_failed",
        )
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_commit_preview(
        self,
        execution_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        denied = self._host_gate(DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID)
        if denied is not None:
            return denied
        unknown = set(body) - {"previewSha256", "message"}
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_commit_preview",
                f"Unsupported commit preview field: {sorted(unknown)[0]}",
            )
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        try:
            result = self.development_execution_store.preview_commit(
                execution_id,
                preview_sha256=body.get("previewSha256"),
                message=body.get("message"),
            )
        except DevelopmentExecutionError as exc:
            return _error(exc.status, exc.code, str(exc))
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_commit(
        self,
        execution_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        unknown = set(body) - {
            "previewSha256",
            "approvalSha256",
            "message",
            "confirmed",
        }
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_commit_request",
                f"Unsupported commit field: {sorted(unknown)[0]}",
            )
        approval_sha256 = body.get("approvalSha256")
        denied = self._development_operation_gate(
            execution_id,
            "repository.git.commit",
            confirmed=body.get("confirmed"),
            approval_sha256=approval_sha256,
        )
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        try:
            result = self.development_execution_store.commit(
                execution_id,
                preview_sha256=body.get("previewSha256"),
                message=body.get("message"),
                approval_sha256=approval_sha256,
            )
        except DevelopmentExecutionError as exc:
            self._record_development_operation(
                execution_id,
                "repository.git.commit",
                outcome="failed",
                detail_code=exc.code,
            )
            return _error(exc.status, exc.code, str(exc))
        self._record_development_operation(
            execution_id,
            "repository.git.commit",
            outcome="allowed",
            detail_code="local_branch_commit_created",
        )
        return ApiResponse(HTTPStatus.OK, result)

    def _development_execution_rollback(
        self,
        execution_id: str,
        body: dict[str, Any],
    ) -> ApiResponse:
        unknown = set(body) - {
            "previewSha256",
            "approvalSha256",
            "confirmed",
        }
        if unknown:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_rollback_request",
                f"Unsupported rollback field: {sorted(unknown)[0]}",
            )
        approval_sha256 = body.get("approvalSha256")
        denied = self._development_operation_gate(
            execution_id,
            "repository.branch.rollback",
            confirmed=body.get("confirmed"),
            approval_sha256=approval_sha256,
        )
        if denied is not None:
            return denied
        if self.development_execution_store is None:
            return _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "development_execution_disabled",
                "Controlled Development execution is disabled.",
            )
        try:
            result = self.development_execution_store.rollback(
                execution_id,
                preview_sha256=body.get("previewSha256"),
                approval_sha256=approval_sha256,
            )
        except DevelopmentExecutionError as exc:
            self._record_development_operation(
                execution_id,
                "repository.branch.rollback",
                outcome="failed",
                detail_code=exc.code,
            )
            return _error(exc.status, exc.code, str(exc))
        self._record_development_operation(
            execution_id,
            "repository.branch.rollback",
            outcome="allowed",
            detail_code="isolated_state_removed",
        )
        return ApiResponse(HTTPStatus.OK, result)

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
            result = self._scan_cache.scan(identity, options)
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

    def _source(self, body: dict[str, Any]) -> ApiResponse:
        repository_path = body.get("path")
        relative_path = body.get("relativePath")
        if not isinstance(repository_path, str) or not repository_path.strip():
            return _error(HTTPStatus.BAD_REQUEST, "invalid_path", "path must be a non-empty string.")
        if not isinstance(relative_path, str) or not relative_path.strip():
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_source_path",
                "relativePath must be a non-empty string.",
            )
        start_line = body.get("startLine")
        end_line = body.get("endLine")
        revision = body.get("revision")
        if start_line is not None and (isinstance(start_line, bool) or not isinstance(start_line, int)):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_source_range",
                "startLine must be an integer.",
            )
        if end_line is not None and (isinstance(end_line, bool) or not isinstance(end_line, int)):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_source_range",
                "endLine must be an integer.",
            )
        if revision is not None and not isinstance(revision, str):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_source_revision",
                "revision must be a string.",
            )
        raw_options = body.get("options", {})
        if not isinstance(raw_options, dict):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", "options must be an object.")

        try:
            identity = self._resolver.resolve(repository_path)
            result = self._source_reader.read(
                identity,
                relative_path,
                start_line=start_line,
                end_line=end_line,
                requested_revision=revision,
                options=SourceReadOptions(
                    context_lines=_integer_option(raw_options, "contextLines", 6),
                    max_lines=_integer_option(raw_options, "maxLines", 240),
                    max_file_bytes=_integer_option(
                        raw_options,
                        "maxFileBytes",
                        2_000_000,
                    ),
                ),
            )
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(HTTPStatus.UNPROCESSABLE_ENTITY, "repository_unavailable", str(exc))
        except SourceReadError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", str(exc))
        except Exception:
            LOGGER.exception("Source excerpt read failed")
            return _error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "source_read_failed",
                "Source excerpt read failed without modifying the target repository.",
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

    def _github_pull_request(self, body: dict[str, Any]) -> ApiResponse:
        repository_path = body.get("path")
        if not isinstance(repository_path, str) or not repository_path.strip():
            return _error(HTTPStatus.BAD_REQUEST, "invalid_path", "path must be a non-empty string.")
        owner = body.get("owner")
        repository = body.get("repository")
        pull_number = body.get("pullNumber")
        if not isinstance(owner, str):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_github_owner", "owner must be a string.")
        if not isinstance(repository, str):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_github_repository",
                "repository must be a string.",
            )
        if isinstance(pull_number, bool) or not isinstance(pull_number, int):
            return _error(
                HTTPStatus.BAD_REQUEST,
                "invalid_pull_request_number",
                "pullNumber must be an integer.",
            )
        raw_options = body.get("options", {})
        if not isinstance(raw_options, dict):
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", "options must be an object.")

        try:
            identity = self._resolver.resolve(repository_path)
            result = self._github_pull_request_inspector.inspect(
                identity,
                GitHubPullRequestReference(owner, repository, pull_number),
                GitHubPullRequestOptions(
                    max_files=_integer_option(raw_options, "maxFiles", 500),
                ),
            )
        except PathAccessError as exc:
            return _error(HTTPStatus.FORBIDDEN, "path_not_allowed", str(exc))
        except RepositoryResolutionError as exc:
            return _error(HTTPStatus.UNPROCESSABLE_ENTITY, "repository_unavailable", str(exc))
        except GitHubPullRequestError as exc:
            return _error(exc.status, exc.code, str(exc))
        except ValueError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "invalid_options", str(exc))
        except Exception:
            LOGGER.exception("GitHub pull-request inspection failed")
            return _error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "github_pull_request_failed",
                "GitHub pull-request inspection failed without modifying local or remote state.",
            )
        return ApiResponse(HTTPStatus.OK, result)

    def _tool_catalog(self, body: dict[str, Any]) -> ApiResponse:
        denied = self._host_gate(TOOL_CATALOG_HOST_PLUGIN_ID)
        if denied is not None:
            return denied
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin")
        self._write_response(
            self._api.dispatch("DELETE", self.path, origin=origin),
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
