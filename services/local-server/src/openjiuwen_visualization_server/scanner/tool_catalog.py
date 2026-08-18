"""Static Tool declaration and registration indexing without importing target code."""

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
from typing import Any, Iterable

from ..repository import RepositoryIdentity


TOOL_CATALOG_SCHEMA_VERSION = "1.0.0"

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
class ToolCatalogOptions:
    include_tests: bool = False
    max_files: int = 5_000
    max_file_bytes: int = 1_000_000
    max_tools: int = 5_000
    max_registration_sites: int = 10_000

    def __post_init__(self) -> None:
        if not 1 <= self.max_files <= 20_000:
            raise ValueError("max_files must be between 1 and 20000.")
        if not 1_024 <= self.max_file_bytes <= 10_000_000:
            raise ValueError("max_file_bytes must be between 1024 and 10000000.")
        if not 1 <= self.max_tools <= 20_000:
            raise ValueError("max_tools must be between 1 and 20000.")
        if not 1 <= self.max_registration_sites <= 50_000:
            raise ValueError("max_registration_sites must be between 1 and 50000.")


def _dotted_name(node: ast.AST | None) -> str:
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


def _terminal_name(node: ast.AST | None) -> str:
    dotted = _dotted_name(node)
    return dotted.rsplit(".", 1)[-1] if dotted else ""


def _literal(node: ast.AST | None) -> Any:
    if node is None:
        return None
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return None
    if isinstance(value, (str, bool, int, float)) or value is None:
        return value
    return None


def _keyword(call: ast.Call | None, name: str) -> ast.AST | None:
    if call is None:
        return None
    return next((item.value for item in call.keywords if item.arg == name), None)


