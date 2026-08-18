"""Bounded, read-only source excerpts for graph evidence drill-down."""

from __future__ import annotations

import hashlib
import io
import tokenize
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path, PurePosixPath

from .repository import RepositoryIdentity


SOURCE_API_VERSION = "1.0.0"
DEFAULT_FOCUS_LINES = 80
LANGUAGE_BY_SUFFIX = {
    ".css": "css",
    ".html": "html",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".md": "markdown",
    ".py": "python",
    ".sh": "shell",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".yaml": "yaml",
    ".yml": "yaml",
}


class SourceReadError(RuntimeError):
    """Stable source-reading failure that never exposes absolute file content."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.UNPROCESSABLE_ENTITY,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class SourceReadOptions:
    context_lines: int = 6
    max_lines: int = 240
    max_file_bytes: int = 2_000_000


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(is_junction and is_junction())


def _normalize_relative_path(raw_path: str) -> PurePosixPath:
    normalized = raw_path.replace("\\", "/").strip()
    pure = PurePosixPath(normalized)
    if (
        not normalized
        or len(normalized) > 1_024
        or pure.is_absolute()
        or any(part in {"", ".", ".."} for part in pure.parts)
    ):
        raise SourceReadError(
            "invalid_source_path",
            "relativePath must be a normalized repository-relative file path.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return pure


def _language(path: Path) -> str:
    return LANGUAGE_BY_SUFFIX.get(path.suffix.casefold(), "text")


def _decode_source(path: Path, raw: bytes) -> tuple[str, str]:
    if b"\0" in raw:
        raise SourceReadError(
            "source_binary",
            "The requested source is binary and cannot be displayed as text.",
            status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
        )
    try:
        if path.suffix.casefold() == ".py":
            encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
        else:
            encoding = "utf-8-sig"
        return raw.decode(encoding), encoding
    except (LookupError, SyntaxError, UnicodeDecodeError) as exc:
        raise SourceReadError(
            "source_encoding_unsupported",
            "The requested source encoding is not supported for safe display.",
        ) from exc


class SourceReader:
    def read(
        self,
        identity: RepositoryIdentity,
        relative_path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        requested_revision: str | None = None,
        options: SourceReadOptions = SourceReadOptions(),
    ) -> dict[str, object]:
        self._validate_options(options)
        if requested_revision is not None and (
            not requested_revision.strip() or len(requested_revision) > 128
        ):
            raise SourceReadError(
                "invalid_source_revision",
                "revision must be a non-empty string of at most 128 characters.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if start_line is not None and (
            isinstance(start_line, bool) or not isinstance(start_line, int) or start_line < 1
        ):
            raise SourceReadError(
                "invalid_source_range",
                "startLine must be a positive integer.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if end_line is not None and (
            isinstance(end_line, bool)
            or not isinstance(end_line, int)
            or end_line < 1
            or (start_line is not None and end_line < start_line)
        ):
            raise SourceReadError(
                "invalid_source_range",
                "endLine must be a positive integer at or after startLine.",
                status=HTTPStatus.BAD_REQUEST,
            )

        pure_path = _normalize_relative_path(relative_path)
        unresolved = identity.root.joinpath(*pure_path.parts)
        current = identity.root
        for part in pure_path.parts:
            current = current / part
            if _is_link_or_junction(current):
                raise SourceReadError(
                    "source_link_not_allowed",
                    "Source paths may not traverse symlinks or junctions.",
                    status=HTTPStatus.FORBIDDEN,
                )
        try:
            source_path = unresolved.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise SourceReadError(
                "source_not_found",
                "The requested source file does not exist in the selected repository.",
                status=HTTPStatus.NOT_FOUND,
            ) from exc

        if not source_path.is_relative_to(identity.scan_root):
            raise SourceReadError(
                "source_outside_scope",
                "The requested source is outside the selected repository scan scope.",
                status=HTTPStatus.FORBIDDEN,
            )
        if not source_path.is_file():
            raise SourceReadError(
                "source_not_file",
                "The requested source path is not a regular file.",
            )

        try:
            with source_path.open("rb") as source_file:
                raw = source_file.read(options.max_file_bytes + 1)
        except OSError as exc:
            raise SourceReadError(
                "source_unreadable",
                "The requested source file could not be read.",
            ) from exc
        if len(raw) > options.max_file_bytes:
            raise SourceReadError(
                "source_file_limit",
                "The requested source file exceeds the configured read limit.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )

        text, encoding = _decode_source(source_path, raw)
        all_lines = text.splitlines()
        total_lines = len(all_lines)
        requested_start = start_line
        requested_end = end_line

        if total_lines == 0:
            focus_start = 0
            focus_end = 0
            window_start = 0
            window_end = 0
            excerpt_lines: list[dict[str, object]] = []
        else:
            focus_start = start_line or 1
            if focus_start > total_lines:
                raise SourceReadError(
                    "source_range_unavailable",
                    "startLine is beyond the end of the current working-tree file.",
                )
            focus_end = min(
                total_lines,
                end_line if end_line is not None else focus_start + DEFAULT_FOCUS_LINES - 1,
            )
            window_start = max(1, focus_start - options.context_lines)
            desired_end = min(total_lines, focus_end + options.context_lines)
            window_end = min(desired_end, window_start + options.max_lines - 1)
            excerpt_lines = [
                {
                    "number": line_number,
                    "text": all_lines[line_number - 1],
                    "focus": focus_start <= line_number <= focus_end,
                }
                for line_number in range(window_start, window_end + 1)
            ]

        return {
            "apiVersion": SOURCE_API_VERSION,
            "repository": identity.to_api_dict(),
            "source": {
                "path": pure_path.as_posix(),
                "language": _language(source_path),
                "encoding": encoding,
                "contentSha256": hashlib.sha256(raw).hexdigest(),
                "requestedRevision": requested_revision,
                "currentRevision": identity.revision,
                "revisionMatches": (
                    requested_revision == identity.revision
                    if requested_revision is not None
                    else None
                ),
                "contentBasis": "working-tree",
            },
            "range": {
                "requestedStartLine": requested_start,
                "requestedEndLine": requested_end,
                "focusStartLine": focus_start,
                "focusEndLine": focus_end,
                "startLine": window_start,
                "endLine": window_end,
                "totalLines": total_lines,
                "truncated": (
                    total_lines > 0 and (window_start > 1 or window_end < total_lines)
                ),
                "focusTruncated": total_lines > 0 and window_end < focus_end,
            },
            "lines": excerpt_lines,
            "readOnly": True,
            "writeOperations": False,
        }

    def _validate_options(self, options: SourceReadOptions) -> None:
        if not 0 <= options.context_lines <= 50:
            raise SourceReadError(
                "invalid_source_options",
                "contextLines must be between 0 and 50.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not 1 <= options.max_lines <= 500:
            raise SourceReadError(
                "invalid_source_options",
                "maxLines must be between 1 and 500.",
                status=HTTPStatus.BAD_REQUEST,
            )
        if not 1_024 <= options.max_file_bytes <= 4_000_000:
            raise SourceReadError(
                "invalid_source_options",
                "maxFileBytes must be between 1024 and 4000000.",
                status=HTTPStatus.BAD_REQUEST,
            )
