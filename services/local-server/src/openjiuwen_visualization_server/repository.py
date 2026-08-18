"""Read-only Git repository identity resolution."""

from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import LocalServiceConfig, PathAccessError


class RepositoryResolutionError(RuntimeError):
    """Raised when a directory cannot be resolved to a readable Git repository."""


@dataclass(frozen=True, slots=True)
class RepositoryIdentity:
    id: str
    name: str
    owner: str
    root: Path
    scan_root: Path
    revision: str
    branch: str
    dirty: bool

    def to_api_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "owner": self.owner,
            "path": str(self.root),
            "scanScope": str(self.scan_root),
            "revision": self.revision,
            "branch": self.branch,
            "dirty": self.dirty,
        }


def _owner_name(repository_name: str) -> str:
    normalized = repository_name.lower()
    if normalized == "agent-core":
        return "agent-core"
    if normalized == "jiuwenswarm":
        return "jiuwenswarm"
    slug = re.sub(r"[^a-z0-9.-]+", "-", normalized).strip("-.")
    return slug or "local-repository"


class RepositoryResolver:
    def __init__(self, config: LocalServiceConfig, *, git_timeout_seconds: float = 8.0):
        self._config = config
        self._git_timeout_seconds = git_timeout_seconds

    def resolve(self, raw_path: str | Path) -> RepositoryIdentity:
        scan_root = self._config.authorize_directory(raw_path)
        root_text = self._git(scan_root, "rev-parse", "--show-toplevel")
        if not root_text:
            raise RepositoryResolutionError(f"Not a Git repository: {scan_root}")

        repository_root = self._config.authorize_directory(root_text)
        if not (scan_root == repository_root or scan_root.is_relative_to(repository_root)):
            raise PathAccessError("Scan path does not belong to the resolved Git repository.")

        revision = self._git(repository_root, "rev-parse", "HEAD")
        if not revision:
            raise RepositoryResolutionError("Repository has no readable HEAD revision.")
        branch = self._git(repository_root, "branch", "--show-current") or "detached"
        dirty = bool(
            self._git(
                repository_root,
                "status",
                "--porcelain=v1",
                "--untracked-files=normal",
            )
        )
        canonical_path = str(repository_root).casefold().encode("utf-8")
        repository_id = hashlib.sha256(canonical_path).hexdigest()[:16]
        name = repository_root.name
        return RepositoryIdentity(
            id=repository_id,
            name=name,
            owner=_owner_name(name),
            root=repository_root,
            scan_root=scan_root,
            revision=revision,
            branch=branch,
            dirty=dirty,
        )

    def discover(self, *, max_candidates_per_root: int = 200) -> tuple[RepositoryIdentity, ...]:
        """Find Git repositories at an allowed root or one directory below it."""
        discovered: dict[str, RepositoryIdentity] = {}
        for allowed_root in self._config.allowed_roots:
            candidates: list[Path] = []
            if (allowed_root / ".git").exists():
                candidates.append(allowed_root)

            try:
                children = sorted(allowed_root.iterdir(), key=lambda path: path.name.casefold())
            except OSError:
                children = []
            for child in children[:max_candidates_per_root]:
                is_junction = getattr(child, "is_junction", None)
                if child.is_symlink() or bool(is_junction and is_junction()):
                    continue
                try:
                    if child.is_dir() and (child / ".git").exists():
                        candidates.append(child)
                except OSError:
                    continue

            for candidate in candidates:
                try:
                    identity = self.resolve(candidate)
                except (OSError, PathAccessError, RepositoryResolutionError):
                    continue
                discovered[identity.id] = identity

        owner_order = {"agent-core": 0, "jiuwenswarm": 1}
        return tuple(
            sorted(
                discovered.values(),
                key=lambda item: (
                    owner_order.get(item.owner, 2),
                    item.name.casefold(),
                    str(item.root).casefold(),
                ),
            )
        )

    def _git(self, cwd: Path, *args: str) -> str:
        try:
            completed = subprocess.run(
                ["git", "-C", str(cwd), *args],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                timeout=self._git_timeout_seconds,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise RepositoryResolutionError(f"Git command failed: {args[0]}") from exc
        if completed.returncode != 0:
            return ""
        return completed.stdout.strip()
