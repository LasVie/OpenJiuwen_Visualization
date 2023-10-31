"""Persistent Core/Swarm repository bindings and managed public GitHub checkouts."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import threading
from contextlib import closing
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlsplit

from .config import LocalServiceConfig, PathAccessError
from .repository import (
    RepositoryIdentity,
    RepositoryResolutionError,
    RepositoryResolver,
)
from .swarm_core_dependency import SwarmCoreDependencyInspector


REPOSITORY_CONNECTION_API_VERSION = "1.0.0"
REPOSITORY_SLOTS = ("agent-core", "jiuwenswarm")
SCHEMA_VERSION = 1
GITHUB_OWNER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
GITHUB_REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
GIT_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$")


class RepositoryConnectionError(ValueError):
    """Stable repository connection error exposed by the loopback API."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class GitHubReference:
    url: str
    repository: str
    ref: str | None


@dataclass(frozen=True, slots=True)
class RepositoryBinding:
    slot: str
    kind: str
    path: Path
    github_url: str | None
    github_ref: str | None
    created_at: str
    updated_at: str
    last_synced_at: str | None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _validate_slot(slot: str) -> str:
    if slot not in REPOSITORY_SLOTS:
        raise RepositoryConnectionError(
            "invalid_repository_slot",
            "Repository slot must be agent-core or jiuwenswarm.",
        )
    return slot


def parse_public_github_reference(raw_url: object, raw_ref: object = None) -> GitHubReference:
    if not isinstance(raw_url, str) or not raw_url.strip() or len(raw_url) > 512:
        raise RepositoryConnectionError(
            "invalid_github_url",
            "A public https://github.com/owner/repository URL is required.",
        )
    split = urlsplit(raw_url.strip())
    if (
        split.scheme.lower() != "https"
        or split.hostname is None
        or split.hostname.lower() != "github.com"
        or split.username is not None
        or split.password is not None
        or split.port is not None
        or split.query
        or split.fragment
    ):
        raise RepositoryConnectionError(
            "invalid_github_url",
            "Only anonymous public HTTPS GitHub repository URLs are supported.",
        )
    parts = [part for part in split.path.split("/") if part]
    if len(parts) != 2:
        raise RepositoryConnectionError(
            "invalid_github_url",
            "GitHub URL must identify exactly one owner and repository.",
        )
    owner, repository = parts
    if repository.lower().endswith(".git"):
        repository = repository[:-4]
    if (
        not GITHUB_OWNER_PATTERN.fullmatch(owner)
        or not GITHUB_REPOSITORY_PATTERN.fullmatch(repository)
        or repository in {".", ".."}
    ):
        raise RepositoryConnectionError(
            "invalid_github_url",
            "GitHub owner or repository name is invalid.",
        )

    reference: str | None = None
    if raw_ref is not None:
        if not isinstance(raw_ref, str) or len(raw_ref) > 255:
            raise RepositoryConnectionError(
                "invalid_github_ref",
                "GitHub ref must be a branch or tag name up to 255 characters.",
            )
        reference = raw_ref.strip() or None
    if reference is not None and (
        not GIT_REF_PATTERN.fullmatch(reference)
        or ".." in reference
        or "//" in reference
        or "@{" in reference
        or reference.endswith(("/", ".", ".lock"))
    ):
        raise RepositoryConnectionError(
            "invalid_github_ref",
            "GitHub ref contains unsupported characters or segments.",
        )

    return GitHubReference(
        url=f"https://github.com/{owner}/{repository}.git",
        repository=f"{owner}/{repository}",
        ref=reference,
    )


