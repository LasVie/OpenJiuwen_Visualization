"""Optional JiuwenSwarm Agent Team runtime backed by a fixed subprocess bridge."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol, TextIO

from .openrouter_provider import (
    DEFAULT_OUTPUT_TOKENS,
    MAX_INPUT_CHARACTERS,
    MAX_OUTPUT_TOKENS,
    MAX_SYSTEM_CHARACTERS,
    MIN_OUTPUT_TOKENS,
    OpenRouterProviderConfig,
)
from .trace_store import RuntimeTraceStore, TraceStoreError
from .runtime_source_identity import runtime_source_revisions


JIUWENSWARM_RUNTIME_API_VERSION = "1.0.0"
JIUWENSWARM_RUNTIME_ID = "jiuwenswarm-agent-team"
BRIDGE_RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
DEFAULT_MAX_ITERATIONS = 8
DEFAULT_PROBE_TTL_SECONDS = 300
PROBE_TIMEOUT_SECONDS = 120
MAX_ACTIVE_INVOCATIONS = 1
MAX_JOB_RECORDS = 64
MAX_BRIDGE_RECORD_BYTES = 2 * 1024 * 1024


class JiuwenSwarmRuntimeError(ValueError):
    """Stable error exposed by the local JiuwenSwarm adapter."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class JiuwenSwarmBridgeProbe:
    ready: bool
    code: str
    message: str
    framework_version: str | None = None


@dataclass(frozen=True, slots=True)
class JiuwenSwarmRuntimeConfig:
    """Server-only source locations and bounded team execution settings."""

    source_root: Path
    agent_core_root: Path
    python_executable: Path
    bridge_script: Path
    workspace: Path
    provider: OpenRouterProviderConfig
    max_iterations: int = DEFAULT_MAX_ITERATIONS

    @classmethod
    def from_environment(
        cls,
        provider: OpenRouterProviderConfig,
        environ: dict[str, str] | None = None,
    ) -> "JiuwenSwarmRuntimeConfig":
        values = os.environ if environ is None else environ
        web_root = Path(__file__).resolve().parents[4]
        workspace_root = web_root.parent
        source_root = Path(
            values.get("OPENJIUWEN_JIUWENSWARM_ROOT", str(workspace_root / "jiuwenswarm"))
        ).expanduser()
        agent_core_root = Path(
            values.get("OPENJIUWEN_AGENT_CORE_ROOT", str(workspace_root / "agent-core"))
        ).expanduser()
        python_executable = Path(
            values.get(
                "OPENJIUWEN_JIUWENSWARM_PYTHON",
                values.get("OPENJIUWEN_AGENT_CORE_PYTHON", sys.executable),
            )
        ).expanduser()
        runtime_workspace = Path(
            values.get(
                "OPENJIUWEN_JIUWENSWARM_WORKSPACE",
                str(web_root / ".jiuwenswarm-runtime"),
            )
        ).expanduser()
        raw_iterations = values.get("OPENJIUWEN_JIUWENSWARM_MAX_ITERATIONS", "")
        try:
            max_iterations = int(raw_iterations) if raw_iterations else DEFAULT_MAX_ITERATIONS
        except ValueError:
            max_iterations = DEFAULT_MAX_ITERATIONS
        max_iterations = min(20, max(2, max_iterations))
        return cls(
            source_root=source_root.resolve(strict=False),
            agent_core_root=agent_core_root.resolve(strict=False),
            python_executable=python_executable.resolve(strict=False),
            bridge_script=(
                web_root / "services" / "local-server" / "scripts" / "jiuwenswarm_bridge.py"
            ).resolve(strict=False),
            workspace=runtime_workspace.resolve(strict=False),
            provider=provider,
            max_iterations=max_iterations,
        )

    def static_probe(self) -> JiuwenSwarmBridgeProbe:
        if not self.python_executable.is_file():
            return JiuwenSwarmBridgeProbe(
                False,
                "python_unavailable",
                "OPENJIUWEN_JIUWENSWARM_PYTHON must point to an existing Python executable.",
            )
        if not self.bridge_script.is_file():
            return JiuwenSwarmBridgeProbe(
                False,
                "bridge_unavailable",
                "The fixed JiuwenSwarm bridge script is unavailable.",
            )
        swarm_source = self.source_root / "jiuwenswarm" / "agents" / "swarm" / "assembly.py"
        if not swarm_source.is_file():
            return JiuwenSwarmBridgeProbe(
                False,
                "jiuwenswarm_source_unavailable",
                "OPENJIUWEN_JIUWENSWARM_ROOT must point to a jiuwenswarm checkout.",
            )
        core_source = self.agent_core_root / "openjiuwen" / "agent_teams" / "schema" / "blueprint.py"
        if not core_source.is_file():
            return JiuwenSwarmBridgeProbe(
                False,
                "agent_core_source_unavailable",
                "OPENJIUWEN_AGENT_CORE_ROOT must point to an agent-core checkout.",
            )
        return JiuwenSwarmBridgeProbe(True, "ready", "JiuwenSwarm, Agent Core, and bridge sources are present.")


