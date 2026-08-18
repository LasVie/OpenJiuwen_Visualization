"""Static Python repository indexing without importing target code."""

from __future__ import annotations

import ast
import hashlib
import os
import time
import tokenize
import warnings as python_warnings
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..repository import RepositoryIdentity


GRAPH_SCHEMA_VERSION = "1.0.0"
PLUGIN_ID = "openjiuwen.local-repository"
SCAN_MANIFEST_VERSION = "python-ast-manifest-v1"
DEFAULT_MAX_MANIFEST_BYTES = 128_000_000

_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".git",
        ".hg",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "node_modules",
        "venv",
    }
)
_TEST_DIRECTORIES = frozenset({"test", "tests"})


@dataclass(frozen=True, slots=True)
class ScanOptions:
    include_tests: bool = False
    include_functions: bool = False
    max_files: int = 5_000
    max_file_bytes: int = 1_000_000
    max_edges: int = 20_000

    def __post_init__(self) -> None:
        if not 1 <= self.max_files <= 20_000:
            raise ValueError("max_files must be between 1 and 20000.")
        if not 1_024 <= self.max_file_bytes <= 10_000_000:
            raise ValueError("max_file_bytes must be between 1024 and 10000000.")
        if not 1 <= self.max_edges <= 100_000:
            raise ValueError("max_edges must be between 1 and 100000.")


@dataclass(frozen=True, slots=True)
class ScanManifest:
    fingerprint: str
    python_files: int
    bytes_hashed: int
    truncated: bool
    cacheable: bool
    bypass_reason: str | None = None


@dataclass(slots=True)
class _ModuleRecord:
    node_id: str
    module_name: str
    source_path: str
    imports: set[str]


def _dotted_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    if isinstance(node, ast.Subscript):
        return _dotted_name(node.value)
    if isinstance(node, ast.Call):
        return _dotted_name(node.func)
    return ""


