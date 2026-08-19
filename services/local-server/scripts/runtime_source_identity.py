"""Validate and attach server-owned source revisions to bridge evidence."""

from __future__ import annotations

import re
from typing import Any


REVISION_PATTERN = re.compile(r"^[0-9a-fA-F]{40,64}$")


def source_revisions(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    revisions: dict[str, str] = {}
    for repository, revision in value.items():
        if (
            isinstance(repository, str)
            and 0 < len(repository) <= 120
            and isinstance(revision, str)
            and REVISION_PATTERN.fullmatch(revision)
        ):
            revisions[repository] = revision.lower()
    return revisions


def attach_source_revision(
    values: dict[str, Any],
    revisions: dict[str, str],
) -> None:
    definition = values.get("definition")
    if not isinstance(definition, dict) or definition.get("revision"):
        return
    repository = definition.get("repository")
    revision = revisions.get(repository) if isinstance(repository, str) else None
    if revision:
        values["definition"] = {**definition, "revision": revision}