class BridgeProcess(Protocol):
    stdout: TextIO | None

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


class BridgeLauncher(Protocol):
    def probe(self, config: JiuwenSwarmRuntimeConfig) -> JiuwenSwarmBridgeProbe: ...

    def start(
        self,
        config: JiuwenSwarmRuntimeConfig,
        request: dict[str, Any],
    ) -> BridgeProcess: ...


class SubprocessJiuwenSwarmBridgeLauncher:
    """Launch only the repository-owned bridge; callers never provide commands."""

    @staticmethod
    def _environment(config: JiuwenSwarmRuntimeConfig) -> dict[str, str]:
        environment = dict(os.environ)
        previous_python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(
            value
            for value in (
                str(config.source_root),
                str(config.agent_core_root),
                previous_python_path,
            )
            if value
        )
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["OPENJIUWEN_VISUALIZATION_BRIDGE"] = "1"
        if config.provider.api_key:
            environment["OPENJIUWEN_OPENROUTER_API_KEY"] = config.provider.api_key
            environment.pop("OPENROUTER_API_KEY", None)
        else:
            environment.pop("OPENJIUWEN_OPENROUTER_API_KEY", None)
            environment.pop("OPENROUTER_API_KEY", None)
        return environment

    @staticmethod
    def _creation_flags() -> int:
        return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    def probe(self, config: JiuwenSwarmRuntimeConfig) -> JiuwenSwarmBridgeProbe:
        static = config.static_probe()
        if not static.ready:
            return static
        try:
            config.workspace.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(
                [str(config.python_executable), "-B", str(config.bridge_script), "--probe"],
                cwd=str(config.workspace),
                env=self._environment(config),
                input="",
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=PROBE_TIMEOUT_SECONDS,
                check=False,
                creationflags=self._creation_flags(),
            )
        except subprocess.TimeoutExpired:
            return JiuwenSwarmBridgeProbe(
                False,
                "bridge_probe_timeout",
                f"JiuwenSwarm import probe exceeded {PROBE_TIMEOUT_SECONDS} seconds.",
            )
        except (OSError, subprocess.SubprocessError):
            return JiuwenSwarmBridgeProbe(
                False,
                "bridge_probe_failed",
                "The JiuwenSwarm bridge process could not be started.",
            )
        for line in result.stdout.splitlines():
            record = _bridge_record(line)
            if not record or record.get("type") != "probe":
                continue
            ready = record.get("ready") is True
            return JiuwenSwarmBridgeProbe(
                ready,
                str(record.get("code") or ("ready" if ready else "dependency_unavailable"))[:120],
                str(record.get("message") or "JiuwenSwarm probe completed.")[:1_000],
                str(record["frameworkVersion"])[:120]
                if isinstance(record.get("frameworkVersion"), str)
                else None,
            )
        return JiuwenSwarmBridgeProbe(
            False,
            "bridge_probe_invalid",
            "The JiuwenSwarm bridge did not return a valid probe record.",
        )

    def start(
        self,
        config: JiuwenSwarmRuntimeConfig,
        request: dict[str, Any],
    ) -> BridgeProcess:
        config.workspace.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            [str(config.python_executable), "-B", str(config.bridge_script)],
            cwd=str(config.workspace),
            env=self._environment(config),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=self._creation_flags(),
        )
        if process.stdin is None:
            process.kill()
            raise OSError("JiuwenSwarm bridge stdin is unavailable.")
        process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
        process.stdin.close()
        return process


