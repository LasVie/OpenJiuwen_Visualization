"""Bounded memory-only cache for static Definition graph scans."""

from __future__ import annotations

import copy
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from .repository import RepositoryIdentity
from .scanner import PythonRepositoryScanner, ScanManifest, ScanOptions


@dataclass(slots=True)
class _CacheEntry:
    fingerprint: str
    result: dict[str, object]
    created_at: float
    last_accessed_at: float
    size_bytes: int


class DefinitionScanCache:
    """Validate source inputs, then reuse immutable deep-copied scan results."""

    def __init__(
        self,
        scanner: PythonRepositoryScanner | None = None,
        *,
        max_entries: int = 8,
        ttl_seconds: float = 300.0,
        max_manifest_bytes: int = 128_000_000,
        max_entry_bytes: int = 24_000_000,
        max_total_bytes: int = 96_000_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 1 <= max_entries <= 32:
            raise ValueError("max_entries must be between 1 and 32.")
        if not 5 <= ttl_seconds <= 3_600:
            raise ValueError("ttl_seconds must be between 5 and 3600.")
        if not 1_000_000 <= max_manifest_bytes <= 512_000_000:
            raise ValueError("max_manifest_bytes must be between 1000000 and 512000000.")
        if not 1_000 <= max_entry_bytes <= 128_000_000:
            raise ValueError("max_entry_bytes must be between 1000 and 128000000.")
        if not max_entry_bytes <= max_total_bytes <= 512_000_000:
            raise ValueError(
                "max_total_bytes must be at least max_entry_bytes and at most 512000000."
            )
        self._scanner = scanner or PythonRepositoryScanner()
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._max_manifest_bytes = max_manifest_bytes
        self._max_entry_bytes = max_entry_bytes
        self._max_total_bytes = max_total_bytes
        self._clock = clock
        self._entries: OrderedDict[tuple[object, ...], _CacheEntry] = OrderedDict()
        self._total_bytes = 0
        self._lock = threading.Lock()

    def scan(
        self,
        identity: RepositoryIdentity,
        options: ScanOptions = ScanOptions(),
    ) -> dict[str, object]:
        started = self._clock()
        manifest = self._scanner.manifest(
            identity,
            options,
            max_hashed_bytes=self._max_manifest_bytes,
        )
        validation_ms = max(0, round((self._clock() - started) * 1_000))
        key = self._key(identity, options)

        if manifest.cacheable:
            with self._lock:
                now = self._clock()
                self._prune_expired(now)
                entry = self._entries.get(key)
                if entry and entry.fingerprint == manifest.fingerprint:
                    entry.last_accessed_at = now
                    self._entries.move_to_end(key)
                    result = copy.deepcopy(entry.result)
                    return self._decorate(
                        result,
                        status="hit",
                        manifest=manifest,
                        validation_ms=validation_ms,
                        age_ms=max(0, round((now - entry.created_at) * 1_000)),
                        source_duration_ms=self._source_duration(entry.result),
                        result_size_bytes=entry.size_bytes,
                        request_started=started,
                    )
                if entry:
                    self._remove(key)

        result = self._scanner.scan(identity, options)
        source_duration_ms = self._source_duration(result)
        if manifest.cacheable:
            post_validation_started = self._clock()
            verified_manifest = self._scanner.manifest(
                identity,
                options,
                max_hashed_bytes=self._max_manifest_bytes,
            )
            validation_ms += max(
                0,
                round((self._clock() - post_validation_started) * 1_000),
            )
            if not verified_manifest.cacheable:
                manifest = verified_manifest
            elif verified_manifest.fingerprint != manifest.fingerprint:
                manifest = ScanManifest(
                    fingerprint=verified_manifest.fingerprint,
                    python_files=verified_manifest.python_files,
                    bytes_hashed=verified_manifest.bytes_hashed,
                    truncated=verified_manifest.truncated,
                    cacheable=False,
                    bypass_reason="manifest-changed-during-scan",
                )

        result_size_bytes: int | None = None
        if manifest.cacheable:
            result_size_bytes = len(
                json.dumps(
                    result,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            if result_size_bytes > self._max_entry_bytes:
                manifest = ScanManifest(
                    fingerprint=manifest.fingerprint,
                    python_files=manifest.python_files,
                    bytes_hashed=manifest.bytes_hashed,
                    truncated=manifest.truncated,
                    cacheable=False,
                    bypass_reason="result-byte-limit",
                )

        if manifest.cacheable:
            with self._lock:
                now = self._clock()
                self._prune_expired(now)
                if key in self._entries:
                    self._remove(key)
                assert result_size_bytes is not None
                self._entries[key] = _CacheEntry(
                    fingerprint=manifest.fingerprint,
                    result=copy.deepcopy(result),
                    created_at=now,
                    last_accessed_at=now,
                    size_bytes=result_size_bytes,
                )
                self._total_bytes += result_size_bytes
                self._entries.move_to_end(key)
                while (
                    len(self._entries) > self._max_entries
                    or self._total_bytes > self._max_total_bytes
                ):
                    oldest_key = next(iter(self._entries))
                    self._remove(oldest_key)

        return self._decorate(
            result,
            status="miss" if manifest.cacheable else "bypass",
            manifest=manifest,
            validation_ms=validation_ms,
            age_ms=0,
            source_duration_ms=source_duration_ms,
            result_size_bytes=result_size_bytes,
            request_started=started,
        )

    def _decorate(
        self,
        result: dict[str, object],
        *,
        status: str,
        manifest: ScanManifest,
        validation_ms: int,
        age_ms: int,
        source_duration_ms: int,
        result_size_bytes: int | None,
        request_started: float,
    ) -> dict[str, object]:
        response = copy.deepcopy(result)
        statistics = response.get("statistics")
        if not isinstance(statistics, dict):
            raise TypeError("Scanner result does not contain statistics.")
        statistics["durationMs"] = max(0, round((self._clock() - request_started) * 1_000))
        cache: dict[str, object] = {
            "status": status,
            "storage": "memory-only",
            "validationMs": validation_ms,
            "sourceDurationMs": source_duration_ms,
            "ageMs": age_ms,
            "pythonFiles": manifest.python_files,
            "bytesHashed": manifest.bytes_hashed,
            "ttlSeconds": round(self._ttl_seconds),
            "maxEntries": self._max_entries,
            "maxEntryBytes": self._max_entry_bytes,
            "maxTotalBytes": self._max_total_bytes,
        }
        if result_size_bytes is not None:
            cache["resultBytes"] = result_size_bytes
        if manifest.bypass_reason:
            cache["bypassReason"] = manifest.bypass_reason
        statistics["cache"] = cache
        return response

    def _prune_expired(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._entries.items()
            if now - entry.last_accessed_at > self._ttl_seconds
        ]
        for key in expired:
            self._remove(key)

    def _remove(self, key: tuple[object, ...]) -> None:
        entry = self._entries.pop(key, None)
        if entry:
            self._total_bytes = max(0, self._total_bytes - entry.size_bytes)

    @staticmethod
    def _source_duration(result: dict[str, object]) -> int:
        statistics = result.get("statistics")
        if isinstance(statistics, dict):
            value = statistics.get("durationMs")
            if isinstance(value, int) and not isinstance(value, bool):
                return max(0, value)
        return 0

    @staticmethod
    def _key(
        identity: RepositoryIdentity,
        options: ScanOptions,
    ) -> tuple[object, ...]:
        return (
            str(identity.root).casefold(),
            str(identity.scan_root).casefold(),
            options,
        )
