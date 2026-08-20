"""Opaque local secret storage with a Windows Credential Manager backend."""

from __future__ import annotations

import os
import threading
import ctypes
from ctypes import POINTER, Structure, byref, cast, string_at
from ctypes import c_byte, c_void_p, c_wchar_p
from ctypes import wintypes
from dataclasses import dataclass
from typing import Protocol


ERROR_NOT_FOUND = 1168
CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2
MAX_CREDENTIAL_BYTES = 2_560


class SecretStoreError(RuntimeError):
    """Stable local error that never includes credential contents."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SecretStoreDescriptor:
    id: str
    available: bool
    writable: bool
    persistence: str

    def to_api_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "available": self.available,
            "writable": self.writable,
            "persistence": self.persistence,
        }


class SecretStore(Protocol):
    @property
    def descriptor(self) -> SecretStoreDescriptor: ...

    def read(self, handle_id: str) -> str | None: ...

    def write(self, handle_id: str, value: str) -> None: ...

    def delete(self, handle_id: str) -> bool: ...


class UnavailableSecretStore:
    """Read-empty store used when persistent OS storage is unavailable or disabled."""

    def __init__(self, store_id: str = "unavailable") -> None:
        self._descriptor = SecretStoreDescriptor(
            id=store_id,
            available=False,
            writable=False,
            persistence="none",
        )

    @property
    def descriptor(self) -> SecretStoreDescriptor:
        return self._descriptor

    def read(self, handle_id: str) -> str | None:
        del handle_id
        return None

    def write(self, handle_id: str, value: str) -> None:
        del handle_id, value
        raise SecretStoreError(
            "secret_store_unavailable",
            "The operating-system credential store is unavailable.",
        )

    def delete(self, handle_id: str) -> bool:
        del handle_id
        raise SecretStoreError(
            "secret_store_unavailable",
            "The operating-system credential store is unavailable.",
        )


class MemorySecretStore:
    """Explicit non-persistent store for isolated tests and embedded callers."""

    def __init__(self, values: dict[str, str] | None = None) -> None:
        self._values = dict(values or {})
        self._lock = threading.RLock()
        self._descriptor = SecretStoreDescriptor(
            id="memory",
            available=True,
            writable=True,
            persistence="process",
        )

    @property
    def descriptor(self) -> SecretStoreDescriptor:
        return self._descriptor

    def read(self, handle_id: str) -> str | None:
        with self._lock:
            return self._values.get(handle_id)

    def write(self, handle_id: str, value: str) -> None:
        with self._lock:
            self._values[handle_id] = value

    def delete(self, handle_id: str) -> bool:
        with self._lock:
            return self._values.pop(handle_id, None) is not None


class _FILETIME(Structure):
    _fields_ = [
        ("dwLowDateTime", wintypes.DWORD),
        ("dwHighDateTime", wintypes.DWORD),
    ]


class _CREDENTIALW(Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", c_wchar_p),
        ("Comment", c_wchar_p),
        ("LastWritten", _FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", POINTER(c_byte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", c_void_p),
        ("TargetAlias", c_wchar_p),
        ("UserName", c_wchar_p),
    ]


class WindowsCredentialManagerStore:
    """Current-user generic credentials backed by the Windows credential vault."""

    def __init__(self, *, target_prefix: str = "OpenJiuwen.Visualization") -> None:
        if os.name != "nt":
            raise SecretStoreError(
                "secret_store_unsupported",
                "Windows Credential Manager is only available on Windows.",
            )
        self._target_prefix = target_prefix.rstrip("/")
        self._api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        self._api.CredReadW.argtypes = [
            c_wchar_p,
            wintypes.DWORD,
            wintypes.DWORD,
            POINTER(POINTER(_CREDENTIALW)),
        ]
        self._api.CredReadW.restype = wintypes.BOOL
        self._api.CredWriteW.argtypes = [POINTER(_CREDENTIALW), wintypes.DWORD]
        self._api.CredWriteW.restype = wintypes.BOOL
        self._api.CredDeleteW.argtypes = [c_wchar_p, wintypes.DWORD, wintypes.DWORD]
        self._api.CredDeleteW.restype = wintypes.BOOL
        self._api.CredFree.argtypes = [c_void_p]
        self._api.CredFree.restype = None
        self._lock = threading.RLock()
        self._descriptor = SecretStoreDescriptor(
            id="windows-credential-manager",
            available=True,
            writable=True,
            persistence="current-user",
        )

    @property
    def descriptor(self) -> SecretStoreDescriptor:
        return self._descriptor

    def _target(self, handle_id: str) -> str:
        return f"{self._target_prefix}/{handle_id}"

    @staticmethod
    def _raise(operation: str) -> None:
        error = ctypes.get_last_error()
        raise SecretStoreError(
            f"secret_store_{operation}_failed",
            f"Windows Credential Manager could not {operation} the credential (OS error {error}).",
        )

    def read(self, handle_id: str) -> str | None:
        credential = POINTER(_CREDENTIALW)()
        with self._lock:
            success = self._api.CredReadW(
                self._target(handle_id),
                CRED_TYPE_GENERIC,
                0,
                byref(credential),
            )
            if not success:
                if ctypes.get_last_error() == ERROR_NOT_FOUND:
                    return None
                self._raise("read")
            try:
                item = credential.contents
                if item.CredentialBlobSize == 0:
                    return None
                raw = string_at(item.CredentialBlob, item.CredentialBlobSize)
                return raw.decode("utf-16-le")
            except (UnicodeDecodeError, ValueError) as exc:
                raise SecretStoreError(
                    "secret_store_invalid_value",
                    "Windows Credential Manager returned an invalid credential value.",
                ) from exc
            finally:
                self._api.CredFree(cast(credential, c_void_p))

    def write(self, handle_id: str, value: str) -> None:
        raw = value.encode("utf-16-le")
        if not raw or len(raw) > MAX_CREDENTIAL_BYTES:
            raise SecretStoreError(
                "secret_store_value_too_large",
                "The credential is empty or exceeds the Windows credential size limit.",
            )
        blob = (c_byte * len(raw)).from_buffer_copy(raw)
        credential = _CREDENTIALW()
        credential.Type = CRED_TYPE_GENERIC
        credential.TargetName = self._target(handle_id)
        credential.CredentialBlobSize = len(raw)
        credential.CredentialBlob = cast(blob, POINTER(c_byte))
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE
        credential.UserName = "OpenJiuwen Visualization"
        with self._lock:
            if not self._api.CredWriteW(byref(credential), 0):
                self._raise("write")

    def delete(self, handle_id: str) -> bool:
        with self._lock:
            success = self._api.CredDeleteW(
                self._target(handle_id),
                CRED_TYPE_GENERIC,
                0,
            )
            if success:
                return True
            if ctypes.get_last_error() == ERROR_NOT_FOUND:
                return False
            self._raise("delete")
        return False


def system_secret_store(*, enabled: bool) -> SecretStore:
    if not enabled:
        return UnavailableSecretStore("disabled")
    if os.name != "nt":
        return UnavailableSecretStore("unsupported-platform")
    try:
        return WindowsCredentialManagerStore()
    except (OSError, SecretStoreError):
        return UnavailableSecretStore("windows-credential-manager-error")