def _expression(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        value = ast.unparse(node)
    except (ValueError, TypeError, AttributeError):
        value = _dotted_name(node)
    return " ".join(value.split())[:240]


def _summary(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    first_line = " ".join(value.strip().splitlines()[0].split())
    return first_line[:240] or fallback


def _stable_id(prefix: str, *parts: object) -> str:
    digest = hashlib.sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()[:20]
    return f"{prefix}:{digest}"


def _source_path(path: Path, repository_root: Path) -> str:
    return path.relative_to(repository_root).as_posix()


def _source(source_path: str, symbol: str, node: ast.AST) -> dict[str, object]:
    return {
        "path": source_path,
        "symbol": symbol,
        "startLine": int(getattr(node, "lineno", 1)),
        "endLine": int(getattr(node, "end_lineno", getattr(node, "lineno", 1))),
    }


def _bool_keyword(call: ast.Call | None, name: str) -> bool | None:
    value = _literal(_keyword(call, name))
    return value if isinstance(value, bool) else None


def _exposure(call: ast.Call | None) -> str:
    value = _keyword(call, "exposure")
    literal = _literal(value)
    if isinstance(literal, str):
        normalized = literal.lower().replace("_", "-")
        if normalized in {"direct", "deferred"}:
            return normalized
    terminal = _terminal_name(value).lower()
    if terminal in {"direct", "deferred"}:
        return terminal
    return "unknown"


def _function_parameters(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    positional = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    names = [item.arg for item in positional if item.arg not in {"self", "cls"}]
    if node.args.vararg:
        names.append(f"*{node.args.vararg.arg}")
    if node.args.kwarg:
        names.append(f"**{node.args.kwarg.arg}")
    return names


def _schema_parameters(call: ast.Call | None) -> list[str]:
    value = _keyword(call, "input_params")
    if not isinstance(value, ast.Dict):
        return []
    for key, item in zip(value.keys, value.values):
        if _literal(key) != "properties" or not isinstance(item, ast.Dict):
            continue
        return [
            name
            for key_node in item.keys
            if isinstance((name := _literal(key_node)), str)
        ]
    return []


def _card_metadata(
    call: ast.Call | None,
    *,
    fallback_description: str,
    parameters: Iterable[str] = (),
) -> dict[str, object]:
    description = _literal(_keyword(call, "description"))
    return {
        "description": description if isinstance(description, str) else fallback_description,
        "exposure": _exposure(call),
        "stateless": _bool_keyword(call, "stateless"),
        "parallelSafe": _bool_keyword(call, "parallel_safe"),
        "idempotent": _bool_keyword(call, "idempotent"),
        "parameters": list(dict.fromkeys([*parameters, *_schema_parameters(call)])),
    }


def _tool_decorator(node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.Call | None | bool:
    for decorator in node.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if _terminal_name(target) == "tool":
            return decorator if isinstance(decorator, ast.Call) else True
    return None


def _tool_card_calls(node: ast.AST) -> list[ast.Call]:
    return [
        item
        for item in ast.walk(node)
        if isinstance(item, ast.Call) and _terminal_name(item.func) == "ToolCard"
    ]


def _class_is_tool(node: ast.ClassDef) -> bool:
    if node.name.endswith("Tool"):
        return True
    return any(
        _terminal_name(base) in {"Tool", "BaseTool", "LocalFunction"}
        for base in node.bases
    )


def _assignment_name(node: ast.Assign | ast.AnnAssign) -> str:
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    names = [
        target.id if isinstance(target, ast.Name) else target.attr
        for target in targets
        if isinstance(target, (ast.Name, ast.Attribute))
    ]
    return names[0] if len(names) == 1 else ""


def _assignment_value(node: ast.Assign | ast.AnnAssign) -> ast.AST | None:
    return node.value


def _candidate_names(node: ast.AST | None) -> set[str]:
    if node is None:
        return set()
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Attribute):
        if node.attr == "card":
            return _candidate_names(node.value)
        dotted = _dotted_name(node)
        return {dotted.rsplit(".", 1)[-1]} if dotted else set()
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return set().union(*(_candidate_names(item) for item in node.elts)) if node.elts else set()
    if isinstance(node, ast.Call):
        terminal = _terminal_name(node.func)
        return {terminal} if terminal else set()
    return set()


def _registration_mechanism(callee: str) -> str | None:
    if callee.endswith("ability_manager.add_ability"):
        return "ability-resource"
    if callee.endswith("ability_manager.add"):
        return "ability-card"
    if callee.endswith("resource_mgr.add_tool"):
        return "resource-manager"
    if callee == "register_tool" or callee.endswith(".register_tool"):
        return "ownership-helper"
    return None


def _registration_target(call: ast.Call, mechanism: str) -> ast.AST | None:
    if call.args:
        return call.args[1] if mechanism == "ability-resource" and len(call.args) > 1 else call.args[0]
    keyword_order = {
        "ability-resource": ("resource", "tool", "card"),
        "ability-card": ("ability", "card", "tool"),
        "resource-manager": ("tool", "tools"),
        "ownership-helper": ("tool",),
    }
    for name in keyword_order[mechanism]:
        value = _keyword(call, name)
        if value is not None:
            return value
    return None


class ToolCatalogScanner:
    """Index Tool declarations and registration paths using Python AST only."""

    def scan(
        self,
        identity: RepositoryIdentity,
        options: ToolCatalogOptions = ToolCatalogOptions(),
    ) -> dict[str, object]:
        started = time.monotonic()
        warnings: list[str] = []
        definitions: list[dict[str, object]] = []
        registration_sites: list[dict[str, object]] = []
        files, file_truncated = self._python_files(identity.scan_root, options, warnings)
        tool_truncated = False
        registration_truncated = False

        for file_path in files:
            if len(definitions) >= options.max_tools:
                tool_truncated = True
                break
            source_path = _source_path(file_path, identity.root)
            try:
                with tokenize.open(file_path) as source_file:
                    source_text = source_file.read()
                if not any(
                    marker in source_text
                    for marker in (
                        "Tool",
                        "@tool",
                        ".tool",
                        "ability_manager",
                        "resource_mgr.add_tool",
                        "register_tool",
                    )
                ):
                    continue
                with python_warnings.catch_warnings():
                    python_warnings.simplefilter("ignore", SyntaxWarning)
                    tree = ast.parse(source_text, filename=source_path, type_comments=True)
            except (OSError, SyntaxError, UnicodeError) as exc:
                if len(warnings) < 100:
                    warnings.append(f"Skipped {source_path}: {type(exc).__name__}")
                continue

            file_definitions, symbols = self._definitions_for_file(identity, source_path, tree)
            remaining = options.max_tools - len(definitions)
            if len(file_definitions) > remaining:
                file_definitions = file_definitions[:remaining]
                tool_truncated = True
            definitions.extend(file_definitions)

            if len(registration_sites) >= options.max_registration_sites:
                registration_truncated = True
                continue
            file_sites = self._registrations_for_file(
                identity,
                source_path,
                tree,
                symbols,
                file_definitions,
            )
            remaining_sites = options.max_registration_sites - len(registration_sites)
            if len(file_sites) > remaining_sites:
                file_sites = file_sites[:remaining_sites]
                registration_truncated = True
            registration_sites.extend(file_sites)

        self._resolve_global_registrations(definitions, registration_sites)
        sites_by_tool: dict[str, list[str]] = defaultdict(list)
        for site in registration_sites:
            for tool_id in site["resolvedToolIds"]:
                sites_by_tool[str(tool_id)].append(str(site["id"]))
        for definition in definitions:
            definition["registrationSiteIds"] = sites_by_tool.get(str(definition["id"]), [])

        linked = sum(1 for site in registration_sites if site["resolvedToolIds"])
        truncated = file_truncated or tool_truncated or registration_truncated
        if file_truncated:
            warnings.append(f"File scan stopped at maxFiles={options.max_files}.")
        if tool_truncated:
            warnings.append(f"Tool scan stopped at maxTools={options.max_tools}.")
        if registration_truncated:
            warnings.append(
                f"Registration scan stopped at maxRegistrationSites={options.max_registration_sites}."
            )
        if len(warnings) >= 100:
            warnings.append("Additional scanner warnings were omitted.")

        return {
            "apiVersion": "1.0.0",
            "schemaVersion": TOOL_CATALOG_SCHEMA_VERSION,
            "repository": identity.to_api_dict(),
            "tools": definitions,
            "registrationSites": registration_sites,
            "statistics": {
                "pythonFiles": len(files),
                "tools": len(definitions),
                "registrationSites": len(registration_sites),
                "linkedRegistrations": linked,
                "dynamicRegistrations": len(registration_sites) - linked,
                "durationMs": round((time.monotonic() - started) * 1000),
                "truncated": truncated,
            },
            "warnings": warnings,
            "writeOperations": False,
        }

    def _definitions_for_file(
        self,
        identity: RepositoryIdentity,
        source_path: str,
        tree: ast.Module,
    ) -> tuple[list[dict[str, object]], dict[str, list[str]]]:
        definitions: list[dict[str, object]] = []
        symbol_ids: dict[str, list[str]] = defaultdict(list)

        def append_definition(
            *,
            name: str,
            symbol: str,
            kind: str,
            node: ast.AST,
            summary: str,
            card: dict[str, object],
            name_source: str,
        ) -> None:
            tool_id = _stable_id("tool", identity.id, source_path, symbol, name)
            definitions.append(
                {
                    "id": tool_id,
                    "name": name,
                    "symbol": symbol,
                    "kind": kind,
                    "owner": identity.owner,
                    "summary": summary,
                    "source": _source(source_path, symbol, node),
                    "card": {**card, "nameSource": name_source},
                    "registrationSiteIds": [],
                }
            )
            symbol_ids[symbol.rsplit(".", 1)[-1]].append(tool_id)
            symbol_ids[name].append(tool_id)

        def visit_body(body: list[ast.stmt], prefix: str = "") -> None:
            for item in body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    decorator = _tool_decorator(item)
                    if decorator is None:
                        continue
                    call = decorator if isinstance(decorator, ast.Call) else None
                    explicit_name = _literal(_keyword(call, "name"))
                    name = explicit_name if isinstance(explicit_name, str) and explicit_name else item.name
                    symbol = f"{prefix}.{item.name}" if prefix else item.name
                    fallback = _summary(ast.get_docstring(item), f"Tool function {item.name}.")
                    append_definition(
                        name=name,
                        symbol=symbol,
                        kind="decorated-function",
                        node=item,
                        summary=fallback,
                        card=_card_metadata(
                            call,
                            fallback_description=fallback,
                            parameters=_function_parameters(item),
                        ),
                        name_source="literal" if isinstance(explicit_name, str) else "symbol",
                    )
                    continue

                if isinstance(item, ast.ClassDef):
                    card_calls = _tool_card_calls(item)
                    if _class_is_tool(item):
                        call = card_calls[0] if card_calls else None
                        explicit_name = _literal(_keyword(call, "name"))
                        name = explicit_name if isinstance(explicit_name, str) and explicit_name else item.name
                        symbol = f"{prefix}.{item.name}" if prefix else item.name
                        fallback = _summary(ast.get_docstring(item), f"Tool class {item.name}.")
                        append_definition(
                            name=name,
                            symbol=symbol,
                            kind="tool-class",
                            node=item,
                            summary=fallback,
                            card=_card_metadata(call, fallback_description=fallback),
                            name_source="literal" if isinstance(explicit_name, str) else "symbol",
                        )
                    visit_body(item.body, f"{prefix}.{item.name}" if prefix else item.name)
                    continue

                if not prefix and isinstance(item, (ast.Assign, ast.AnnAssign)):
                    value = _assignment_value(item)
                    if not isinstance(value, ast.Call) or _terminal_name(value.func) != "ToolCard":
                        continue
                    symbol = _assignment_name(item)
                    if not symbol:
                        continue
                    explicit_name = _literal(_keyword(value, "name"))
                    name = explicit_name if isinstance(explicit_name, str) and explicit_name else symbol
                    fallback = f"ToolCard declaration {symbol}."
                    append_definition(
                        name=name,
                        symbol=symbol,
                        kind="tool-card",
                        node=item,
                        summary=fallback,
                        card=_card_metadata(value, fallback_description=fallback),
                        name_source="literal" if isinstance(explicit_name, str) else "symbol",
                    )

        visit_body(tree.body)
        return definitions, symbol_ids

    def _registrations_for_file(
        self,
        identity: RepositoryIdentity,
        source_path: str,
        tree: ast.Module,
        symbols: dict[str, list[str]],
        file_definitions: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        aliases: dict[str, set[str]] = defaultdict(set)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for imported in node.names:
                    local_name = imported.asname or imported.name.rsplit(".", 1)[-1]
                    aliases[local_name].add(imported.name.rsplit(".", 1)[-1])
                continue
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            name = _assignment_name(node)
            if name:
                aliases[name].update(_candidate_names(_assignment_value(node)))

        definition_ids = {str(item["id"]) for item in file_definitions}
        sites: list[dict[str, object]] = []
        parent: dict[ast.AST, ast.AST] = {}
        for parent_node in ast.walk(tree):
            for child in ast.iter_child_nodes(parent_node):
                parent[child] = parent_node

        for call in (item for item in ast.walk(tree) if isinstance(item, ast.Call)):
            callee = _dotted_name(call.func)
            mechanism = _registration_mechanism(callee)
            if mechanism is None:
                continue
            target = _registration_target(call, mechanism)
            candidates = _candidate_names(target)
            direct_ids = {
                tool_id
                for candidate in candidates
                for tool_id in symbols.get(candidate, [])
                if tool_id in definition_ids
            }
            inferred_ids: set[str] = set()
            if not direct_ids:
                expanded = {
                    alias_candidate
                    for candidate in candidates
                    for alias_candidate in aliases.get(candidate, set())
                }
                inferred_ids = {
                    tool_id
                    for candidate in expanded
                    for tool_id in symbols.get(candidate, [])
                    if tool_id in definition_ids
                }
            else:
                expanded = set()
            resolved = sorted(direct_ids or inferred_ids)
            confidence = "exact" if direct_ids else "inferred" if inferred_ids else "dynamic"
            container = self._container_symbol(call, parent)
            site_id = _stable_id(
                "tool-registration",
                identity.id,
                source_path,
                getattr(call, "lineno", 1),
                callee,
                _expression(target),
            )
            sites.append(
                {
                    "id": site_id,
                    "mechanism": mechanism,
                    "callee": callee,
                    "container": container,
                    "targetExpression": _expression(target),
                    "candidateNames": sorted(candidates | expanded),
                    "resolvedToolIds": resolved,
                    "confidence": confidence,
                    "source": _source(source_path, container or callee, call),
                }
            )
        return sorted(sites, key=lambda item: (item["source"]["startLine"], item["id"]))

    @staticmethod
    def _resolve_global_registrations(
        definitions: list[dict[str, object]],
        registration_sites: list[dict[str, object]],
    ) -> None:
        ids_by_name: dict[str, set[str]] = defaultdict(set)
        for definition in definitions:
            tool_id = str(definition["id"])
            ids_by_name[str(definition["name"])].add(tool_id)
            ids_by_name[str(definition["symbol"]).rsplit(".", 1)[-1]].add(tool_id)
        for site in registration_sites:
            if site["resolvedToolIds"]:
                continue
            candidate_ids = {
                tool_id
                for candidate in site["candidateNames"]
                for tool_id in ids_by_name.get(str(candidate), set())
            }
            if len(candidate_ids) != 1:
                continue
            site["resolvedToolIds"] = sorted(candidate_ids)
            site["confidence"] = "inferred"

    @staticmethod
    def _container_symbol(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> str:
        names: list[str] = []
        current = parents.get(node)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(current.name)
            current = parents.get(current)
        return ".".join(reversed(names))

    def _python_files(
        self,
        scan_root: Path,
        options: ToolCatalogOptions,
        warnings: list[str],
    ) -> tuple[list[Path], bool]:
        files: list[Path] = []
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
                    resolved = file_path.resolve(strict=True)
                    if not resolved.is_relative_to(scan_root):
                        if len(warnings) < 100:
                            warnings.append(f"Skipped path outside scan root: {file_path.name}")
                        continue
                    if resolved.stat().st_size > options.max_file_bytes:
                        if len(warnings) < 100:
                            warnings.append(f"Skipped oversized file: {file_path.name}")
                        continue
                except OSError:
                    continue
                files.append(file_path)
                if len(files) >= options.max_files:
                    return files, True
        return files, False

    @staticmethod
    def _is_link_like(path: Path) -> bool:
        is_junction = getattr(path, "is_junction", None)
        return path.is_symlink() or bool(is_junction and is_junction())
