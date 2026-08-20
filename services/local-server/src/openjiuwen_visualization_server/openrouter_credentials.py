"""Write-only OpenRouter credential control for the loopback settings API."""

from __future__ import annotations

import os
import threading
from http import HTTPStatus
from typing import Mapping

from .openrouter_provider import OpenRouterProviderConfig
from .secret_store import SecretStore, SecretStoreError


OPENROUTER_SECRET_HANDLE_ID = "openrouter.default"
OPENROUTER_CREDENTIAL_API_VERSION = "1.0.0"


class OpenRouterCredentialError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = HTTPStatus.BAD_REQUEST,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class OpenRouterCredentialController:
    """Resolves OS-store > environment > injected config without exposing values."""

    def __init__(
        self,
        config: OpenRouterProviderConfig,
        store: SecretStore,
        *,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self._environment = os.environ if environment is None else environment
        self._lock = threading.RLock()
        self._stored = False
        self._source = "none"
        self._store_error: str | None = None
        self._load()

    def _environment_key(self) -> str | None:
        value = (
            self._environment.get("OPENJIUWEN_OPENROUTER_API_KEY")
            or self._environment.get("OPENROUTER_API_KEY")
        )
        return OpenRouterProviderConfig.normalize_api_key(value)

    def _load(self) -> None:
        stored: str | None = None
        try:
            stored = self.store.read(OPENROUTER_SECRET_HANDLE_ID)
        except SecretStoreError as exc:
            self._store_error = exc.code
        try:
            normalized_stored = OpenRouterProviderConfig.normalize_api_key(stored)
        except ValueError:
            normalized_stored = None
            self._store_error = "secret_store_invalid_value"
        environment_key = self._environment_key()
        injected_key = self.config.api_key
        if normalized_stored:
            resolved = normalized_stored
            source = "system-credential"
            self._stored = True
        elif environment_key:
            resolved = environment_key
            source = "environment"
        elif injected_key:
            resolved = injected_key
            source = "injected"
        else:
            resolved = None
            source = "none"
        self.config.set_api_key(resolved)
        self._source = source

    def set(self, api_key: object) -> dict[str, object]:
        if not isinstance(api_key, str):
            raise OpenRouterCredentialError(
                "invalid_openrouter_credential",
                "apiKey must be a non-empty string.",
            )
        try:
            normalized = OpenRouterProviderConfig.normalize_api_key(api_key)
        except ValueError as exc:
            raise OpenRouterCredentialError(
                "invalid_openrouter_credential",
                str(exc),
            ) from exc
        if not normalized:
            raise OpenRouterCredentialError(
                "invalid_openrouter_credential",
                "apiKey must be a non-empty string.",
            )
        if not self.store.descriptor.writable:
            raise OpenRouterCredentialError(
                "secret_store_unavailable",
                "Persistent operating-system credential storage is unavailable.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        with self._lock:
            try:
                self.store.write(OPENROUTER_SECRET_HANDLE_ID, normalized)
            except SecretStoreError as exc:
                raise OpenRouterCredentialError(
                    exc.code,
                    str(exc),
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                ) from exc
            self.config.set_api_key(normalized)
            self._stored = True
            self._source = "system-credential"
            self._store_error = None
            return self.descriptor()

    def delete(self) -> dict[str, object]:
        with self._lock:
            if not self._stored:
                raise OpenRouterCredentialError(
                    "credential_not_managed",
                    "The active OpenRouter credential is not managed by this settings page.",
                    status=HTTPStatus.CONFLICT,
                )
            try:
                self.store.delete(OPENROUTER_SECRET_HANDLE_ID)
            except SecretStoreError as exc:
                raise OpenRouterCredentialError(
                    exc.code,
                    str(exc),
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                ) from exc
            self._stored = False
            fallback = self._environment_key()
            self.config.set_api_key(fallback)
            self._source = "environment" if fallback else "none"
            self._store_error = None
            return self.descriptor()

    def descriptor(self) -> dict[str, object]:
        with self._lock:
            return {
                "apiVersion": OPENROUTER_CREDENTIAL_API_VERSION,
                "credential": {
                    "handleId": OPENROUTER_SECRET_HANDLE_ID,
                    "configured": self.config.configured,
                    "source": self._source,
                    "writable": self.store.descriptor.writable,
                    "canDelete": self._stored,
                    "exposure": "write-only",
                    "environmentFallback": self._environment_key() is not None,
                    "storage": self.store.descriptor.to_api_dict(),
                    **(
                        {"diagnostic": {"code": self._store_error}}
                        if self._store_error
                        else {}
                    ),
                },
            }
