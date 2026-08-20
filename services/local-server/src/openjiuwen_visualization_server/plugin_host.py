"""Local plugin control plane with persisted grants and secret-safe descriptors."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator


PLUGIN_HOST_API_VERSION = "1.0.0"
PLUGIN_MANIFEST_VERSION = "1.0.0"
OPENROUTER_HOST_PLUGIN_ID = "openjiuwen.host.openrouter"
TOOL_CATALOG_HOST_PLUGIN_ID = "openjiuwen.host.tool-catalog"
DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID = "openjiuwen.host.development-executor"
MAX_AUDIT_EVENTS = 5_000
MAX_DEVELOPER_MANIFESTS = 100
MAX_MANIFEST_BYTES = 256 * 1024

_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{2,119}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_FILENAME = "*.openjiuwen-plugin.json"


class PluginHostError(ValueError):
    """A stable, HTTP-safe Plugin Host failure."""

    def __init__(self, code: str, message: str, *, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class PluginPermission:
    id: str
    label: str
    description: str
    kind: str
    grant_mode: str
    default_granted: bool
    revocable: bool
    required: bool = True
    secret_handle_id: str | None = None


@dataclass(frozen=True, slots=True)
class PluginDefinition:
    id: str
    name: str
    version: str
    description: str
    group: str
    capabilities: tuple[str, ...]
    permissions: tuple[PluginPermission, ...]
    default_enabled: bool
    trust: str
    source_kind: str
    source_identity: str
    integrity: str
    runtime_mode: str
    executable: bool
    manifest_path: Path | None = None


@dataclass(frozen=True, slots=True)
class PluginAuthorization:
    allowed: bool
    code: str
    message: str
    plugin_status: str


def _permission(
    permission_id: str,
    label: str,
    description: str,
    kind: str,
    grant_mode: str,
    *,
    default_granted: bool,
    revocable: bool,
    required: bool = True,
    secret_handle_id: str | None = None,
) -> PluginPermission:
    return PluginPermission(
        permission_id,
        label,
        description,
        kind,
        grant_mode,
        default_granted,
        revocable,
        required,
        secret_handle_id,
    )


def _integrity(payload: dict[str, object]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def _bundled_plugins() -> tuple[PluginDefinition, ...]:
    openrouter_payload: dict[str, object] = {
        "id": OPENROUTER_HOST_PLUGIN_ID,
        "version": "1.0.0",
        "capabilities": [
            "model.provider.openrouter.registry",
            "model.provider.openrouter.invoke",
        ],
    }
    tool_payload: dict[str, object] = {
        "id": TOOL_CATALOG_HOST_PLUGIN_ID,
        "version": "1.0.0",
        "capabilities": ["repository.tools.read"],
    }
    development_executor_payload: dict[str, object] = {
        "id": DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
        "version": "1.0.0",
        "capabilities": [
            "development.execution.preview",
            "development.patch.apply",
            "development.test.run",
            "development.git.commit",
            "development.rollback",
        ],
    }
    return (
        PluginDefinition(
            id=OPENROUTER_HOST_PLUGIN_ID,
            name="OpenRouter Provider",
            version="1.0.0",
            description=(
                "Host-owned OpenRouter adapter. The browser and plugins receive only "
                "an opaque credential handle, never the API key."
            ),
            group="provider",
            capabilities=tuple(openrouter_payload["capabilities"]),
            permissions=(
                _permission(
                    "provider.registry.read",
                    "读取 Provider 注册表",
                    "读取模型白名单、限制与无凭据状态。",
                    "read",
                    "install",
                    default_granted=True,
                    revocable=False,
                ),
                _permission(
                    "network.openrouter.invoke",
                    "访问 OpenRouter 网络",
                    "允许模型请求发往 https://openrouter.ai。",
                    "network",
                    "interactive",
                    default_granted=True,
                    revocable=True,
                ),
                _permission(
                    "secret.openrouter.use",
                    "使用 OpenRouter 凭据句柄",
                    "允许 Host 在调用期间解析本机凭据；值不会交给插件。",
                    "secret",
                    "interactive",
                    default_granted=True,
                    revocable=True,
                    secret_handle_id="openrouter.default",
                ),
            ),
            default_enabled=True,
            trust="bundled-trusted",
            source_kind="bundled",
            source_identity="openjiuwen-visualization/local-service",
            integrity=_integrity(openrouter_payload),
            runtime_mode="builtin-adapter",
            executable=True,
        ),
        PluginDefinition(
            id=TOOL_CATALOG_HOST_PLUGIN_ID,
            name="Registered Tool Catalog",
            version="1.0.0",
            description=(
                "Static, read-only Tool declaration and registration-path index. "
                "Target repository code is never imported."
            ),
            group="tool",
            capabilities=tuple(tool_payload["capabilities"]),
            permissions=(
                _permission(
                    "repository.tools.read",
                    "读取 Tool 声明",
                    "仅在已授权仓库根内做静态 AST 索引。",
                    "read",
                    "install",
                    default_granted=True,
                    revocable=False,
                ),
            ),
            default_enabled=True,
            trust="bundled-trusted",
            source_kind="bundled",
            source_identity="openjiuwen-visualization/local-service",
            integrity=_integrity(tool_payload),
            runtime_mode="builtin-adapter",
            executable=True,
        ),
        PluginDefinition(
            id=DEVELOPMENT_EXECUTOR_HOST_PLUGIN_ID,
            name="Controlled Development Executor",
            version="1.0.0",
            description=(
                "Validates reviewed unified diffs, creates an isolated local Git "
                "worktree, runs fixed test profiles, and forms a local branch commit. "
                "Every mutating action requires a digest-bound confirmation; push is absent."
            ),
            group="integration",
            capabilities=tuple(development_executor_payload["capabilities"]),
            permissions=(
                _permission(
                    "repository.development.preview",
                    "预览受控开发操作",
                    "只读校验补丁、base revision、精确路径和可用测试计划。",
                    "read",
                    "install",
                    default_granted=True,
                    revocable=False,
                ),
                _permission(
                    "repository.patch.apply",
                    "应用隔离补丁",
                    "为单次已审查补丁创建隔离 worktree 和本地分支。",
                    "write",
                    "per-operation",
                    default_granted=False,
                    revocable=False,
                ),
                _permission(
                    "repository.test.run",
                    "运行白名单测试",
                    "仅运行 Host 识别并在调用前展示的固定测试命令。",
                    "write",
                    "per-operation",
                    default_granted=False,
                    revocable=False,
                ),
                _permission(
                    "repository.git.commit",
                    "创建本地分支提交",
                    "只提交已审查并已暂存的路径；不会 push。",
                    "write",
                    "per-operation",
                    default_granted=False,
                    revocable=False,
                ),
                _permission(
                    "repository.branch.rollback",
                    "回滚隔离执行",
                    "删除本工具创建且未发生外部推进的 worktree 和分支。",
                    "write",
                    "per-operation",
                    default_granted=False,
                    revocable=False,
                ),
            ),
            default_enabled=False,
            trust="bundled-trusted",
            source_kind="bundled",
            source_identity="openjiuwen-visualization/local-service",
            integrity=_integrity(development_executor_payload),
            runtime_mode="builtin-adapter",
            executable=True,
        ),
    )


def _required_string(value: object, name: str, *, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string.")
    result = value.strip()
    if len(result) > maximum:
        raise ValueError(f"{name} exceeds {maximum} characters.")
    return result


def _developer_permission(value: object, index: int) -> PluginPermission:
    if not isinstance(value, dict):
        raise ValueError(f"permissions[{index}] must be an object.")
    allowed_fields = {
        "id",
        "label",
        "description",
        "kind",
        "grantMode",
        "required",
        "secretHandleId",
    }
    unknown = set(value) - allowed_fields
    if unknown:
        raise ValueError(f"Unsupported permission field: {sorted(unknown)[0]}")
    permission_id = _required_string(value.get("id"), f"permissions[{index}].id", maximum=120)
    if not _IDENTIFIER.fullmatch(permission_id):
        raise ValueError(f"permissions[{index}].id is invalid.")
    kind = _required_string(value.get("kind"), f"permissions[{index}].kind", maximum=20)
    if kind not in {"read", "network", "secret", "write"}:
        raise ValueError(f"permissions[{index}].kind is unsupported.")
    grant_mode = _required_string(
        value.get("grantMode"),
        f"permissions[{index}].grantMode",
        maximum=30,
    )
    if grant_mode not in {"install", "interactive", "per-operation"}:
        raise ValueError(f"permissions[{index}].grantMode is unsupported.")
    if kind == "write" and grant_mode != "per-operation":
        raise ValueError("Write permissions must use per-operation approval.")
    required = value.get("required", True)
    if not isinstance(required, bool):
        raise ValueError(f"permissions[{index}].required must be a boolean.")
    secret_handle = value.get("secretHandleId")
    if secret_handle is not None:
        secret_handle = _required_string(
            secret_handle,
            f"permissions[{index}].secretHandleId",
            maximum=120,
        )
        if kind != "secret" or not _IDENTIFIER.fullmatch(secret_handle):
            raise ValueError("secretHandleId is only valid for a secret permission.")
    return PluginPermission(
        id=permission_id,
        label=_required_string(value.get("label"), f"permissions[{index}].label", maximum=120),
        description=_required_string(
            value.get("description", "Developer plugin permission."),
            f"permissions[{index}].description",
            maximum=500,
        ),
        kind=kind,
        grant_mode=grant_mode,
        default_granted=False,
        revocable=grant_mode != "per-operation",
        required=required,
        secret_handle_id=secret_handle,
    )


def _developer_plugin(path: Path, root: Path) -> PluginDefinition:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("Manifest exceeds the 256 KiB limit.")
    raw = path.read_text(encoding="utf-8")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Manifest root must be an object.")
    allowed_fields = {
        "schemaVersion",
        "id",
        "name",
        "version",
        "description",
        "group",
        "capabilities",
        "permissions",
    }
    unknown = set(value) - allowed_fields
    if unknown:
        raise ValueError(f"Unsupported manifest field: {sorted(unknown)[0]}")
    if value.get("schemaVersion") != PLUGIN_MANIFEST_VERSION:
        raise ValueError(f"schemaVersion must be {PLUGIN_MANIFEST_VERSION}.")
    plugin_id = _required_string(value.get("id"), "id", maximum=120)
    if not _IDENTIFIER.fullmatch(plugin_id):
        raise ValueError("id is invalid.")
    version = _required_string(value.get("version"), "version", maximum=80)
    if not _VERSION.fullmatch(version):
        raise ValueError("version must use semantic version syntax.")
    group = _required_string(value.get("group"), "group", maximum=30)
    if group not in {"provider", "tool", "integration", "workspace"}:
        raise ValueError("group is unsupported.")
    capabilities = value.get("capabilities")
    if not isinstance(capabilities, list) or not 1 <= len(capabilities) <= 50:
        raise ValueError("capabilities must contain between 1 and 50 entries.")
    normalized_capabilities: list[str] = []
    for index, capability in enumerate(capabilities):
        item = _required_string(capability, f"capabilities[{index}]", maximum=120)
        if not _IDENTIFIER.fullmatch(item) or item in normalized_capabilities:
            raise ValueError(f"capabilities[{index}] is invalid or duplicated.")
        normalized_capabilities.append(item)
    permissions_value = value.get("permissions", [])
    if not isinstance(permissions_value, list) or len(permissions_value) > 30:
        raise ValueError("permissions must be an array with at most 30 entries.")
    permissions = tuple(
        _developer_permission(permission, index)
        for index, permission in enumerate(permissions_value)
    )
    if len({permission.id for permission in permissions}) != len(permissions):
        raise ValueError("Permission ids must be unique.")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError("Manifest resolves outside its authorized developer root.")
    return PluginDefinition(
        id=plugin_id,
        name=_required_string(value.get("name"), "name", maximum=120),
        version=version,
        description=_required_string(value.get("description"), "description", maximum=1_000),
        group=group,
        capabilities=tuple(normalized_capabilities),
        permissions=permissions,
        default_enabled=False,
        trust="unsigned-local",
        source_kind="developer-path",
        source_identity=str(root),
        integrity="sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        runtime_mode="declarative-only",
        executable=False,
        manifest_path=resolved,
    )


class PluginHost:
    """Owns plugin lifecycle, permission grants, audit, and opaque secret state."""

    def __init__(
        self,
        database_path: Path,
        *,
        secret_resolvers: dict[str, Callable[[], bool]] | None = None,
        allow_unsigned_plugins: bool = False,
        developer_roots: Iterable[Path] = (),
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.database_path = database_path.resolve(strict=False)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.allow_unsigned_plugins = allow_unsigned_plugins
        self.developer_roots = tuple(root.resolve(strict=True) for root in developer_roots)
        self._clock = clock
        self._secret_resolvers = dict(secret_resolvers or {})
        self._lock = threading.RLock()
        definitions = list(_bundled_plugins())
        self.discovery_errors: list[dict[str, str]] = []
        if allow_unsigned_plugins:
            definitions.extend(self._discover_developer_plugins())
        self._definitions = {definition.id: definition for definition in definitions}
        if len(self._definitions) != len(definitions):
            raise PluginHostError(
                "duplicate_plugin_id",
                "Plugin ids must be unique across bundled and developer manifests.",
                status=HTTPStatus.CONFLICT,
            )
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize_database(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS plugin_state (
                    plugin_id TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS permission_grant (
                    plugin_id TEXT NOT NULL,
                    permission_id TEXT NOT NULL,
                    granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (plugin_id, permission_id)
                );
                CREATE TABLE IF NOT EXISTS audit_event (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp_ms INTEGER NOT NULL,
                    plugin_id TEXT,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    detail_code TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS audit_event_plugin_id
                    ON audit_event(plugin_id, id DESC);
                """
            )
            migration = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 1"
            ).fetchone()
            if migration is None:
                connection.execute(
                    "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(1, ?)",
                    (self._now_ms(),),
                )

    def _now_ms(self) -> int:
        return int(self._clock() * 1_000)

    def _discover_developer_plugins(self) -> list[PluginDefinition]:
        plugins: list[PluginDefinition] = []
        seen_paths: set[Path] = set()
        for root in self.developer_roots:
            for path in sorted(root.rglob(_MANIFEST_FILENAME)):
                if len(seen_paths) >= MAX_DEVELOPER_MANIFESTS:
                    self.discovery_errors.append(
                        {
                            "code": "manifest_limit_reached",
                            "source": str(root),
                            "message": "Developer manifest discovery stopped at 100 files.",
                        }
                    )
                    return plugins
                try:
                    resolved = path.resolve(strict=True)
                    if resolved in seen_paths or not resolved.is_file():
                        continue
                    seen_paths.add(resolved)
                    plugins.append(_developer_plugin(resolved, root))
                except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
                    self.discovery_errors.append(
                        {
                            "code": "invalid_manifest",
                            "source": str(path),
                            "message": str(exc)[:500],
                        }
                    )
        return plugins

    def _definition(self, plugin_id: str) -> PluginDefinition:
        definition = self._definitions.get(plugin_id)
        if definition is None:
            raise PluginHostError(
                "plugin_not_found",
                "Plugin is not registered by this Host.",
                status=HTTPStatus.NOT_FOUND,
            )
        return definition

    def _state_rows(self, connection: sqlite3.Connection) -> dict[str, bool]:
        return {
            str(row["plugin_id"]): bool(row["enabled"])
            for row in connection.execute("SELECT plugin_id, enabled FROM plugin_state")
        }

    def _grant_rows(self, connection: sqlite3.Connection) -> dict[tuple[str, str], bool]:
        return {
            (str(row["plugin_id"]), str(row["permission_id"])): bool(row["granted"])
            for row in connection.execute(
                "SELECT plugin_id, permission_id, granted FROM permission_grant"
            )
        }

    def _effective_state(
        self,
        definition: PluginDefinition,
        states: dict[str, bool],
        grants: dict[tuple[str, str], bool],
    ) -> tuple[bool, str, str, str]:
        enabled = states.get(definition.id, definition.default_enabled)
        if not enabled:
            return False, "disabled", "plugin_disabled", "Plugin lifecycle is disabled."
        missing = [
            permission
            for permission in definition.permissions
            if permission.required
            and permission.grant_mode != "per-operation"
            and not grants.get(
                (definition.id, permission.id),
                permission.default_granted,
            )
        ]
        if missing:
            return (
                True,
                "blocked",
                "permission_required",
                f"Permission {missing[0].id} is not granted.",
            )
        return True, "active", "ready", "Plugin is enabled and required grants are active."

    def authorize(self, plugin_id: str) -> PluginAuthorization:
        definition = self._definition(plugin_id)
        with self._lock, self._connection() as connection:
            requested, status, code, message = self._effective_state(
                definition,
                self._state_rows(connection),
                self._grant_rows(connection),
            )
        if status == "active":
            return PluginAuthorization(True, code, message, status)
        if not requested:
            return PluginAuthorization(False, code, message, status)
        return PluginAuthorization(False, code, message, status)

    def authorize_operation(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        confirmed: bool,
        target: str,
        preview_sha256: str,
    ) -> PluginAuthorization:
        """Consume no standing grant; audit one exact digest-bound approval."""
        definition = self._definition(plugin_id)
        permission = next(
            (item for item in definition.permissions if item.id == permission_id),
            None,
        )
        if permission is None:
            raise PluginHostError(
                "permission_not_found",
                "Permission is not declared by this plugin.",
                status=HTTPStatus.NOT_FOUND,
            )
        if permission.kind != "write" or permission.grant_mode != "per-operation":
            raise PluginHostError(
                "permission_policy_fixed",
                "Only per-operation write permissions use this approval gate.",
                status=HTTPStatus.CONFLICT,
            )
        if not isinstance(confirmed, bool):
            raise PluginHostError(
                "invalid_operation_confirmation",
                "confirmed must be a boolean.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not isinstance(target, str) or not _IDENTIFIER.fullmatch(target):
            raise PluginHostError(
                "invalid_operation_target",
                "Operation target must be an opaque local identifier.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not isinstance(preview_sha256, str) or not _SHA256.fullmatch(preview_sha256):
            raise PluginHostError(
                "invalid_operation_digest",
                "Operation preview digest must be a lowercase SHA-256 value.",
                status=HTTPStatus.BAD_REQUEST,
            )
        lifecycle = self.authorize(plugin_id)
        if not lifecycle.allowed:
            return lifecycle
        allowed = confirmed
        code = "operation_approved" if allowed else "operation_confirmation_required"
        message = (
            "One digest-bound operation is approved."
            if allowed
            else "This write operation requires an explicit confirmation."
        )
        with self._lock, self._connection() as connection:
            self._audit(
                connection,
                plugin_id=plugin_id,
                action="plugin.operation.approval",
                target=target,
                outcome="allowed" if allowed else "denied",
                detail_code=f"{permission_id}:{preview_sha256[:16]}",
            )
        return PluginAuthorization(allowed, code, message, lifecycle.plugin_status)

    def record_operation_result(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        target: str,
        outcome: str,
        detail_code: str,
    ) -> None:
        """Record an opaque result without repository paths, commands, or payload text."""
        definition = self._definition(plugin_id)
        permission = next(
            (item for item in definition.permissions if item.id == permission_id),
            None,
        )
        if permission is None or permission.grant_mode != "per-operation":
            raise PluginHostError(
                "permission_not_found",
                "Per-operation permission is not declared by this plugin.",
                status=HTTPStatus.NOT_FOUND,
            )
        if not isinstance(target, str) or not _IDENTIFIER.fullmatch(target):
            raise PluginHostError(
                "invalid_operation_target",
                "Operation target must be an opaque local identifier.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if outcome not in {"allowed", "failed", "cancelled"}:
            raise PluginHostError(
                "invalid_operation_outcome",
                "Operation outcome is invalid.",
                status=HTTPStatus.BAD_REQUEST,
            )
        normalized_detail = _required_string(detail_code, "detail_code", maximum=120)
        with self._lock, self._connection() as connection:
            self._audit(
                connection,
                plugin_id=plugin_id,
                action="plugin.operation.result",
                target=target,
                outcome=outcome,
                detail_code=f"{permission_id}:{normalized_detail}",
            )

    def _secret_resolved(self, handle_id: str | None) -> bool:
        if handle_id is None:
            return False
        resolver = self._secret_resolvers.get(handle_id)
        if resolver is None:
            return False
        try:
            return bool(resolver())
        except Exception:
            return False

    def descriptor(self) -> dict[str, object]:
        with self._lock, self._connection() as connection:
            states = self._state_rows(connection)
            grants = self._grant_rows(connection)
            audit = connection.execute(
                "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS last_id FROM audit_event"
            ).fetchone()
        plugins: list[dict[str, object]] = []
        for definition in self._definitions.values():
            requested, status, code, message = self._effective_state(
                definition,
                states,
                grants,
            )
            permissions = []
            secret_handles: list[dict[str, object]] = []
            for permission in definition.permissions:
                granted = grants.get(
                    (definition.id, permission.id),
                    permission.default_granted,
                )
                permissions.append(
                    {
                        "id": permission.id,
                        "label": permission.label,
                        "description": permission.description,
                        "kind": permission.kind,
                        "grantMode": permission.grant_mode,
                        "granted": granted,
                        "revocable": permission.revocable,
                        "required": permission.required,
                        **(
                            {"secretHandleId": permission.secret_handle_id}
                            if permission.secret_handle_id
                            else {}
                        ),
                    }
                )
                if permission.secret_handle_id:
                    secret_handles.append(
                        {
                            "id": permission.secret_handle_id,
                            "resolved": self._secret_resolved(permission.secret_handle_id),
                            "exposure": "opaque-handle-only",
                            "storage": "host-environment",
                        }
                    )
            plugins.append(
                {
                    "id": definition.id,
                    "name": definition.name,
                    "version": definition.version,
                    "description": definition.description,
                    "group": definition.group,
                    "capabilities": list(definition.capabilities),
                    "defaultEnabled": definition.default_enabled,
                    "requestedEnabled": requested,
                    "status": status,
                    "diagnostic": {"code": code, "message": message},
                    "permissions": permissions,
                    "secretHandles": secret_handles,
                    "trust": {
                        "level": definition.trust,
                        "automatic": definition.trust == "bundled-trusted",
                        "executable": definition.executable,
                    },
                    "source": {
                        "kind": definition.source_kind,
                        "identity": definition.source_identity,
                        "integrity": definition.integrity,
                        **(
                            {"manifestPath": str(definition.manifest_path)}
                            if definition.manifest_path
                            else {}
                        ),
                    },
                    "runtime": {
                        "mode": definition.runtime_mode,
                        "processIsolation": (
                            "host-builtin-boundary"
                            if definition.executable
                            else "no-code-execution"
                        ),
                    },
                }
            )
        return {
            "apiVersion": PLUGIN_HOST_API_VERSION,
            "host": {
                "mode": "local-loopback",
                "storage": {
                    "engine": "sqlite",
                    "journalMode": "wal",
                    "schemaVersion": 1,
                },
                "policies": {
                    "bundledTrust": "automatic",
                    "unsignedLocal": "developer-mode-path-scoped",
                    "secretExposure": "opaque-handle-only",
                    "readPermission": "install-time",
                    "networkPermission": "revocable",
                    "writePermission": "per-operation-approval",
                    "arbitraryPluginCode": "disabled-in-v1",
                },
                "developerMode": {
                    "enabled": self.allow_unsigned_plugins,
                    "authorizedRoots": [str(root) for root in self.developer_roots],
                    "discoveryErrors": list(self.discovery_errors),
                },
                "plugins": plugins,
                "audit": {
                    "count": int(audit["count"] if audit is not None else 0),
                    "lastEventId": int(audit["last_id"] if audit is not None else 0),
                },
            },
        }

    def _audit(
        self,
        connection: sqlite3.Connection,
        *,
        plugin_id: str | None,
        action: str,
        target: str,
        outcome: str,
        detail_code: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_event(
                timestamp_ms, plugin_id, action, target, outcome, detail_code
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                self._now_ms(),
                plugin_id,
                action,
                target[:160],
                outcome,
                detail_code[:160],
            ),
        )
        connection.execute(
            """
            DELETE FROM audit_event
            WHERE id <= COALESCE((
                SELECT id FROM audit_event ORDER BY id DESC LIMIT 1 OFFSET ?
            ), 0)
            """,
            (MAX_AUDIT_EVENTS,),
        )

    def set_enabled(
        self,
        plugin_id: str,
        enabled: bool,
        *,
        confirmed: bool = False,
    ) -> dict[str, object]:
        definition = self._definition(plugin_id)
        if not isinstance(enabled, bool):
            raise PluginHostError(
                "invalid_plugin_state",
                "enabled must be a boolean.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if enabled and definition.trust == "unsigned-local" and not confirmed:
            raise PluginHostError(
                "unsigned_plugin_confirmation_required",
                "Unsigned local plugins require an explicit enable confirmation.",
                status=HTTPStatus.CONFLICT,
            )
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO plugin_state(plugin_id, enabled, updated_at_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (plugin_id, int(enabled), self._now_ms()),
            )
            self._audit(
                connection,
                plugin_id=plugin_id,
                action="plugin.state.changed",
                target="lifecycle",
                outcome="allowed",
                detail_code="enabled" if enabled else "disabled",
            )
        return self.descriptor()

    def set_permission(
        self,
        plugin_id: str,
        permission_id: str,
        granted: bool,
    ) -> dict[str, object]:
        definition = self._definition(plugin_id)
        permission = next(
            (item for item in definition.permissions if item.id == permission_id),
            None,
        )
        if permission is None:
            raise PluginHostError(
                "permission_not_found",
                "Permission is not declared by this plugin.",
                status=HTTPStatus.NOT_FOUND,
            )
        if not isinstance(granted, bool):
            raise PluginHostError(
                "invalid_permission_grant",
                "granted must be a boolean.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not permission.revocable or permission.grant_mode == "per-operation":
            raise PluginHostError(
                "permission_policy_fixed",
                "This permission is controlled by a fixed Host policy.",
                status=HTTPStatus.CONFLICT,
            )
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO permission_grant(
                    plugin_id, permission_id, granted, updated_at_ms
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(plugin_id, permission_id) DO UPDATE SET
                    granted = excluded.granted,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (plugin_id, permission_id, int(granted), self._now_ms()),
            )
            self._audit(
                connection,
                plugin_id=plugin_id,
                action="plugin.permission.changed",
                target=permission_id,
                outcome="allowed",
                detail_code="granted" if granted else "revoked",
            )
        return self.descriptor()

    def audit_events(self, *, after: int = 0, limit: int = 100) -> dict[str, object]:
        if after < 0 or not 1 <= limit <= 500:
            raise PluginHostError(
                "invalid_audit_cursor",
                "after must be non-negative and limit must be between 1 and 500.",
                status=HTTPStatus.BAD_REQUEST,
            )
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT id, timestamp_ms, plugin_id, action, target, outcome, detail_code
                FROM audit_event WHERE id > ? ORDER BY id ASC LIMIT ?
                """,
                (after, limit),
            ).fetchall()
        events = [
            {
                "id": int(row["id"]),
                "timestampMs": int(row["timestamp_ms"]),
                "pluginId": row["plugin_id"],
                "action": str(row["action"]),
                "target": str(row["target"]),
                "outcome": str(row["outcome"]),
                "detailCode": str(row["detail_code"]),
            }
            for row in rows
        ]
        return {
            "apiVersion": PLUGIN_HOST_API_VERSION,
            "events": events,
            "nextCursor": events[-1]["id"] if events else after,
        }
