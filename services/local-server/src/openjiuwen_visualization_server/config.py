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
