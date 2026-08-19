"""Read-only source revision evidence for isolated runtime producers."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Iterable


REVISION_PATTERN = re.compile(r"^[0-9a-fA-F]{40,64}$")


def git_head_revision(repository: Path) -> str | None:
    """Return a bounded HEAD object id without modifying the checkout."""

    if not repository.is_dir():
        return None
    environment = dict(os.environ)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    try:
        result = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "--verify", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    revision = result.stdout.strip()
    if result.returncode != 0 or not REVISION_PATTERN.fullmatch(revision):
        return None
    return revision.lower()


def runtime_source_revisions(
    repositories: Iterable[tuple[str, Path]],
) -> dict[str, str]:
    revisions: dict[str, str] = {}
    for name, repository in repositories:
        revision = git_head_revision(repository)
        if revision:
            revisions[name] = revision
    return revisions