class ManagedGitHubRepositories:
    """Clone and manually update anonymous GitHub repositories inside one safe root."""

    def __init__(self, root: Path, *, timeout_seconds: float = 300.0) -> None:
        self.root = root.resolve(strict=False)
        self.timeout_seconds = max(10.0, timeout_seconds)

    def checkout(self, slot: str, reference: GitHubReference) -> tuple[Path, bool]:
        _validate_slot(slot)
        digest = hashlib.sha256(
            f"{reference.url}\0{reference.ref or ''}".encode("utf-8")
        ).hexdigest()[:20]
        slot_root = (self.root / slot).resolve(strict=False)
        target = (slot_root / digest).resolve(strict=False)
        if not target.is_relative_to(self.root):
            raise RepositoryConnectionError(
                "managed_checkout_escape",
                "Managed checkout path escaped its configured root.",
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
        slot_root.mkdir(parents=True, exist_ok=True)
        if target.exists():
            self._verify_origin(target, reference)
            return target, False
        try:
            arguments = [
                "clone",
                "--depth",
                "1",
                "--no-tags",
                "--single-branch",
            ]
            if reference.ref:
                arguments.extend(["--branch", reference.ref])
            arguments.extend(["--", reference.url, str(target)])
            self._git(None, *arguments, timeout=self.timeout_seconds)
            self._verify_origin(target, reference)
        except RepositoryConnectionError:
            if target.exists():
                self._remove_tree(target)
            raise
        except OSError as exc:
            if target.exists():
                self._remove_tree(target)
            raise RepositoryConnectionError(
                "managed_checkout_failed",
                "Managed GitHub checkout could not be finalized on this filesystem.",
                status=HTTPStatus.UNPROCESSABLE_ENTITY,
            ) from exc
        return target, True

    def sync(self, path: Path, reference: GitHubReference) -> Path:
        checkout = path.resolve(strict=True)
        if not checkout.is_relative_to(self.root) or not (checkout / ".git").is_dir():
            raise RepositoryConnectionError(
                "managed_checkout_invalid",
                "The managed GitHub checkout is missing or outside its configured root.",
                status=HTTPStatus.CONFLICT,
            )
        self._verify_origin(checkout, reference)
        if self._git(checkout, "status", "--porcelain=v1", "--untracked-files=normal"):
            raise RepositoryConnectionError(
                "managed_checkout_dirty",
                "Managed checkout contains local changes; sync was not applied.",
                status=HTTPStatus.CONFLICT,
            )
        fetch_ref = reference.ref or "HEAD"
        self._git(
            checkout,
            "fetch",
            "--depth",
            "1",
            "--no-tags",
            "origin",
            fetch_ref,
            timeout=self.timeout_seconds,
        )
        self._git(checkout, "checkout", "--detach", "FETCH_HEAD")
        return checkout

    def discard(self, path: Path) -> None:
        target = path.resolve(strict=False)
        if target.is_relative_to(self.root) and target != self.root and target.exists():
            self._remove_tree(target)

    @staticmethod
    def _remove_tree(path: Path) -> None:
        def remove_readonly(function: object, raw_path: str, _error: object) -> None:
            try:
                os.chmod(raw_path, stat.S_IWRITE)
                function(raw_path)  # type: ignore[operator]
            except OSError:
                return

        raw_path = str(path.resolve(strict=False))
        if os.name == "nt" and not raw_path.startswith("\\\\?\\"):
            raw_path = "\\\\?\\" + raw_path
        shutil.rmtree(raw_path, onerror=remove_readonly)

    def _verify_origin(self, checkout: Path, reference: GitHubReference) -> None:
        if not (checkout / ".git").is_dir():
            raise RepositoryConnectionError(
                "managed_checkout_invalid",
                "Managed GitHub checkout is not a worktree.",
                status=HTTPStatus.CONFLICT,
            )
        origin = self._git(checkout, "config", "--get", "remote.origin.url")
        try:
            parsed = parse_public_github_reference(origin)
        except RepositoryConnectionError as exc:
            raise RepositoryConnectionError(
                "managed_checkout_origin_mismatch",
                "Managed checkout origin is not the configured public GitHub repository.",
                status=HTTPStatus.CONFLICT,
            ) from exc
        if parsed.url.casefold() != reference.url.casefold():
            raise RepositoryConnectionError(
                "managed_checkout_origin_mismatch",
                "Managed checkout origin does not match the configured repository.",
                status=HTTPStatus.CONFLICT,
            )

    def _git(
        self,
        cwd: Path | None,
        *arguments: str,
        timeout: float | None = None,
    ) -> str:
        environment = dict(os.environ)
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GCM_INTERACTIVE"] = "Never"
        command = [
            "git",
            "-c",
            "credential.helper=",
            "-c",
            "core.longpaths=true",
            *arguments,
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=str(cwd) if cwd is not None else None,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                timeout=timeout or self.timeout_seconds,
                env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except subprocess.TimeoutExpired as exc:
            raise RepositoryConnectionError(
                "github_checkout_timeout",
                "GitHub checkout operation timed out.",
                status=HTTPStatus.GATEWAY_TIMEOUT,
            ) from exc
        except (OSError, subprocess.SubprocessError) as exc:
            raise RepositoryConnectionError(
                "git_unavailable",
                "Git could not start for the managed GitHub checkout.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            ) from exc
        if completed.returncode != 0:
            raise RepositoryConnectionError(
                "github_checkout_failed",
                "Public GitHub checkout failed. Verify the URL, ref, and network connection.",
                status=HTTPStatus.UNPROCESSABLE_ENTITY,
            )
        return completed.stdout.strip()


class RepositoryConnectionStore:
    """SQLite/WAL-backed source bindings with allow-root and framework validation."""

    def __init__(
        self,
        config: LocalServiceConfig,
        resolver: RepositoryResolver,
        *,
        default_paths: dict[str, Path],
        database_path: Path | None = None,
        managed_repositories: ManagedGitHubRepositories | None = None,
        swarm_dependency_inspector: SwarmCoreDependencyInspector | None = None,
    ) -> None:
        self._config = config
        self._resolver = resolver
        self._default_paths = {
            slot: Path(default_paths[slot]).resolve(strict=False)
            for slot in REPOSITORY_SLOTS
        }
        self.path = (
            database_path
            or config.connection_settings_path
            or config.allowed_roots[0]
            / ".openjiuwen-visualization"
            / "connection-settings.sqlite3"
        ).resolve(strict=False)
        managed_root = (
            config.managed_source_root
            or config.allowed_roots[0] / ".openjiuwen-visualization" / "sources"
        ).resolve(strict=False)
        if not any(self.path.is_relative_to(root) for root in config.allowed_roots):
            raise PathAccessError("Connection settings path is outside allowed roots.")
        if not any(managed_root.is_relative_to(root) for root in config.allowed_roots):
            raise PathAccessError("Managed source root is outside allowed roots.")
        self._managed = managed_repositories or ManagedGitHubRepositories(managed_root)
        self._swarm_dependency_inspector = (
            swarm_dependency_inspector
            or SwarmCoreDependencyInspector(config, resolver)
        )
        self._lock = threading.RLock()
        self._initialize()

    def descriptor(self) -> dict[str, object]:
        with self._lock:
            return {
                "apiVersion": REPOSITORY_CONNECTION_API_VERSION,
                "storage": {
                    "id": "sqlite",
                    "journalMode": "wal",
                    "path": str(self.path),
                },
                "policy": {
                    "allowedRoots": [str(root) for root in self._config.allowed_roots],
                    "githubPublicOnly": True,
                    "githubAuthentication": False,
                    "synchronization": "manual",
                    "managedCheckoutRoot": str(self._managed.root),
                    "swarmCoreGitHosts": ["github.com", "gitcode.com"],
                },
                "slots": {
                    "agentCore": self._describe_slot("agent-core"),
                    "jiuwenSwarm": self._describe_slot("jiuwenswarm"),
                },
            }

    def effective_path(self, slot: str) -> Path:
        checked = _validate_slot(slot)
        with self._lock:
            binding = self._read_binding(checked)
            candidate = binding.path if binding is not None else self._default_paths[checked]
            try:
                return self._config.authorize_directory(candidate)
            except PathAccessError:
                return (
                    self._config.allowed_roots[0]
                    / ".openjiuwen-visualization"
                    / "unavailable-sources"
                    / checked
                ).resolve(strict=False)

    def identities(self) -> tuple[RepositoryIdentity, ...]:
        identities: dict[str, RepositoryIdentity] = {}
        for slot in REPOSITORY_SLOTS:
            try:
                identity = self._validated_identity(slot, self.effective_path(slot))
            except RepositoryConnectionError:
                continue
            identities[identity.id] = identity
        return tuple(identities.values())

    def inspect_swarm_core_dependency(self) -> dict[str, object]:
        """Refresh read-only dependency evidence for the active Swarm binding."""

        with self._lock:
            return self._swarm_dependency_inspector.inspect(
                self.effective_path("jiuwenswarm")
            )

    def bind_local(self, slot: str, raw_path: object) -> dict[str, object]:
        checked = _validate_slot(slot)
        if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 2_048:
            raise RepositoryConnectionError(
                "invalid_repository_path",
                "A local repository directory is required.",
            )
        with self._lock:
            identity = self._validated_identity(checked, Path(raw_path.strip()))
            self._upsert(
                RepositoryBinding(
                    slot=checked,
                    kind="local",
                    path=identity.root,
                    github_url=None,
                    github_ref=None,
                    created_at=_utc_now(),
                    updated_at=_utc_now(),
                    last_synced_at=None,
                )
            )
            return self._describe_slot(checked)

    def bind_github(
        self,
        slot: str,
        raw_url: object,
        raw_ref: object = None,
    ) -> dict[str, object]:
        checked = _validate_slot(slot)
        reference = parse_public_github_reference(raw_url, raw_ref)
        with self._lock:
            checkout, created = self._managed.checkout(checked, reference)
            try:
                identity = self._validated_identity(checked, checkout)
            except RepositoryConnectionError:
                if created:
                    self._managed.discard(checkout)
                raise
            now = _utc_now()
            self._upsert(
                RepositoryBinding(
                    slot=checked,
                    kind="github",
                    path=identity.root,
                    github_url=reference.url,
                    github_ref=reference.ref,
                    created_at=now,
                    updated_at=now,
                    last_synced_at=now,
                )
            )
            return self._describe_slot(checked)

    def sync(self, slot: str) -> dict[str, object]:
        checked = _validate_slot(slot)
        with self._lock:
            binding = self._read_binding(checked)
            if binding is None or binding.kind != "github" or binding.github_url is None:
                raise RepositoryConnectionError(
                    "github_binding_required",
                    "This repository slot is not bound to a managed GitHub checkout.",
                    status=HTTPStatus.CONFLICT,
                )
            reference = parse_public_github_reference(
                binding.github_url,
                binding.github_ref,
            )
            path = self._managed.sync(binding.path, reference)
            self._validated_identity(checked, path)
            now = _utc_now()
            self._upsert(
                RepositoryBinding(
                    slot=binding.slot,
                    kind=binding.kind,
                    path=path,
                    github_url=binding.github_url,
                    github_ref=binding.github_ref,
                    created_at=binding.created_at,
                    updated_at=now,
                    last_synced_at=now,
                )
            )
            return self._describe_slot(checked)

    def reset(self, slot: str) -> dict[str, object]:
        checked = _validate_slot(slot)
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM repository_bindings WHERE slot = ?", (checked,))
            connection.commit()
            return self._describe_slot(checked)

    def _describe_slot(self, slot: str) -> dict[str, object]:
        binding = self._read_binding(slot)
        path = binding.path if binding is not None else self._default_paths[slot]
        identity: RepositoryIdentity | None = None
        try:
            identity = self._validated_identity(slot, path)
            validation = {
                "status": "ready",
                "code": "ready",
                "message": "Repository and required framework sources are available.",
            }
        except RepositoryConnectionError as exc:
            validation = {
                "status": "unavailable",
                "code": exc.code,
                "message": str(exc),
            }
        kind = binding.kind if binding is not None else "local"
        github = (
            {
                "url": binding.github_url,
                "repository": parse_public_github_reference(
                    binding.github_url,
                    binding.github_ref,
                ).repository,
                "ref": binding.github_ref,
                "public": True,
            }
            if binding is not None
            and binding.kind == "github"
            and binding.github_url is not None
            else None
        )
        description = {
            "slot": slot,
            "label": "Agent Core" if slot == "agent-core" else "JiuwenSwarm",
            "configured": validation["status"] == "ready",
            "mode": kind,
            "origin": "configured" if binding is not None else "default",
            "path": str(path),
            "managed": kind == "github",
            "canReset": binding is not None,
            "canSync": binding is not None and kind == "github",
            "github": github,
            "repository": identity.to_api_dict() if identity is not None else None,
            "validation": validation,
            "createdAt": binding.created_at if binding is not None else None,
            "updatedAt": binding.updated_at if binding is not None else None,
            "lastSyncedAt": binding.last_synced_at if binding is not None else None,
            "coreDependency": None,
        }
        if slot == "jiuwenswarm":
            description["coreDependency"] = self._swarm_dependency_inspector.inspect(path)
        return description

    def _validated_identity(self, slot: str, raw_path: Path) -> RepositoryIdentity:
        try:
            authorized = self._config.authorize_directory(raw_path)
            identity = self._resolver.resolve(authorized)
        except PathAccessError as exc:
            raise RepositoryConnectionError(
                "repository_path_not_allowed",
                str(exc),
                status=HTTPStatus.FORBIDDEN,
            ) from exc
        except (OSError, RepositoryResolutionError) as exc:
            raise RepositoryConnectionError(
                "repository_unavailable",
                "The configured path is not a readable Git repository.",
                status=HTTPStatus.UNPROCESSABLE_ENTITY,
            ) from exc
        marker = (
            identity.root / "openjiuwen" / "harness" / "deep_agent.py"
            if slot == "agent-core"
            else identity.root
            / "jiuwenswarm"
            / "agents"
            / "swarm"
            / "assembly.py"
        )
        if not marker.is_file():
            raise RepositoryConnectionError(
                "repository_framework_mismatch",
                (
                    "Repository does not contain the required Agent Core sources."
                    if slot == "agent-core"
                    else "Repository does not contain the required JiuwenSwarm sources."
                ),
                status=HTTPStatus.UNPROCESSABLE_ENTITY,
            )
        return replace(identity, name=slot, owner=slot)

    def _initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError("Connection settings schema is newer than this service.")
            if version == 0:
                connection.executescript(
                    """
                    CREATE TABLE repository_bindings (
                        slot TEXT PRIMARY KEY,
                        kind TEXT NOT NULL,
                        path TEXT NOT NULL,
                        github_url TEXT,
                        github_ref TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        last_synced_at TEXT
                    );
                    PRAGMA user_version = 1;
                    """
                )
                connection.commit()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _read_binding(self, slot: str) -> RepositoryBinding | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM repository_bindings WHERE slot = ?",
                (slot,),
            ).fetchone()
        if row is None:
            return None
        return RepositoryBinding(
            slot=str(row["slot"]),
            kind=str(row["kind"]),
            path=Path(str(row["path"])).resolve(strict=False),
            github_url=str(row["github_url"]) if row["github_url"] is not None else None,
            github_ref=str(row["github_ref"]) if row["github_ref"] is not None else None,
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            last_synced_at=(
                str(row["last_synced_at"])
                if row["last_synced_at"] is not None
                else None
            ),
        )

    def _upsert(self, binding: RepositoryBinding) -> None:
        existing = self._read_binding(binding.slot)
        created_at = existing.created_at if existing is not None else binding.created_at
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO repository_bindings (
                    slot, kind, path, github_url, github_ref,
                    created_at, updated_at, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(slot) DO UPDATE SET
                    kind = excluded.kind,
                    path = excluded.path,
                    github_url = excluded.github_url,
                    github_ref = excluded.github_ref,
                    updated_at = excluded.updated_at,
                    last_synced_at = excluded.last_synced_at
                """,
                (
                    binding.slot,
                    binding.kind,
                    str(binding.path),
                    binding.github_url,
                    binding.github_ref,
                    created_at,
                    binding.updated_at,
                    binding.last_synced_at,
                ),
            )
            connection.commit()
