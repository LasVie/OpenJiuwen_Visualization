"""Optional, isolated Agent Core runtime backed by a fixed subprocess bridge."""

from __future__ import annotations

import json
import os
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


AGENT_CORE_RUNTIME_API_VERSION = "1.0.0"
AGENT_CORE_RUNTIME_ID = "agent-core-deep-agent"
BRIDGE_RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
DEFAULT_MAX_ITERATIONS = 6
DEFAULT_PROBE_TTL_SECONDS = 300
PROBE_TIMEOUT_SECONDS = 90
MAX_ACTIVE_INVOCATIONS = 2
MAX_JOB_RECORDS = 64
MAX_BRIDGE_RECORD_BYTES = 2 * 1024 * 1024


class AgentCoreRuntimeError(ValueError):
    """Stable error exposed by the local Agent Core adapter."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class AgentCoreBridgeProbe:
    ready: bool
    code: str
    message: str
    framework_version: str | None = None


@dataclass(frozen=True, slots=True)
class AgentCoreRuntimeConfig:
    """Server-only locations and bounded execution settings."""

    source_root: Path
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
    ) -> "AgentCoreRuntimeConfig":
        values = os.environ if environ is None else environ
        web_root = Path(__file__).resolve().parents[4]
        workspace_root = web_root.parent
        source_root = Path(
            values.get("OPENJIUWEN_AGENT_CORE_ROOT", str(workspace_root / "agent-core"))
        ).expanduser()
        python_executable = Path(
            values.get("OPENJIUWEN_AGENT_CORE_PYTHON", sys.executable)
        ).expanduser()
        runtime_workspace = Path(
            values.get(
                "OPENJIUWEN_AGENT_CORE_WORKSPACE",
                str(web_root / ".agent-core-runtime"),
            )
        ).expanduser()
        raw_iterations = values.get("OPENJIUWEN_AGENT_CORE_MAX_ITERATIONS", "")
        try:
            max_iterations = int(raw_iterations) if raw_iterations else DEFAULT_MAX_ITERATIONS
        except ValueError:
            max_iterations = DEFAULT_MAX_ITERATIONS
        max_iterations = min(20, max(2, max_iterations))
        return cls(
            source_root=source_root.resolve(strict=False),
            python_executable=python_executable.resolve(strict=False),
            bridge_script=(
                web_root / "services" / "local-server" / "scripts" / "agent_core_bridge.py"
            ).resolve(strict=False),
            workspace=runtime_workspace.resolve(strict=False),
            provider=provider,
            max_iterations=max_iterations,
        )

    def static_probe(self) -> AgentCoreBridgeProbe:
        if not self.python_executable.is_file():
            return AgentCoreBridgeProbe(
                False,
                "python_unavailable",
                "OPENJIUWEN_AGENT_CORE_PYTHON must point to an existing Python executable.",
            )
        if not self.bridge_script.is_file():
            return AgentCoreBridgeProbe(
                False,
                "bridge_unavailable",
                "The fixed Agent Core bridge script is unavailable.",
            )
        required_source = self.source_root / "openjiuwen" / "harness" / "deep_agent.py"
        if not required_source.is_file():
            return AgentCoreBridgeProbe(
                False,
                "agent_core_source_unavailable",
                "OPENJIUWEN_AGENT_CORE_ROOT must point to an agent-core checkout.",
            )
        return AgentCoreBridgeProbe(True, "ready", "Agent Core source and bridge are present.")


class BridgeProcess(Protocol):
    stdout: TextIO | None

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


class BridgeLauncher(Protocol):
    def probe(self, config: AgentCoreRuntimeConfig) -> AgentCoreBridgeProbe: ...

    def start(
        self,
        config: AgentCoreRuntimeConfig,
        request: dict[str, Any],
    ) -> BridgeProcess: ...


class SubprocessAgentCoreBridgeLauncher:
    """Launches only the repository-owned bridge script; no caller command is accepted."""

    @staticmethod
    def _environment(config: AgentCoreRuntimeConfig) -> dict[str, str]:
        environment = dict(os.environ)
        previous_python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(
            value for value in (str(config.source_root), previous_python_path) if value
        )
        environment["PYTHONUNBUFFERED"] = "1"
        environment["OPENJIUWEN_VISUALIZATION_BRIDGE"] = "1"
        return environment

    @staticmethod
    def _creation_flags() -> int:
        return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    def probe(self, config: AgentCoreRuntimeConfig) -> AgentCoreBridgeProbe:
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
            return AgentCoreBridgeProbe(
                False,
                "bridge_probe_timeout",
                f"Agent Core import probe exceeded {PROBE_TIMEOUT_SECONDS} seconds.",
            )
        except (OSError, subprocess.SubprocessError):
            return AgentCoreBridgeProbe(
                False,
                "bridge_probe_failed",
                "The Agent Core bridge process could not be started.",
            )
        for line in result.stdout.splitlines():
            record = _bridge_record(line)
            if not record or record.get("type") != "probe":
                continue
            ready = record.get("ready") is True
            return AgentCoreBridgeProbe(
                ready,
                str(record.get("code") or ("ready" if ready else "dependency_unavailable"))[:120],
                str(record.get("message") or "Agent Core probe completed.")[:1_000],
                str(record["frameworkVersion"])[:120]
                if isinstance(record.get("frameworkVersion"), str)
                else None,
            )
        return AgentCoreBridgeProbe(
            False,
            "bridge_probe_invalid",
            "The Agent Core bridge did not return a valid probe record.",
        )

    def start(
        self,
        config: AgentCoreRuntimeConfig,
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
            raise OSError("Agent Core bridge stdin is unavailable.")
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
        raise AgentCoreRuntimeError(
            "invalid_agent_core_request",
            f"{name} must be a non-empty string.",
            status=HTTPStatus.BAD_REQUEST,
        )
    if len(value) > maximum:
        raise AgentCoreRuntimeError(
            "invalid_agent_core_request",
            f"{name} must contain at most {maximum} characters.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return value


def _optional_text(value: Any, name: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum:
        raise AgentCoreRuntimeError(
            "invalid_agent_core_request",
            f"{name} must be a string of at most {maximum} characters.",
            status=HTTPStatus.BAD_REQUEST,
        )
    return value or None


@dataclass(slots=True)
class _AgentCoreJob:
    id: str
    trace_id: str
    model_id: str
    started_at: float
    state: str = "accepted"
    event_number: int = 0
    cancel_event: threading.Event = field(default_factory=threading.Event)
    done_event: threading.Event = field(default_factory=threading.Event)
    process: BridgeProcess | None = None


class AgentCoreRuntimeAdapter:
    """Runs trusted Agent Core source in an isolated process and ingests normalized events."""

    def __init__(
        self,
        config: AgentCoreRuntimeConfig,
        trace_store: RuntimeTraceStore,
        *,
        launcher: BridgeLauncher | None = None,
        clock: Callable[[], float] = time.monotonic,
        id_factory: Callable[[], str] | None = None,
        probe_ttl_seconds: float = DEFAULT_PROBE_TTL_SECONDS,
    ) -> None:
        self.config = config
        self._trace_store = trace_store
        self._launcher = launcher or SubprocessAgentCoreBridgeLauncher()
        self._clock = clock
        self._id_factory = id_factory or (lambda: "ac_" + secrets.token_urlsafe(16))
        self._probe_ttl_seconds = max(0, probe_ttl_seconds)
        self._probe_value: AgentCoreBridgeProbe | None = None
        self._probe_time = 0.0
        self._jobs: dict[str, _AgentCoreJob] = {}
        self._lock = threading.RLock()

    def _probe(self, *, force: bool = False) -> AgentCoreBridgeProbe:
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
            diagnostic = {"code": "ready", "message": "Agent Core and OpenRouter are ready."}
        elif not probe.ready:
            status = "unavailable"
            diagnostic = {"code": probe.code, "message": probe.message}
        else:
            status = "unconfigured"
            diagnostic = {
                "code": "openrouter_unconfigured",
                "message": "Set OPENJIUWEN_OPENROUTER_API_KEY or OPENROUTER_API_KEY.",
            }
        models = [
            {"id": model, "label": model, "default": model == self.config.provider.default_model}
            for model in self.config.provider.models
        ]
        return {
            "apiVersion": AGENT_CORE_RUNTIME_API_VERSION,
            "runtime": {
                "id": AGENT_CORE_RUNTIME_ID,
                "label": "Agent Core · DeepAgent",
                "status": status,
                "configured": configured,
                "protocol": "openjiuwen.agent-core.bridge/1.0",
                "entrypoint": "openjiuwen.harness.create_deep_agent",
                "executionIsolation": "fixed-subprocess",
                "credentialPolicy": "local-service-only",
                "providerId": "openrouter",
                "streaming": True,
                "cancellation": True,
                "reactLoop": True,
                "rails": True,
                "tools": [
                    {
                        "id": "inspect_input",
                        "label": "Inspect input",
                        "policy": "read-only-allowlist",
                    }
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
            raise AgentCoreRuntimeError(
                "invalid_agent_core_request",
                f"Unsupported Agent Core request field: {sorted(unknown_fields)[0]}",
                status=HTTPStatus.BAD_REQUEST,
            )
        probe = self._probe()
        if not probe.ready:
            raise AgentCoreRuntimeError(probe.code, probe.message, status=HTTPStatus.SERVICE_UNAVAILABLE)
        if not self.config.provider.configured:
            raise AgentCoreRuntimeError(
                "openrouter_unconfigured",
                "Set OPENJIUWEN_OPENROUTER_API_KEY or OPENROUTER_API_KEY in the local service environment.",
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
        trace_id = _required_text(body.get("traceId"), "traceId", maximum=240)
        try:
            trace = self._trace_store.authorize_writer(trace_id, trace_token, owner="agent-core")
        except TraceStoreError as exc:
            raise AgentCoreRuntimeError(exc.code, str(exc), status=exc.status) from exc
        model_id = body.get("modelId", self.config.provider.default_model)
        if not isinstance(model_id, str) or model_id not in self.config.provider.models:
            raise AgentCoreRuntimeError(
                "agent_core_model_not_allowed",
                "modelId must be one of the OpenRouter models registered by the local service.",
                status=HTTPStatus.BAD_REQUEST,
            )
        input_text = _required_text(body.get("input"), "input", maximum=MAX_INPUT_CHARACTERS)
        system_prompt = _optional_text(
            body.get("systemPrompt"),
            "systemPrompt",
            maximum=MAX_SYSTEM_CHARACTERS,
        )
        max_output_tokens = body.get("maxOutputTokens", DEFAULT_OUTPUT_TOKENS)
        if (
            isinstance(max_output_tokens, bool)
            or not isinstance(max_output_tokens, int)
            or not MIN_OUTPUT_TOKENS <= max_output_tokens <= MAX_OUTPUT_TOKENS
        ):
            raise AgentCoreRuntimeError(
                "invalid_agent_core_request",
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
                raise AgentCoreRuntimeError(
                    "agent_core_capacity_reached",
                    "The local Agent Core invocation limit has been reached.",
                    status=HTTPStatus.TOO_MANY_REQUESTS,
                )
            if any(
                job.trace_id == trace_id and job.state in {"accepted", "running", "cancelling"}
                for job in self._jobs.values()
            ):
                raise AgentCoreRuntimeError(
                    "agent_core_trace_busy",
                    "This trace already has an active Agent Core invocation.",
                    status=HTTPStatus.CONFLICT,
                )
            invocation_id = self._id_factory()
            while invocation_id in self._jobs:
                invocation_id = self._id_factory()
            job = _AgentCoreJob(invocation_id, trace_id, model_id, self._clock())
            self._jobs[invocation_id] = job

        request = {
            "invocationId": invocation_id,
            "modelId": model_id,
            "input": input_text,
            "systemPrompt": system_prompt,
            "maxOutputTokens": max_output_tokens,
            "maxIterations": self.config.max_iterations,
            "traceMaxTokens": int(trace["maxTokens"]),
            "workspace": str(self.config.workspace),
        }
        worker = threading.Thread(
            target=self._run_job,
            args=(job, trace_token, request),
            name=f"agent-core-{invocation_id}",
            daemon=True,
        )
        worker.start()
        return {
            "apiVersion": AGENT_CORE_RUNTIME_API_VERSION,
            "invocation": {
                "id": invocation_id,
                "traceId": trace_id,
                "runtimeId": AGENT_CORE_RUNTIME_ID,
                "providerId": "openrouter",
                "modelId": model_id,
                "status": "accepted",
                "cancellationEndpoint": f"/api/v1/agent-core/invocations/{invocation_id}/cancel",
            },
        }

    def cancel(self, invocation_id: str, trace_token: str | None) -> dict[str, object]:
        with self._lock:
            job = self._jobs.get(invocation_id)
            if job is None:
                raise AgentCoreRuntimeError(
                    "agent_core_invocation_not_found",
                    "Agent Core invocation was not found.",
                    status=HTTPStatus.NOT_FOUND,
                )
            try:
                self._trace_store.authorize_writer(job.trace_id, trace_token, owner="agent-core")
            except TraceStoreError as exc:
                raise AgentCoreRuntimeError(exc.code, str(exc), status=exc.status) from exc
            if job.state not in {"accepted", "running", "cancelling"}:
                raise AgentCoreRuntimeError(
                    "agent_core_invocation_finished",
                    "Agent Core invocation has already finished.",
                    status=HTTPStatus.CONFLICT,
                )
            job.state = "cancelling"
            job.cancel_event.set()
            process = job.process
        if process is not None:
            self._terminate_process(process)
        return {
            "apiVersion": AGENT_CORE_RUNTIME_API_VERSION,
            "invocation": {
                "id": job.id,
                "traceId": job.trace_id,
                "runtimeId": AGENT_CORE_RUNTIME_ID,
                "providerId": "openrouter",
                "modelId": job.model_id,
                "status": "cancelling",
            },
        }

    def wait_for_terminal(self, invocation_id: str, timeout_seconds: float = 2) -> bool:
        with self._lock:
            job = self._jobs.get(invocation_id)
        return bool(job and job.done_event.wait(timeout_seconds))

    def _run_job(
        self,
        job: _AgentCoreJob,
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
                self._append_terminal(job, trace_token, "end", "Agent Core trace complete")
                with self._lock:
                    job.state = "completed"
            else:
                self._complete_failed(job, trace_token, "agent_core_bridge_failed")
        except Exception:
            if job.cancel_event.is_set():
                self._complete_cancelled(job, trace_token)
            else:
                self._complete_failed(job, trace_token, "agent_core_runtime_failed")
        finally:
            with self._lock:
                process = job.process
                job.process = None
            if process is not None and process.poll() is None:
                self._terminate_process(process)
            job.done_event.set()

    def _complete_cancelled(self, job: _AgentCoreJob, trace_token: str | None) -> None:
        events = [
            self._event(
                job,
                "model.cancel",
                "instant",
                title="Agent Core model call cancelled",
                summary="运行桥接进程已终止；上游 OpenRouter 流随进程关闭。",
                model={
                    "invocationId": f"{job.id}:cancel",
                    "providerId": "openrouter",
                    "modelId": job.model_id,
                    "source": "live",
                    "cancelReason": "operator_requested",
                },
                activeNodeIds=["model"],
            ),
            self._event(
                job,
                "trace.status",
                "end",
                title="Agent Core trace cancelled",
                summary="取消前已接收的 Rail、Context、Tool 与模型事件已保留。",
                activeNodeIds=["output"],
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
        job: _AgentCoreJob,
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
                        "agent.invoke",
                        "error",
                        title="Agent Core invocation failed",
                        summary="隔离运行时失败；输入、凭据与桥接日志不会写入错误元数据。",
                        details=[{"label": "error", "value": code}],
                        activeNodeIds=["deep-agent"],
                    ),
                    self._event(
                        job,
                        "trace.status",
                        "error",
                        title="Agent Core trace failed",
                        summary=f"Agent Core adapter stopped with {code}.",
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
        job: _AgentCoreJob,
        trace_token: str | None,
        phase: str,
        title: str,
    ) -> None:
        self._trace_store.append(
            job.trace_id,
            trace_token,
            [self._event(job, "trace.status", phase, title=title, activeNodeIds=["output"])],
        )

    def _event(self, job: _AgentCoreJob, kind: str, phase: str, **values: Any) -> dict[str, Any]:
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
            (job for job in self._jobs.values() if job.state not in {"accepted", "running", "cancelling"}),
            key=lambda job: job.started_at,
        )
        for job in terminal[: max(1, len(self._jobs) - MAX_JOB_RECORDS + 1)]:
            self._jobs.pop(job.id, None)