def _bridge_record(line: str) -> dict[str, Any] | None:
    if not line.startswith(BRIDGE_RECORD_PREFIX):
        return None
    encoded = line[len(BRIDGE_RECORD_PREFIX):]
    if len(encoded.encode("utf-8", errors="replace")) > MAX_BRIDGE_RECORD_BYTES:
        return None
    try:
        value = json.loads(encoded)
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _required_text(value: Any, name: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise JiuwenSwarmRuntimeError(
            "invalid_jiuwenswarm_request",
            f"{name} must be a non-empty string.",
            status=HTTPStatus.BAD_REQUEST,
        )
    if len(value) > maximum:
        raise JiuwenSwarmRuntimeError(
            "invalid_jiuwenswarm_request",
            f"{name} must contain at most {maximum} characters.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return value


def _optional_text(value: Any, name: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum:
        raise JiuwenSwarmRuntimeError(
            "invalid_jiuwenswarm_request",
            f"{name} must be a string of at most {maximum} characters.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return value or None


def _safe_runtime_segment(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_-")
    return normalized[:48] or secrets.token_hex(8)


@dataclass(slots=True)
class _JiuwenSwarmJob:
    id: str
    trace_id: str
    model_id: str
    team_name: str
    session_id: str
    started_at: float
    state: str = "accepted"
    event_number: int = 0
    cancel_event: threading.Event = field(default_factory=threading.Event)
    done_event: threading.Event = field(default_factory=threading.Event)
    process: BridgeProcess | None = None

    @property
    def team_subject_id(self) -> str:
        return f"team:{self.team_name}"


class JiuwenSwarmRuntimeAdapter:
    """Run a fixed JiuwenSwarm team profile and ingest normalized trace events."""

    def __init__(
        self,
        config: JiuwenSwarmRuntimeConfig,
        trace_store: RuntimeTraceStore,
        *,
        launcher: BridgeLauncher | None = None,
        clock: Callable[[], float] = time.monotonic,
        id_factory: Callable[[], str] | None = None,
        probe_ttl_seconds: float = DEFAULT_PROBE_TTL_SECONDS,
    ) -> None:
        self.config = config
        self._trace_store = trace_store
        self._launcher = launcher or SubprocessJiuwenSwarmBridgeLauncher()
        self._clock = clock
        self._id_factory = id_factory or (lambda: "sw_" + secrets.token_urlsafe(16))
        self._probe_ttl_seconds = max(0, probe_ttl_seconds)
        self._probe_value: JiuwenSwarmBridgeProbe | None = None
        self._probe_time = 0.0
        self._jobs: dict[str, _JiuwenSwarmJob] = {}
        self._lock = threading.RLock()

    @property
    def active_invocations(self) -> int:
        with self._lock:
            return sum(
                job.state in {"accepted", "running", "cancelling"}
                for job in self._jobs.values()
            )

    def _probe(self, *, force: bool = False) -> JiuwenSwarmBridgeProbe:
        now = self._clock()
        with self._lock:
            if (
                not force
                and self._probe_value is not None
                and now - self._probe_time <= self._probe_ttl_seconds
            ):
                return self._probe_value
        value = self._launcher.probe(self.config)
        with self._lock:
            self._probe_value = value
            self._probe_time = self._clock()
        return value

    def descriptor(self, *, refresh: bool = False) -> dict[str, object]:
        probe = self._probe(force=refresh)
        configured = probe.ready and self.config.provider.configured
        if configured:
            status = "ready"
            diagnostic = {"code": "ready", "message": "JiuwenSwarm Agent Team and OpenRouter are ready."}
        elif not probe.ready:
            status = "unavailable"
            diagnostic = {"code": probe.code, "message": probe.message}
        else:
            status = "unconfigured"
            diagnostic = {
                "code": "openrouter_unconfigured",
                "message": "Configure an OpenRouter API key in local settings.",
            }
        models = [
            {"id": model, "label": model, "default": model == self.config.provider.default_model}
            for model in self.config.provider.models
        ]
        return {
            "apiVersion": JIUWENSWARM_RUNTIME_API_VERSION,
            "runtime": {
                "id": JIUWENSWARM_RUNTIME_ID,
                "label": "JiuwenSwarm · Agent Team",
                "status": status,
                "configured": configured,
                "protocol": "openjiuwen.jiuwenswarm.bridge/1.0",
                "entrypoint": "jiuwenswarm.agents.swarm.enrich_team_spec_for_swarm",
                "executionIsolation": "fixed-subprocess",
                "credentialPolicy": "local-service-only",
                "providerId": "openrouter",
                "profile": "predefined-two-member",
                "teamMode": "predefined",
                "dispatchMode": "scheduled",
                "spawnMode": "inprocess",
                "swarmFlow": False,
                "streaming": True,
                "cancellation": True,
                "contextOwnership": "per-member",
                "tools": [
                    {"id": "create_task", "label": "Create assigned task", "policy": "team-only"},
                    {"id": "view_task", "label": "Read team task state", "policy": "team-only"},
                    {"id": "send_message", "label": "Send team message", "policy": "team-only"},
                    {"id": "member_complete_task", "label": "Complete assigned task", "policy": "self-only"},
                ],
                "models": models,
                "defaultModelId": self.config.provider.default_model,
                "limits": {
                    "maxInputCharacters": MAX_INPUT_CHARACTERS,
                    "maxSystemCharacters": MAX_SYSTEM_CHARACTERS,
                    "minOutputTokens": MIN_OUTPUT_TOKENS,
                    "maxOutputTokens": MAX_OUTPUT_TOKENS,
                    "defaultOutputTokens": DEFAULT_OUTPUT_TOKENS,
                    "maxIterations": self.config.max_iterations,
                    "maxActiveInvocations": MAX_ACTIVE_INVOCATIONS,
                },
                "diagnostic": diagnostic,
                **(
                    {"frameworkVersion": probe.framework_version}
                    if probe.framework_version
                    else {}
                ),
            },
        }

    def start(self, body: dict[str, Any], trace_token: str | None) -> dict[str, object]:
        unknown_fields = set(body) - {
            "traceId",
            "modelId",
            "input",
            "systemPrompt",
            "maxOutputTokens",
        }
        if unknown_fields:
            raise JiuwenSwarmRuntimeError(
                "invalid_jiuwenswarm_request",
                f"Unsupported JiuwenSwarm request field: {sorted(unknown_fields)[0]}",
                status=HTTPStatus.BAD_REQUEST,
            )
        probe = self._probe()
        if not probe.ready:
            raise JiuwenSwarmRuntimeError(probe.code, probe.message, status=HTTPStatus.SERVICE_UNAVAILABLE)
        if not self.config.provider.configured:
            raise JiuwenSwarmRuntimeError(
                "openrouter_unconfigured",
                "Configure an OpenRouter API key in local settings.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        trace_id = _required_text(body.get("traceId"), "traceId", maximum=240)
        try:
            trace = self._trace_store.authorize_writer(trace_id, trace_token, owner="jiuwenswarm")
        except TraceStoreError as exc:
            raise JiuwenSwarmRuntimeError(exc.code, str(exc), status=exc.status) from exc
        model_id = body.get("modelId", self.config.provider.default_model)
        if not isinstance(model_id, str) or model_id not in self.config.provider.models:
            raise JiuwenSwarmRuntimeError(
                "jiuwenswarm_model_not_allowed",
                "modelId must be one of the OpenRouter models registered by the local service.",
                status=HTTPStatus.BAD_REQUEST,
            )
        input_text = _required_text(body.get("input"), "input", maximum=MAX_INPUT_CHARACTERS)
        system_prompt = _optional_text(body.get("systemPrompt"), "systemPrompt", maximum=MAX_SYSTEM_CHARACTERS)
        max_output_tokens = body.get("maxOutputTokens", DEFAULT_OUTPUT_TOKENS)
        if (
            isinstance(max_output_tokens, bool)
            or not isinstance(max_output_tokens, int)
            or not MIN_OUTPUT_TOKENS <= max_output_tokens <= MAX_OUTPUT_TOKENS
        ):
            raise JiuwenSwarmRuntimeError(
                "invalid_jiuwenswarm_request",
                f"maxOutputTokens must be between {MIN_OUTPUT_TOKENS} and {MAX_OUTPUT_TOKENS}.",
                status=HTTPStatus.BAD_REQUEST,
            )

        with self._lock:
            self._prune_jobs_locked()
            active = sum(
                job.state in {"accepted", "running", "cancelling"}
                for job in self._jobs.values()
            )
            if active >= MAX_ACTIVE_INVOCATIONS:
                raise JiuwenSwarmRuntimeError(
                    "jiuwenswarm_capacity_reached",
                    "The local JiuwenSwarm invocation limit has been reached.",
                    status=HTTPStatus.TOO_MANY_REQUESTS,
                )
            if any(
                job.trace_id == trace_id and job.state in {"accepted", "running", "cancelling"}
                for job in self._jobs.values()
            ):
                raise JiuwenSwarmRuntimeError(
                    "jiuwenswarm_trace_busy",
                    "This trace already has an active JiuwenSwarm invocation.",
                    status=HTTPStatus.CONFLICT,
                )
            invocation_id = self._id_factory()
            while invocation_id in self._jobs:
                invocation_id = self._id_factory()
            segment = _safe_runtime_segment(invocation_id)
            team_name = f"visualization_{segment}"
            session_id = f"session_{segment}"
            job = _JiuwenSwarmJob(
                invocation_id,
                trace_id,
                model_id,
                team_name,
                session_id,
                self._clock(),
            )
            self._jobs[invocation_id] = job

        request = {
            "invocationId": invocation_id,
            "teamName": team_name,
            "sessionId": session_id,
            "modelId": model_id,
            "input": input_text,
            "systemPrompt": system_prompt,
            "maxOutputTokens": max_output_tokens,
            "maxIterations": self.config.max_iterations,
            "traceMaxTokens": int(trace["maxTokens"]),
            "workspace": str(self.config.workspace / segment),
            "sourceRevisions": runtime_source_revisions(
                (
                    ("agent-core", self.config.agent_core_root),
                    ("jiuwenswarm", self.config.source_root),
                )
            ),
        }
        worker = threading.Thread(
            target=self._run_job,
            args=(job, trace_token, request),
            name=f"jiuwenswarm-{invocation_id}",
            daemon=True,
        )
        worker.start()
        return {
            "apiVersion": JIUWENSWARM_RUNTIME_API_VERSION,
            "invocation": {
                "id": invocation_id,
                "traceId": trace_id,
                "runtimeId": JIUWENSWARM_RUNTIME_ID,
                "providerId": "openrouter",
                "modelId": model_id,
                "teamName": team_name,
                "sessionId": session_id,
                "status": "accepted",
                "cancellationEndpoint": f"/api/v1/jiuwenswarm/invocations/{invocation_id}/cancel",
            },
        }

    def cancel(self, invocation_id: str, trace_token: str | None) -> dict[str, object]:
        with self._lock:
            job = self._jobs.get(invocation_id)
            if job is None:
                raise JiuwenSwarmRuntimeError(
                    "jiuwenswarm_invocation_not_found",
                    "JiuwenSwarm invocation was not found.",
                    status=HTTPStatus.NOT_FOUND,
                )
            try:
                self._trace_store.authorize_writer(job.trace_id, trace_token, owner="jiuwenswarm")
            except TraceStoreError as exc:
                raise JiuwenSwarmRuntimeError(exc.code, str(exc), status=exc.status) from exc
            if job.state not in {"accepted", "running", "cancelling"}:
                raise JiuwenSwarmRuntimeError(
                    "jiuwenswarm_invocation_finished",
                    "JiuwenSwarm invocation has already finished.",
                    status=HTTPStatus.CONFLICT,
                )
            job.state = "cancelling"
            job.cancel_event.set()
            process = job.process
        if process is not None:
            self._terminate_process(process)
        return {
            "apiVersion": JIUWENSWARM_RUNTIME_API_VERSION,
            "invocation": {
                "id": job.id,
                "traceId": job.trace_id,
                "runtimeId": JIUWENSWARM_RUNTIME_ID,
                "providerId": "openrouter",
                "modelId": job.model_id,
                "teamName": job.team_name,
                "sessionId": job.session_id,
                "status": "cancelling",
            },
        }

    def wait_for_terminal(self, invocation_id: str, timeout_seconds: float = 2) -> bool:
        with self._lock:
            job = self._jobs.get(invocation_id)
        return bool(job and job.done_event.wait(timeout_seconds))

    def _run_job(
        self,
        job: _JiuwenSwarmJob,
        trace_token: str | None,
        request: dict[str, Any],
    ) -> None:
        terminal_phase: str | None = None
        try:
            process = self._launcher.start(self.config, request)
            with self._lock:
                job.process = process
                if job.state == "accepted":
                    job.state = "running"
            if job.cancel_event.is_set():
                self._terminate_process(process)
            stdout: Iterable[str] = process.stdout if process.stdout is not None else ()
            for line in stdout:
                if job.cancel_event.is_set():
                    continue
                record = _bridge_record(line)
                if not record or record.get("type") != "event":
                    continue
                event = record.get("event")
                if not isinstance(event, dict):
                    continue
                self._trace_store.append(job.trace_id, trace_token, [event])
                if event.get("kind") == "trace.status" and event.get("phase") in {"end", "error"}:
                    terminal_phase = str(event["phase"])
            exit_code = process.wait()
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token)
            elif terminal_phase is not None:
                with self._lock:
                    job.state = "completed" if terminal_phase == "end" else "failed"
            elif exit_code == 0:
                self._append_terminal(job, trace_token, "end", "JiuwenSwarm trace complete")
                with self._lock:
                    job.state = "completed"
            else:
                self._complete_failed(job, trace_token, "jiuwenswarm_bridge_failed")
        except Exception:
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token)
            else:
                self._complete_failed(job, trace_token, "jiuwenswarm_runtime_failed")
        finally:
            with self._lock:
                process = job.process
                job.process = None
            if process is not None and process.poll() is None:
                self._terminate_process(process)
            job.done_event.set()

    def _complete_cancelled(self, job: _JiuwenSwarmJob, trace_token: str | None) -> None:
        events = [
            self._event(
                job,
                "swarm.team",
                "end",
                title="JiuwenSwarm team cancelled",
                summary="固定团队桥接进程已终止；已接收的成员、任务、消息与 Context 事件保留。",
                subject={
                    "id": job.team_subject_id,
                    "kind": "team",
                    "label": "Visualization Agent Team",
                },
                payload={"status": "cancelled", "teamId": job.team_name},
            ),
            self._event(
                job,
                "trace.status",
                "end",
                title="JiuwenSwarm trace cancelled",
                summary="取消前已接收的结构化证据已保留。",
            ),
        ]
        try:
            self._trace_store.append(job.trace_id, trace_token, events)
        except TraceStoreError as exc:
            if exc.code != "trace_closed":
                raise
        with self._lock:
            job.state = "cancelled"

    def _complete_failed(
        self,
        job: _JiuwenSwarmJob,
        trace_token: str | None,
        code: str,
    ) -> None:
        try:
            self._trace_store.append(
                job.trace_id,
                trace_token,
                [
                    self._event(
                        job,
                        "swarm.team",
                        "error",
                        title="JiuwenSwarm Agent Team failed",
                        summary="隔离运行时失败；输入、凭据与桥接日志不会写入错误元数据。",
                        subject={
                            "id": job.team_subject_id,
                            "kind": "team",
                            "label": "Visualization Agent Team",
                        },
                        details=[{"label": "error", "value": code}],
                        payload={"status": "failed", "teamId": job.team_name},
                    ),
                    self._event(
                        job,
                        "trace.status",
                        "error",
                        title="JiuwenSwarm trace failed",
                        summary=f"JiuwenSwarm adapter stopped with {code}.",
                    ),
                ],
            )
        except TraceStoreError as exc:
            if exc.code != "trace_closed":
                raise
        with self._lock:
            job.state = "failed"

    def _append_terminal(
        self,
        job: _JiuwenSwarmJob,
        trace_token: str | None,
        phase: str,
        title: str,
    ) -> None:
        self._trace_store.append(
            job.trace_id,
            trace_token,
            [self._event(job, "trace.status", phase, title=title)],
        )

    def _event(self, job: _JiuwenSwarmJob, kind: str, phase: str, **values: Any) -> dict[str, Any]:
        job.event_number += 1
        return {
            "eventId": f"{job.id}:adapter:{job.event_number}",
            "kind": kind,
            "phase": phase,
            "timestampMs": max(0, round((self._clock() - job.started_at) * 1_000)),
            "spanId": f"{job.id}:adapter",
            **values,
        }

    @staticmethod
    def _terminate_process(process: BridgeProcess) -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
            except OSError:
                pass

    def _prune_jobs_locked(self) -> None:
        if len(self._jobs) < MAX_JOB_RECORDS:
            return
        terminal = sorted(
            (
                job
                for job in self._jobs.values()
                if job.state not in {"accepted", "running", "cancelling"}
            ),
            key=lambda job: job.started_at,
        )
        for job in terminal[: max(1, len(self._jobs) - MAX_JOB_RECORDS + 1)]:
            self._jobs.pop(job.id, None)
