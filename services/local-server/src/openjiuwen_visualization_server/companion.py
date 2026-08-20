"""One-click Windows Companion launcher for the local visualization workbench."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass
from pathlib import Path

from .app import create_http_server
from .config import LocalServiceConfig


COMPANION_HOST = "127.0.0.1"
COMPANION_PORT = 8765
COMPANION_URL = f"http://{COMPANION_HOST}:{COMPANION_PORT}"
BUILD_TIMEOUT_SECONDS = 10 * 60


class CompanionLaunchError(RuntimeError):
    """Raised when the local Companion cannot be prepared or started."""


@dataclass(frozen=True, slots=True)
class CompanionPaths:
    project_root: Path
    workspace_root: Path
    static_root: Path

    @classmethod
    def discover(cls, project_root: str | Path | None = None) -> "CompanionPaths":
        resolved_project = (
            Path(project_root).resolve(strict=True)
            if project_root is not None
            else Path(__file__).resolve().parents[4]
        )
        if not (resolved_project / "package.json").is_file():
            raise CompanionLaunchError("无法定位 Visualization Web 项目目录。")
        workspace_root = resolved_project.parent.resolve(strict=True)
        return cls(
            project_root=resolved_project,
            workspace_root=workspace_root,
            static_root=resolved_project / "dist",
        )


def web_build_is_current(paths: CompanionPaths) -> bool:
    index = paths.static_root / "index.html"
    if not index.is_file():
        return False
    try:
        built_at = index.stat().st_mtime_ns
        inputs = [
            paths.project_root / "index.html",
            paths.project_root / "package.json",
            paths.project_root / "package-lock.json",
            paths.project_root / "vite.config.ts",
            paths.project_root / "tsconfig.json",
            paths.project_root / "tsconfig.app.json",
            paths.project_root / "tsconfig.node.json",
        ]
        inputs.extend(
            path
            for path in (paths.project_root / "src").rglob("*")
            if path.is_file()
        )
        return all(not path.exists() or path.stat().st_mtime_ns <= built_at for path in inputs)
    except OSError:
        return False


def ensure_web_build(paths: CompanionPaths) -> None:
    if web_build_is_current(paths):
        return
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise CompanionLaunchError(
            "网页资源尚未构建，且未找到 Node.js/npm。请先安装 Node.js 后再次双击启动。"
        )
    if not (paths.project_root / "node_modules").is_dir():
        _run_npm(paths.project_root, npm, ("ci",), "安装网页依赖")
    _run_npm(paths.project_root, npm, ("run", "build"), "构建网页资源")
    if not (paths.static_root / "index.html").is_file():
        raise CompanionLaunchError("网页构建已结束，但 dist/index.html 不存在。")


def _run_npm(
    project_root: Path,
    npm: str,
    arguments: tuple[str, ...],
    action: str,
) -> None:
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        completed = subprocess.run(
            [npm, *arguments],
            cwd=project_root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=BUILD_TIMEOUT_SECONDS,
            check=False,
            shell=False,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise CompanionLaunchError(f"{action}失败：{exc}") from exc
    if completed.returncode == 0:
        return
    detail = completed.stdout.strip()[-2_000:] or "npm 未返回诊断信息。"
    raise CompanionLaunchError(f"{action}失败。\n\n{detail}")


def companion_is_running(url: str = COMPANION_URL) -> bool:
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=1) as response:
            return response.headers.get("X-OpenJiuwen-Companion") == "1"
    except (OSError, urllib.error.URLError):
        return False


def build_companion_config(paths: CompanionPaths) -> LocalServiceConfig:
    return LocalServiceConfig.create(
        allowed_roots=[paths.workspace_root],
        allowed_origins=[
            COMPANION_URL,
            "http://localhost:8765",
            "http://127.0.0.1:4173",
            "http://localhost:4173",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        ],
        system_credentials_enabled=True,
    )


def run_companion(project_root: str | Path | None = None) -> None:
    paths = CompanionPaths.discover(project_root)
    if companion_is_running():
        webbrowser.open_new_tab(COMPANION_URL)
        return
    ensure_web_build(paths)
    config = build_companion_config(paths)
    try:
        server = create_http_server(
            config,
            host=COMPANION_HOST,
            port=COMPANION_PORT,
            static_root=paths.static_root,
        )
    except OSError as exc:
        raise CompanionLaunchError(
            "无法启动本地 Companion。127.0.0.1:8765 可能已被其他程序占用。"
        ) from exc
    webbrowser.open_new_tab(COMPANION_URL)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


def show_launch_error(message: str) -> None:
    try:
        import tkinter
        from tkinter import messagebox

        root = tkinter.Tk()
        root.withdraw()
        messagebox.showerror("OpenJiuwen Visualization", message, parent=root)
        root.destroy()
    except Exception:
        # pythonw has no console; this fallback still helps when the module is
        # invoked by a regular Python interpreter during development.
        print(message, file=sys.stderr)


def main(project_root: str | Path | None = None) -> int:
    try:
        run_companion(project_root)
    except (CompanionLaunchError, OSError, ValueError) as exc:
        show_launch_error(str(exc))
        return 1
    return 0
