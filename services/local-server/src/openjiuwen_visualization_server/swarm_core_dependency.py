"""Read-only JiuwenSwarm configuration inspection for its Agent Core dependency."""

from __future__ import annotations

import hashlib
import re
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .config import LocalServiceConfig, PathAccessError
from .repository import RepositoryResolutionError, RepositoryResolver


SWARM_CORE_DEPENDENCY_API_VERSION = "1.0.0"
CORE_PACKAGE_NAME = "openjiuwen"
PYPROJECT_MAX_BYTES = 2 * 1024 * 1024
LOCKFILE_MAX_BYTES = 32 * 1024 * 1024
SUPPORTED_GIT_HOSTS = frozenset({"github.com", "gitcode.com"})
COMMIT_PATTERN = re.compile(r"^[0-9a-fA-F]{7,64}$")


class SwarmCoreDependencyError(ValueError):
    """Stable inspection failure rendered as structured, non-secret status."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _normalize_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).casefold()


def _requirement_name(requirement: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9_.-]+)", requirement)
    return _normalize_package_name(match.group(1)) if match else ""


def _canonical_git_url(url: str) -> str:
    split = urlsplit(url)
    path = split.path.rstrip("/")
    if path.casefold().endswith(".git"):
        path = path[:-4]
    return f"{split.hostname.casefold() if split.hostname else ''}{path.casefold()}"


def _safe_git_url(raw_url: object) -> str:
    if not isinstance(raw_url, str) or not raw_url.strip() or len(raw_url) > 2_048:
        raise SwarmCoreDependencyError(
            "invalid_core_git_source",
            "The Swarm Core Git source is missing or invalid.",
        )
    candidate = raw_url.strip()
    if candidate.startswith("git+"):
        candidate = candidate[4:]
    split = urlsplit(candidate)
    host = split.hostname.casefold() if split.hostname else ""
    if (
        split.scheme.casefold() != "https"
        or host not in SUPPORTED_GIT_HOSTS
        or split.username is not None
        or split.password is not None
        or split.port is not None
        or split.query
        or split.fragment
        or not split.path.strip("/")
        or any(part in {".", ".."} for part in split.path.split("/"))
    ):
        raise SwarmCoreDependencyError(
            "unsupported_core_git_source",
            "Only credential-free HTTPS Core sources on GitHub or GitCode are supported.",
        )
    return urlunsplit(("https", host, split.path.rstrip("/"), "", ""))


def _safe_requirement(requirement: str) -> str:
    """Keep ordinary PEP 508 evidence while never returning direct-source secrets."""

    if "://" not in requirement:
        return requirement[:2_048]
    parsed = _direct_git_requirement(requirement)
    if parsed is None:
        return f"{CORE_PACKAGE_NAME} @ <unsupported-direct-source>"
    url, reference = parsed
    suffix = f"@{reference}" if reference else ""
    return f"{CORE_PACKAGE_NAME} @ git+{url}{suffix}"


def _direct_git_requirement(requirement: str) -> tuple[str, str | None] | None:
    if "@" not in requirement:
        return None
    direct = requirement.split("@", 1)[1].strip()
    if not direct.startswith("git+https://"):
        return None
    raw_url = direct[4:]
    reference: str | None = None
    if "@" in raw_url:
        raw_url, reference = raw_url.rsplit("@", 1)
        reference = reference.strip() or None
    try:
        return _safe_git_url(raw_url), reference
    except SwarmCoreDependencyError:
        return None


class SwarmCoreDependencyInspector:
    """Parse config files without importing project code or changing either checkout."""

    def __init__(
        self,
        config: LocalServiceConfig,
        resolver: RepositoryResolver,
    ) -> None:
        self._config = config
        self._resolver = resolver

    def inspect(self, raw_swarm_root: str | Path) -> dict[str, object]:
        inspected_at = _utc_now()
        root_text = str(Path(raw_swarm_root).resolve(strict=False))
        try:
            swarm_root = self._config.authorize_directory(raw_swarm_root)
            pyproject, pyproject_evidence = self._read_toml(
                swarm_root,
                "pyproject.toml",
                PYPROJECT_MAX_BYTES,
            )
            lock, lock_evidence = self._read_optional_toml(
                swarm_root,
                "uv.lock",
                LOCKFILE_MAX_BYTES,
            )
            inspection = self._inspect_documents(
                swarm_root,
                pyproject,
                lock,
            )
            return {
                "apiVersion": SWARM_CORE_DEPENDENCY_API_VERSION,
                "inspectedAt": inspected_at,
                "swarmRoot": str(swarm_root),
                **inspection,
                "evidence": {
                    "pyproject": pyproject_evidence,
                    "uvLock": lock_evidence,
                },
            }
        except SwarmCoreDependencyError as exc:
            return self._failure(inspected_at, root_text, exc.code, str(exc))
        except PathAccessError as exc:
            return self._failure(
                inspected_at,
                root_text,
                "swarm_repository_not_allowed",
                str(exc),
            )
        except (
            AttributeError,
            OSError,
            RuntimeError,
            TypeError,
            UnicodeError,
            ValueError,
        ):
            return self._failure(
                inspected_at,
                root_text,
                "swarm_config_unreadable",
                "JiuwenSwarm dependency configuration could not be read safely.",
            )

    @staticmethod
    def _failure(
        inspected_at: str,
        swarm_root: str,
        code: str,
        message: str,
    ) -> dict[str, object]:
        return {
            "apiVersion": SWARM_CORE_DEPENDENCY_API_VERSION,
            "status": "unavailable",
            "code": code,
            "message": message,
            "inspectedAt": inspected_at,
            "swarmRoot": swarm_root,
            "source": None,
            "evidence": {"pyproject": None, "uvLock": None},
        }

    def _inspect_documents(
        self,
        swarm_root: Path,
        pyproject: dict[str, Any],
        lock: dict[str, Any] | None,
    ) -> dict[str, object]:
        dependencies = pyproject.get("project", {}).get("dependencies", [])
        if not isinstance(dependencies, list):
            raise SwarmCoreDependencyError(
                "invalid_swarm_dependencies",
                "project.dependencies must be an array before Core can be resolved.",
            )
        requirement = next(
            (
                item
                for item in dependencies
                if isinstance(item, str)
                and _requirement_name(item) == CORE_PACKAGE_NAME
            ),
            None,
        )
        if requirement is None:
            raise SwarmCoreDependencyError(
                "core_dependency_missing",
                "JiuwenSwarm does not declare an openjiuwen dependency.",
            )

        uv = pyproject.get("tool", {}).get("uv", {})
        sources = uv.get("sources", {}) if isinstance(uv, dict) else {}
        configured = sources.get(CORE_PACKAGE_NAME) if isinstance(sources, dict) else None
        lock_package = self._lock_package(lock)
        safe_requirement = _safe_requirement(requirement)

        if isinstance(configured, dict) and "path" in configured:
            return self._inspect_path_source(
                swarm_root,
                configured.get("path"),
                safe_requirement,
            )
        if isinstance(configured, dict) and "git" in configured:
            return self._inspect_git_source(
                configured,
                safe_requirement,
                lock_package,
            )

        direct = _direct_git_requirement(requirement)
        if direct is not None:
            url, reference = direct
            return self._git_result(
                url=url,
                reference_kind=(
                    "rev"
                    if reference and COMMIT_PATTERN.fullmatch(reference)
                    else "branch"
                    if reference
                    else "unspecified"
                ),
                reference=reference,
                declared=safe_requirement,
                lock_package=lock_package,
            )
        if "://" in requirement:
            raise SwarmCoreDependencyError(
                "unsupported_core_direct_source",
                "The direct Core dependency source is not a supported credential-free Git URL.",
            )

        lock_version = (
            str(lock_package.get("version"))
            if lock_package is not None and lock_package.get("version") is not None
            else None
        )
        return {
            "status": "attention",
            "code": "registry_core_dependency",
            "message": "Core resolves from a package registry; repository-level source inspection is unavailable.",
            "source": {
                "kind": "registry",
                "package": CORE_PACKAGE_NAME,
                "declaredRequirement": safe_requirement,
                "lockedVersion": lock_version,
                "lockStatus": "locked" if lock_version else "unlocked",
            },
        }

    def _inspect_path_source(
        self,
        swarm_root: Path,
        raw_path: object,
        declared: str,
    ) -> dict[str, object]:
        if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 2_048:
            raise SwarmCoreDependencyError(
                "invalid_core_path_source",
                "The local Core dependency path is missing or invalid.",
            )
        configured_path = Path(raw_path.strip())
        candidate = (
            configured_path
            if configured_path.is_absolute()
            else swarm_root / configured_path
        )
        try:
            authorized = self._config.authorize_directory(candidate)
            identity = self._resolver.resolve(authorized)
        except (PathAccessError, RepositoryResolutionError, OSError) as exc:
            raise SwarmCoreDependencyError(
                "core_path_unavailable",
                "The local Core dependency is outside allowed roots or is not a readable Git repository.",
            ) from exc
        if not (identity.root / "openjiuwen" / "harness" / "deep_agent.py").is_file():
            raise SwarmCoreDependencyError(
                "core_path_framework_mismatch",
                "The local dependency path does not contain Agent Core framework sources.",
            )
        return {
            "status": "ready",
            "code": "local_core_dependency",
            "message": "Swarm resolves Agent Core from the configured local repository path.",
            "source": {
                "kind": "path",
                "package": CORE_PACKAGE_NAME,
                "declaredRequirement": declared,
                "configuredPath": raw_path.strip(),
                "path": str(identity.root),
                "revision": identity.revision,
                "branch": identity.branch,
                "dirty": identity.dirty,
                "lockStatus": "local",
            },
        }

    def _inspect_git_source(
        self,
        configured: dict[str, Any],
        declared: str,
        lock_package: dict[str, Any] | None,
    ) -> dict[str, object]:
        url = _safe_git_url(configured.get("git"))
        reference_kind = "unspecified"
        reference: str | None = None
        for kind in ("rev", "tag", "branch"):
            value = configured.get(kind)
            if isinstance(value, str) and value.strip():
                reference_kind = kind
                reference = value.strip()[:512]
                break
        return self._git_result(
            url=url,
            reference_kind=reference_kind,
            reference=reference,
            declared=declared,
            lock_package=lock_package,
        )

    def _git_result(
        self,
        *,
        url: str,
        reference_kind: str,
        reference: str | None,
        declared: str,
        lock_package: dict[str, Any] | None,
    ) -> dict[str, object]:
        locked_revision: str | None = None
        locked_url: str | None = None
        if lock_package is not None:
            source = lock_package.get("source")
            raw_locked_url = source.get("git") if isinstance(source, dict) else None
            if isinstance(raw_locked_url, str):
                split = urlsplit(raw_locked_url)
                clean = urlunsplit((split.scheme, split.netloc, split.path, "", ""))
                locked_url = _safe_git_url(clean)
                if split.fragment and COMMIT_PATTERN.fullmatch(split.fragment):
                    locked_revision = split.fragment.casefold()
                if _canonical_git_url(locked_url) != _canonical_git_url(url):
                    return {
                        "status": "attention",
                        "code": "core_lock_source_mismatch",
                        "message": "uv.lock resolves openjiuwen from a different Git repository than pyproject.toml.",
                        "source": {
                            "kind": "git",
                            "package": CORE_PACKAGE_NAME,
                            "declaredRequirement": declared,
                            "url": url,
                            "ref": {"kind": reference_kind, "value": reference},
                            "lockedUrl": locked_url,
                            "lockedRevision": locked_revision,
                            "lockStatus": "mismatch",
                        },
                    }
        locked = locked_revision is not None
        return {
            "status": "ready" if locked else "attention",
            "code": "git_core_dependency_locked" if locked else "git_core_dependency_unlocked",
            "message": (
                "Swarm Core dependency is pinned by uv.lock to an exact Git revision."
                if locked
                else "Swarm declares a Git Core source, but no exact locked revision is available."
            ),
            "source": {
                "kind": "git",
                "package": CORE_PACKAGE_NAME,
                "declaredRequirement": declared,
                "url": url,
                "ref": {"kind": reference_kind, "value": reference},
                "lockedUrl": locked_url,
                "lockedRevision": locked_revision,
                "lockStatus": "locked" if locked else "unlocked",
            },
        }

    @staticmethod
    def _lock_package(lock: dict[str, Any] | None) -> dict[str, Any] | None:
        packages = lock.get("package", []) if isinstance(lock, dict) else []
        if not isinstance(packages, list):
            return None
        return next(
            (
                package
                for package in packages
                if isinstance(package, dict)
                and _normalize_package_name(str(package.get("name", "")))
                == CORE_PACKAGE_NAME
            ),
            None,
        )

    def _read_optional_toml(
        self,
        root: Path,
        filename: str,
        max_bytes: int,
    ) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        candidate = root / filename
        if not candidate.exists():
            return None, None
        return self._read_toml(root, filename, max_bytes)

    @staticmethod
    def _read_toml(
        root: Path,
        filename: str,
        max_bytes: int,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        candidate = root / filename
        resolved = candidate.resolve(strict=True)
        if (
            candidate.is_symlink()
            or not resolved.is_relative_to(root)
            or not resolved.is_file()
        ):
            raise SwarmCoreDependencyError(
                "unsafe_swarm_config_path",
                f"{filename} must be a regular file inside the JiuwenSwarm repository.",
            )
        size = resolved.stat().st_size
        if size > max_bytes:
            raise SwarmCoreDependencyError(
                "swarm_config_too_large",
                f"{filename} exceeds the safe inspection size limit.",
            )
        content = resolved.read_bytes()
        document = tomllib.loads(content.decode("utf-8"))
        return document, {
            "path": str(resolved),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