def _summary(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    first_line = " ".join(value.strip().splitlines()[0].split())
    return first_line[:240] or fallback


def _edge_id(kind: str, source: str, target: str) -> str:
    digest = hashlib.sha256(f"{kind}\0{source}\0{target}".encode("utf-8")).hexdigest()[:20]
    return f"edge:{kind}:{digest}"


def _source_path(path: Path, repository_root: Path) -> str:
    return path.relative_to(repository_root).as_posix()


def _stable_id(identity: RepositoryIdentity, source_path: str, symbol: str | None = None) -> str:
    base = f"{identity.name}@{identity.revision}:{source_path}"
    return f"{base}:{symbol}" if symbol else base


def _evidence(
    identity: RepositoryIdentity,
    source_path: str,
    *,
    symbol: str | None = None,
    start_line: int | None = None,
    end_line: int | None = None,
) -> list[dict[str, object]]:
    source: dict[str, object] = {
        "repository": identity.name,
        "revision": identity.revision,
        "path": source_path,
    }
    if symbol:
        source["symbol"] = symbol
    if start_line is not None:
        source["startLine"] = start_line
    if end_line is not None:
        source["endLine"] = end_line
    value: dict[str, object] = {
        "provenance": "static",
        "confidence": "exact",
        "source": source,
    }
    if identity.dirty:
        value["note"] = "Scanned from a working tree with changes beyond the referenced revision."
    return [value]


def _node(
    *,
    node_id: str,
    kind: str,
    level: int,
    owner: str,
    label: str,
    summary: str,
    parent_id: str | None,
    expandable: bool,
    attributes: dict[str, object],
    evidence: list[dict[str, object]],
) -> dict[str, object]:
    value: dict[str, object] = {
        "id": node_id,
        "kind": kind,
        "plane": "definition",
        "level": min(5, max(0, level)),
        "owner": owner,
        "label": label,
        "summary": summary,
        "expandable": expandable,
        "attributes": attributes,
        "evidence": evidence,
        "contributedBy": PLUGIN_ID,
    }
    if parent_id:
        value["parentId"] = parent_id
    return value


def _edge(
    *,
    kind: str,
    source: str,
    target: str,
    evidence: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "id": _edge_id(kind, source, target),
        "kind": kind,
        "plane": "definition",
        "source": source,
        "target": target,
        "evidence": evidence,
        "contributedBy": PLUGIN_ID,
    }


def _class_kind(name: str, bases: Iterable[str]) -> str:
    signals = " ".join([name, *bases]).lower()
    if name.endswith("Rail") or "agentrail" in signals:
        return "rail"
    if name.endswith("Agent") or "baseagent" in signals or "reactagent" in signals:
        return "agent"
    if "context" in signals:
        return "context"
    if name.endswith("Tool") or " tool" in f" {signals}":
        return "tool"
    if "workflow" in signals:
        return "workflow"
    if name.endswith("Model") or "modelclient" in signals:
        return "model"
    if "swarm" in signals or name.endswith("Team"):
        return "team"
    return "class"


def _module_name(file_path: Path, scan_root: Path) -> str:
    parts = list(file_path.relative_to(scan_root).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _import_candidates(tree: ast.AST, current_module: str, is_package: bool) -> set[str]:
    values: set[str] = set()
    current_parts = current_module.split(".") if current_module else []
    current_package = current_parts if is_package else current_parts[:-1]

    for item in ast.walk(tree):
        if isinstance(item, ast.Import):
            values.update(alias.name for alias in item.names)
            continue
        if not isinstance(item, ast.ImportFrom):
            continue

        if item.level:
            keep = max(0, len(current_package) - (item.level - 1))
            base_parts = current_package[:keep]
            if item.module:
                base_parts.extend(item.module.split("."))
            base = ".".join(base_parts)
        else:
            base = item.module or ""

        if base:
            values.add(base)
        for alias in item.names:
            if alias.name == "*":
                continue
            candidate = ".".join(part for part in (base, alias.name) if part)
            if candidate:
                values.add(candidate)
    return values


def _class_definitions(body: list[ast.stmt], prefix: str = "") -> Iterable[tuple[str, ast.ClassDef]]:
    for item in body:
        if not isinstance(item, ast.ClassDef):
            continue
        qualified_name = f"{prefix}.{item.name}" if prefix else item.name
        yield qualified_name, item
        yield from _class_definitions(item.body, qualified_name)


class PythonRepositoryScanner:
    """Build a hierarchy and relationship graph using Python's AST only."""

    def manifest(
        self,
        identity: RepositoryIdentity,
        options: ScanOptions = ScanOptions(),
        *,
        max_hashed_bytes: int = DEFAULT_MAX_MANIFEST_BYTES,
    ) -> ScanManifest:
        """Fingerprint the exact bounded Python input set without parsing an AST."""
        if not 1_000_000 <= max_hashed_bytes <= 512_000_000:
            raise ValueError("max_hashed_bytes must be between 1000000 and 512000000.")

        manifest_warnings: list[str] = []
        files, truncated = self._python_files(identity.scan_root, options, manifest_warnings)
        digest = hashlib.sha256()
        digest.update(SCAN_MANIFEST_VERSION.encode("ascii"))
        digest.update(str(identity.root).casefold().encode("utf-8"))
        digest.update(str(identity.scan_root).casefold().encode("utf-8"))
        digest.update(identity.revision.encode("ascii", errors="replace"))
        digest.update(identity.branch.encode("utf-8"))
        digest.update(b"1" if identity.dirty else b"0")
        digest.update(repr(options).encode("utf-8"))
        bytes_hashed = 0

        for file_path in files:
            try:
                source_path = _source_path(file_path, identity.root)
                stat = file_path.stat()
                digest.update(source_path.encode("utf-8"))
                digest.update(
                    f"\0{stat.st_size}\0{stat.st_mtime_ns}\0{stat.st_ctime_ns}\0".encode(
                        "ascii"
                    )
                )
                if bytes_hashed + stat.st_size > max_hashed_bytes:
                    return ScanManifest(
                        fingerprint=digest.hexdigest(),
                        python_files=len(files),
                        bytes_hashed=bytes_hashed,
                        truncated=truncated,
                        cacheable=False,
                        bypass_reason="manifest-byte-limit",
                    )
                with file_path.open("rb") as source_file:
                    while chunk := source_file.read(64 * 1024):
                        digest.update(chunk)
                        bytes_hashed += len(chunk)
            except OSError:
                return ScanManifest(
                    fingerprint=digest.hexdigest(),
                    python_files=len(files),
                    bytes_hashed=bytes_hashed,
                    truncated=truncated,
                    cacheable=False,
                    bypass_reason="manifest-read-race",
                )

        for warning in manifest_warnings:
            digest.update(b"\0warning\0")
            digest.update(warning.encode("utf-8"))
        return ScanManifest(
            fingerprint=digest.hexdigest(),
            python_files=len(files),
            bytes_hashed=bytes_hashed,
            truncated=truncated,
            cacheable=True,
        )

    def scan(
        self,
        identity: RepositoryIdentity,
        options: ScanOptions = ScanOptions(),
    ) -> dict[str, object]:
        started = time.monotonic()
        nodes: list[dict[str, object]] = []
        edges: list[dict[str, object]] = []
        edge_ids: set[str] = set()
        warnings: list[str] = []
        module_records: list[_ModuleRecord] = []
        class_ids_by_name: dict[str, list[str]] = defaultdict(list)
        class_bases: list[tuple[str, list[str], list[dict[str, object]]]] = []
        package_ids: dict[Path, str] = {}
        symbol_count = 0

        root_id = _stable_id(identity, ".")
        nodes.append(
            _node(
                node_id=root_id,
                kind="repository",
                level=0,
                owner=identity.owner,
                label=identity.name,
                summary=f"Git repository on {identity.branch} at {identity.revision[:12]}.",
                parent_id=None,
                expandable=True,
                attributes={
                    "branch": identity.branch,
                    "dirty": identity.dirty,
                    "scanScope": str(identity.scan_root),
                    "language": "python",
                },
                evidence=_evidence(identity, "."),
            )
        )

        files, truncated = self._python_files(identity.scan_root, options, warnings)
        for file_path in files:
            source_path = _source_path(file_path, identity.root)
            try:
                with tokenize.open(file_path) as source_file:
                    source = source_file.read()
                with python_warnings.catch_warnings():
                    python_warnings.simplefilter("ignore", SyntaxWarning)
                    tree = ast.parse(source, filename=source_path, type_comments=True)
            except (OSError, SyntaxError, UnicodeError) as exc:
                if len(warnings) < 100:
                    warnings.append(f"Skipped {source_path}: {type(exc).__name__}")
                continue

            parent_id, package_depth = self._ensure_packages(
                identity,
                file_path.parent,
                root_id,
                package_ids,
                nodes,
                edges,
                edge_ids,
                options,
                warnings,
            )
            module_id = _stable_id(identity, source_path)
            module_classes = list(_class_definitions(tree.body))
            module_functions = [
                item
                for item in tree.body
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            module_level = min(4, package_depth + 1)
            nodes.append(
                _node(
                    node_id=module_id,
                    kind="module",
                    level=module_level,
                    owner=identity.owner,
                    label=file_path.name,
                    summary=_summary(ast.get_docstring(tree), "Python module."),
                    parent_id=parent_id,
                    expandable=bool(module_classes or (options.include_functions and module_functions)),
                    attributes={
                        "language": "python",
                        "classCount": len(module_classes),
                        "functionCount": len(module_functions),
                    },
                    evidence=_evidence(identity, source_path, start_line=1),
                )
            )
            self._append_edge(
                edges,
                edge_ids,
                _edge(
                    kind="contains",
                    source=parent_id,
                    target=module_id,
                    evidence=_evidence(identity, source_path, start_line=1),
                ),
                options,
                warnings,
            )

            current_module = _module_name(file_path, identity.scan_root)
            module_records.append(
                _ModuleRecord(
                    node_id=module_id,
                    module_name=current_module,
                    source_path=source_path,
                    imports=_import_candidates(
                        tree,
                        current_module,
                        file_path.name == "__init__.py",
                    ),
                )
            )

            for qualified_name, class_node in module_classes:
                bases = [name for base in class_node.bases if (name := _dotted_name(base))]
                decorators = [
                    name
                    for decorator in class_node.decorator_list
                    if (name := _dotted_name(decorator))
                ]
                methods = [
                    item.name
                    for item in class_node.body
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                ]
                class_id = _stable_id(identity, source_path, qualified_name)
                class_evidence = _evidence(
                    identity,
                    source_path,
                    symbol=qualified_name,
                    start_line=class_node.lineno,
                    end_line=getattr(class_node, "end_lineno", class_node.lineno),
                )
                nodes.append(
                    _node(
                        node_id=class_id,
                        kind=_class_kind(class_node.name, bases),
                        level=min(5, module_level + 1),
                        owner=identity.owner,
                        label=class_node.name,
                        summary=_summary(ast.get_docstring(class_node), "Python class."),
                        parent_id=module_id,
                        expandable=bool(methods),
                        attributes={
                            "qualifiedName": qualified_name,
                            "bases": bases,
                            "decorators": decorators,
                            "methods": methods,
                        },
                        evidence=class_evidence,
                    )
                )
                self._append_edge(
                    edges,
                    edge_ids,
                    _edge(
                        kind="contains",
                        source=module_id,
                        target=class_id,
                        evidence=class_evidence,
                    ),
                    options,
                    warnings,
                )
                class_ids_by_name[class_node.name].append(class_id)
                class_bases.append((class_id, bases, class_evidence))
                symbol_count += 1

            if options.include_functions:
                for function_node in module_functions:
                    function_id = _stable_id(identity, source_path, function_node.name)
                    function_evidence = _evidence(
                        identity,
                        source_path,
                        symbol=function_node.name,
                        start_line=function_node.lineno,
                        end_line=getattr(function_node, "end_lineno", function_node.lineno),
                    )
                    decorators = [
                        name
                        for decorator in function_node.decorator_list
                        if (name := _dotted_name(decorator))
                    ]
                    nodes.append(
                        _node(
                            node_id=function_id,
                            kind="function",
                            level=min(5, module_level + 1),
                            owner=identity.owner,
                            label=function_node.name,
                            summary=_summary(ast.get_docstring(function_node), "Python function."),
                            parent_id=module_id,
                            expandable=False,
                            attributes={
                                "async": isinstance(function_node, ast.AsyncFunctionDef),
                                "decorators": decorators,
                                "parameterCount": len(function_node.args.args),
                            },
                            evidence=function_evidence,
                        )
                    )
                    self._append_edge(
                        edges,
                        edge_ids,
                        _edge(
                            kind="contains",
                            source=module_id,
                            target=function_id,
                            evidence=function_evidence,
                        ),
                        options,
                        warnings,
                    )
                    symbol_count += 1

        self._append_import_edges(identity, module_records, edges, edge_ids, options, warnings)
        self._append_inheritance_edges(
            class_ids_by_name,
            class_bases,
            edges,
            edge_ids,
            options,
            warnings,
        )

        duration_ms = round((time.monotonic() - started) * 1000)
        if truncated:
            warnings.append(f"File scan stopped at maxFiles={options.max_files}.")
        if len(warnings) >= 100:
            warnings.append("Additional scanner warnings were omitted.")
        return {
            "apiVersion": "1.0.0",
            "repository": identity.to_api_dict(),
            "graph": {
                "schemaVersion": GRAPH_SCHEMA_VERSION,
                "nodes": nodes,
                "edges": edges,
            },
            "statistics": {
                "pythonFiles": len(files),
                "symbols": symbol_count,
                "nodes": len(nodes),
                "edges": len(edges),
                "durationMs": duration_ms,
                "truncated": truncated or len(edges) >= options.max_edges,
            },
            "warnings": warnings,
        }

    def _python_files(
        self,
        scan_root: Path,
        options: ScanOptions,
        warnings: list[str],
    ) -> tuple[list[Path], bool]:
        files: list[Path] = []
        truncated = False
        for current_root, directory_names, file_names in os.walk(scan_root, followlinks=False):
            current_path = Path(current_root)
            directory_names[:] = sorted(
                name
                for name in directory_names
                if name not in _EXCLUDED_DIRECTORIES
                and (options.include_tests or name.lower() not in _TEST_DIRECTORIES)
                and not self._is_link_like(current_path / name)
            )
            for file_name in sorted(file_names):
                if not file_name.endswith(".py"):
                    continue
                if not options.include_tests and (
                    file_name.startswith("test_") or file_name.endswith("_test.py")
                ):
                    continue
                file_path = current_path / file_name
                if self._is_link_like(file_path):
                    continue
                try:
                    resolved_file = file_path.resolve(strict=True)
                    if not resolved_file.is_relative_to(scan_root):
                        if len(warnings) < 100:
                            warnings.append(f"Skipped path outside scan root: {file_path.name}")
                        continue
                    if resolved_file.stat().st_size > options.max_file_bytes:
                        if len(warnings) < 100:
                            warnings.append(f"Skipped oversized file: {file_path.name}")
                        continue
                except OSError:
                    continue
                files.append(file_path)
                if len(files) >= options.max_files:
                    truncated = True
                    return files, truncated
        return files, truncated

    @staticmethod
    def _is_link_like(path: Path) -> bool:
        is_junction = getattr(path, "is_junction", None)
        return path.is_symlink() or bool(is_junction and is_junction())

    def _ensure_packages(
        self,
        identity: RepositoryIdentity,
        directory: Path,
        root_id: str,
        package_ids: dict[Path, str],
        nodes: list[dict[str, object]],
        edges: list[dict[str, object]],
        edge_ids: set[str],
        options: ScanOptions,
        warnings: list[str],
    ) -> tuple[str, int]:
        relative_directory = directory.relative_to(identity.scan_root)
        if not relative_directory.parts:
            return root_id, 0

        parent_id = root_id
        current_path = identity.scan_root
        for depth, part in enumerate(relative_directory.parts, start=1):
            current_path /= part
            existing_id = package_ids.get(current_path)
            if existing_id:
                parent_id = existing_id
                continue
            source_path = _source_path(current_path, identity.root).rstrip("/") + "/"
            package_id = _stable_id(identity, source_path)
            package_ids[current_path] = package_id
            evidence = _evidence(identity, source_path)
            nodes.append(
                _node(
                    node_id=package_id,
                    kind="package",
                    level=min(3, depth),
                    owner=identity.owner,
                    label=part,
                    summary="Python package or source directory.",
                    parent_id=parent_id,
                    expandable=True,
                    attributes={"path": source_path},
                    evidence=evidence,
                )
            )
            self._append_edge(
                edges,
                edge_ids,
                _edge(
                    kind="contains",
                    source=parent_id,
                    target=package_id,
                    evidence=evidence,
                ),
                options,
                warnings,
            )
            parent_id = package_id
        return parent_id, len(relative_directory.parts)

    def _append_import_edges(
        self,
        identity: RepositoryIdentity,
        modules: list[_ModuleRecord],
        edges: list[dict[str, object]],
        edge_ids: set[str],
        options: ScanOptions,
        warnings: list[str],
    ) -> None:
        module_by_name = {
            module.module_name: module
            for module in modules
            if module.module_name
        }
        for module in modules:
            for imported_name in sorted(module.imports):
                target = module_by_name.get(imported_name)
                if not target or target.node_id == module.node_id:
                    continue
                self._append_edge(
                    edges,
                    edge_ids,
                    _edge(
                        kind="imports",
                        source=module.node_id,
                        target=target.node_id,
                        evidence=_evidence(identity, module.source_path),
                    ),
                    options,
                    warnings,
                )

    def _append_inheritance_edges(
        self,
        class_ids_by_name: dict[str, list[str]],
        class_bases: list[tuple[str, list[str], list[dict[str, object]]]],
        edges: list[dict[str, object]],
        edge_ids: set[str],
        options: ScanOptions,
        warnings: list[str],
    ) -> None:
        for class_id, bases, evidence in class_bases:
            for base in bases:
                candidates = class_ids_by_name.get(base.rsplit(".", 1)[-1], [])
                if len(candidates) != 1 or candidates[0] == class_id:
                    continue
                self._append_edge(
                    edges,
                    edge_ids,
                    _edge(
                        kind="inherits",
                        source=class_id,
                        target=candidates[0],
                        evidence=evidence,
                    ),
                    options,
                    warnings,
                )

    @staticmethod
    def _append_edge(
        edges: list[dict[str, object]],
        edge_ids: set[str],
        edge: dict[str, object],
        options: ScanOptions,
        warnings: list[str],
    ) -> None:
        edge_id = str(edge["id"])
        if edge_id in edge_ids:
            return
        if len(edges) >= options.max_edges:
            if not any(message.startswith("Edge scan stopped") for message in warnings):
                warnings.append(f"Edge scan stopped at maxEdges={options.max_edges}.")
            return
        edge_ids.add(edge_id)
        edges.append(edge)
