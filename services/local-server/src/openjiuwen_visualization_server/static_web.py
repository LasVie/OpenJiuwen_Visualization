"""Bounded static hosting for the loopback Companion web application."""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import unquote


MAX_STATIC_ASSET_BYTES = 64 * 1024 * 1024
TEXT_SUFFIXES = frozenset({".css", ".html", ".js", ".json", ".map", ".svg", ".txt"})


class StaticWebError(ValueError):
    """Raised when the configured web bundle cannot be served safely."""


@dataclass(frozen=True, slots=True)
class StaticWebAsset:
    body: bytes
    content_type: str
    cache_control: str


class StaticWebRoot:
    """Resolve requests only inside one trusted, prebuilt frontend directory."""

    def __init__(self, root: str | Path) -> None:
        try:
            resolved = Path(root).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise StaticWebError("The Companion web build directory cannot be resolved.") from exc
        if not resolved.is_dir():
            raise StaticWebError("The Companion web build path must be a directory.")
        index = resolved / "index.html"
        if not index.is_file() or index.is_symlink():
            raise StaticWebError("The Companion web build is missing index.html.")
        self.root = resolved
        self.index = index

    def read(self, request_path: str) -> StaticWebAsset | None:
        candidate = self._resolve_candidate(request_path)
        if candidate is None:
            return None
        try:
            size = candidate.stat().st_size
            if size < 0 or size > MAX_STATIC_ASSET_BYTES:
                return None
            body = candidate.read_bytes()
        except OSError:
            return None
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix.lower() in TEXT_SUFFIXES and "charset=" not in content_type:
            content_type = f"{content_type}; charset=utf-8"
        cache_control = (
            "public, max-age=31536000, immutable"
            if candidate.parent.name == "assets"
            else "no-store"
        )
        return StaticWebAsset(
            body=body,
            content_type=content_type,
            cache_control=cache_control,
        )

    def _resolve_candidate(self, request_path: str) -> Path | None:
        try:
            decoded = unquote(request_path, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not decoded.startswith("/") or "\x00" in decoded or "\\" in decoded:
            return None

        relative = decoded.lstrip("/")
        if not relative:
            return self.index
        parts = PurePosixPath(relative).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            return None

        unresolved = self.root.joinpath(*parts)
        cursor = self.root
        for part in parts:
            cursor /= part
            if cursor.is_symlink():
                return None
        try:
            resolved = unresolved.resolve(strict=False)
        except (OSError, RuntimeError):
            return None
        if not resolved.is_relative_to(self.root):
            return None
        if resolved.is_file():
            return resolved

        # Extensionless routes belong to the single-page application. Missing
        # assets remain a real 404 so broken bundles are visible and cache-safe.
        if PurePosixPath(relative).suffix:
            return None
        return self.index
