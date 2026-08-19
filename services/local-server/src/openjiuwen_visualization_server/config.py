"""Security configuration for local filesystem access."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


class PathAccessError(ValueError):
    """Raised when a requested path is outside the configured read boundary."""


@dataclass(frozen=True, slots=True)
class LocalServiceConfig:
    allowed_roots: tuple[Path, ...]
    allowed_origins: frozenset[str]
    max_request_bytes: int = 2 * 1024 * 1024
    archive_path: Path | None = None
    archive_retention_days: int = 30
    archive_max_bytes: int = 2 * 1024 * 1024 * 1024
    plugin_host_path: Path | None = None
    allow_unsigned_plugins: bool = False
    plugin_developer_roots: tuple[Path, ...] = ()

    @classmethod
    def create(
        cls,
        *,
        allowed_roots: Iterable[str | Path],
        allowed_origins: Iterable[str] = (),
        max_request_bytes: int = 2 * 1024 * 1024,
        archive_path: str | Path | None = None,
        archive_retention_days: int = 30,
        archive_max_bytes: int = 2 * 1024 * 1024 * 1024,
        plugin_host_path: str | Path | None = None,
        allow_unsigned_plugins: bool = False,
        plugin_developer_roots: Iterable[str | Path] = (),
    ) -> "LocalServiceConfig":
        resolved_roots: list[Path] = []
        for raw_root in allowed_roots:
            root = Path(raw_root).expanduser().resolve(strict=True)
            if not root.is_dir():
                raise PathAccessError(f"Allowed root is not a directory: {root}")
            if root not in resolved_roots:
                resolved_roots.append(root)

        if not resolved_roots:
            raise PathAccessError("At least one allowed root is required.")
        if max_request_bytes < 1024:
            raise ValueError("max_request_bytes must be at least 1024 bytes.")
        if not 1 <= archive_retention_days <= 3_650:
            raise ValueError("archive_retention_days must be between 1 and 3650.")
        if archive_max_bytes < 1_048_576:
            raise ValueError("archive_max_bytes must be at least 1048576.")

        resolved_archive = (
            Path(archive_path).expanduser().resolve(strict=False)
            if archive_path is not None
            else resolved_roots[0]
            / ".openjiuwen-visualization"
            / "runtime-archive.sqlite3"
        )
        if resolved_archive.exists() and resolved_archive.is_dir():
            raise PathAccessError("Archive path must be a file, not a directory.")
        if not any(resolved_archive.is_relative_to(root) for root in resolved_roots):
            raise PathAccessError("Archive path must stay inside an allowed root.")

        resolved_plugin_host = (
            Path(plugin_host_path).expanduser().resolve(strict=False)
            if plugin_host_path is not None
            else resolved_roots[0]
            / ".openjiuwen-visualization"
            / "plugin-host.sqlite3"
        )
        if resolved_plugin_host.exists() and resolved_plugin_host.is_dir():
            raise PathAccessError("Plugin Host path must be a file, not a directory.")
        if not any(resolved_plugin_host.is_relative_to(root) for root in resolved_roots):
            raise PathAccessError("Plugin Host path must stay inside an allowed root.")

        resolved_developer_roots: list[Path] = []
        for raw_root in plugin_developer_roots:
            root = Path(raw_root).expanduser().resolve(strict=True)
            if not root.is_dir():
                raise PathAccessError(f"Plugin developer root is not a directory: {root}")
            if not any(root == allowed or root.is_relative_to(allowed) for allowed in resolved_roots):
                raise PathAccessError(
                    "Plugin developer roots must stay inside an allowed root."
                )
            if root not in resolved_developer_roots:
                resolved_developer_roots.append(root)
        if resolved_developer_roots and not allow_unsigned_plugins:
            raise ValueError(
                "Plugin developer roots require allow_unsigned_plugins=True."
            )

        normalized_origins = frozenset(
            origin.rstrip("/") for origin in allowed_origins if origin.strip()
        )
        return cls(
            tuple(resolved_roots),
            normalized_origins,
            max_request_bytes,
            resolved_archive,
            archive_retention_days,
            archive_max_bytes,
            resolved_plugin_host,
            allow_unsigned_plugins,
            tuple(resolved_developer_roots),
        )

    def authorize_directory(self, raw_path: str | Path) -> Path:
        if not str(raw_path).strip():
            raise PathAccessError("Repository path is required.")

        try:
            candidate = Path(raw_path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise PathAccessError(f"Repository path cannot be resolved: {raw_path}") from exc

        if not candidate.is_dir():
            raise PathAccessError(f"Repository path is not a directory: {candidate}")
        if not any(candidate == root or candidate.is_relative_to(root) for root in self.allowed_roots):
            raise PathAccessError("Repository path is outside the configured allowed roots.")
        return candidate

    def is_origin_allowed(self, origin: str | None) -> bool:
        if not origin:
            return True
        return origin.rstrip("/") in self.allowed_origins
