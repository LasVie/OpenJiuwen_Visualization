"""Fixed subprocess bridge for a real Agent Core SwarmFlow run.

The browser supplies bounded text/model settings only. The workflow source,
phase/worker roster, tools, Rail policy, storage paths, and execution entrypoint
remain repository-owned.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from runtime_source_identity import attach_source_revision, source_revisions

from jiuwenswarm_bridge import (
    _chunks,
    _context_messages,
    _estimated_tokens,
    _install_deterministic_models,
    _message_raw,
    _message_role,
    _message_value,
    _model_spec,
    _redacted_preview,
    _runtime_symbols,
    _text,
    _tool_name,
    _usage,
)


RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
TRACE_RAIL_TYPE = "visualization.swarmflow.trace"
TRACE_RAIL_PRIORITY = -1_000_000
RUN_TIMEOUT_SECONDS = 240
MAX_TEXT = 1_000_000
MAX_DETAIL = 4_000
FIXED_PHASE_IDS = {
    "Understand Input": "understand-input-1",
    "Synthesize Response": "synthesize-response-2",
}
_OBSERVED_EVENTS: list[tuple[str, str]] = []
_OBSERVED_SUBJECT_KINDS: set[str] = set()
_OBSERVED_SUBJECT_IDS: set[str] = set()
_OBSERVED_PARENT_ORDER_ERRORS: list[tuple[str, str]] = []
_LAST_CONTEXT_BY_OWNER: dict[str, list[dict[str, Any]]] = {}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _emit_record(value: dict[str, Any]) -> None:
    if value.get("type") == "event" and isinstance(value.get("event"), dict):
        event = value["event"]
        _OBSERVED_EVENTS.append((str(event.get("kind")), str(event.get("phase"))))
        subject = event.get("subject")
        if isinstance(subject, dict) and isinstance(subject.get("kind"), str):
            _OBSERVED_SUBJECT_KINDS.add(subject["kind"])
            subject_id = subject.get("id")
            parent_id = subject.get("parentId")
            if (
                isinstance(subject_id, str)
                and isinstance(parent_id, str)
                and parent_id not in _OBSERVED_SUBJECT_IDS
            ):
                _OBSERVED_PARENT_ORDER_ERRORS.append((subject_id, parent_id))
            if isinstance(subject_id, str):
                _OBSERVED_SUBJECT_IDS.add(subject_id)
        context = event.get("context")
        if (
            event.get("kind") == "context.snapshot"
            and isinstance(context, dict)
            and context.get("operation") == "replace"
            and isinstance(context.get("ownerId"), str)
            and isinstance(context.get("messages"), list)
        ):
            _LAST_CONTEXT_BY_OWNER[context["ownerId"]] = list(context["messages"])
    print(RECORD_PREFIX + json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _symbols() -> dict[str, Any]:
    symbols = _runtime_symbols()
    from jiuwenswarm.agents.harness.team.handlers.workflow_monitor_handler import (
        WorkflowMonitorHandler,
    )
    from openjiuwen.agent_teams.schema.events import (
        EventMessage,
        TeamEvent,
        WorkflowProgressTeamEvent,
    )
    from openjiuwen.agent_teams.workflow.observer import WorkflowObserver
    from openjiuwen.agent_teams.workflow.runner import run_swarmflow
    from openjiuwen.harness.schema.build_context import BuildContext

    symbols.update(
        {
            "BuildContext": BuildContext,
            "EventMessage": EventMessage,
            "TeamEvent": TeamEvent,
            "WorkflowMonitorHandler": WorkflowMonitorHandler,
            "WorkflowObserver": WorkflowObserver,
            "WorkflowProgressTeamEvent": WorkflowProgressTeamEvent,
            "run_swarmflow": run_swarmflow,
        }
    )
    return symbols


def _probe() -> int:
    try:
        _symbols()
    except ModuleNotFoundError as exc:
        dependency = (exc.name or "unknown").split(".", 1)[0]
        _emit_record(
            {
                "type": "probe",
                "ready": False,
                "code": "swarmflow_dependency_unavailable",
                "message": f"SwarmFlow Python dependency is unavailable: {dependency}.",
            }
        )
        return 1
    except Exception as exc:
        _emit_record(
            {
                "type": "probe",
                "ready": False,
                "code": "swarmflow_import_failed",
                "message": f"SwarmFlow import failed with {type(exc).__name__}.",
            }
        )
        return 1
    _emit_record(
        {
            "type": "probe",
            "ready": True,
            "code": "ready",
            "message": "Agent Core SwarmFlow and JiuwenSwarm workflow monitor imports succeeded.",
            "frameworkVersion": "source-checkout",
        }
    )
    return 0


def _safe_id(value: str, *, prefix: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-_")[:80]
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{normalized or 'node'}:{digest}"


def _event_phase(status: str, *, planned_instant: bool = True) -> str:
    normalized = status.lower()
    if normalized in {"failed", "error"}:
        return "error"
    if normalized in {"completed", "complete", "stopped", "cancelled", "canceled"}:
        return "end"
    if normalized in {"running", "active", "executing", "waiting_for_human"}:
        return "start"
    return "instant" if planned_instant else "start"


@dataclass(slots=True)
class WorkerRuntimeState:
    agent_id: str
    label: str
    phase_name: str
    phase_id: str
    member_name: str = ""
    invoke_count: int = 0
    model_calls: int = 0
    react_iterations: int = 0
    last_react_model_call: int = 0
    total_tokens: int = 0
    current_model_invocation: str = ""
    current_model_started: float = 0
    last_model_window: list[Any] = field(default_factory=list)
    last_model_response: Any = None


class SwarmFlowTraceEmitter:
    def __init__(self, request: dict[str, Any]) -> None:
        self.invocation_id = request["invocationId"]
        self.team_name = request["teamName"]
        self.session_id = request["sessionId"]
        self.run_id = request["runId"]
        self.model_id = request["modelId"]
        self.provider_id = request.get("providerId", "openrouter")
        self.provider_label = (
            "OpenRouter" if self.provider_id == "openrouter" else "Deterministic model"
        )
        self.trace_max_tokens = request["traceMaxTokens"]
        self.source_revisions = source_revisions(request.get("sourceRevisions"))
        self.started_at = time.monotonic()
        self.event_number = 0
        self.agents: dict[str, WorkerRuntimeState] = {}
        self.active_agent_id: str | None = None

    @property
    def team_subject_id(self) -> str:
        return f"team:{self.team_name}"

    @property
    def workflow_subject_id(self) -> str:
        return f"workflow:{self.run_id}"

    @property
    def team_subject(self) -> dict[str, str]:
        return {
            "id": self.team_subject_id,
            "kind": "team",
            "label": "Visualization SwarmFlow",
        }

    @property
    def workflow_subject(self) -> dict[str, str]:
        return {
            "id": self.workflow_subject_id,
            "kind": "workflow",
            "label": "Two-phase response flow",
            "parentId": self.team_subject_id,
            "role": "fixed-workflow",
        }

    def phase_subject_id(self, phase_name: str, phase_id: str | None = None) -> str:
        stable = phase_id or FIXED_PHASE_IDS.get(phase_name) or _safe_id(phase_name, prefix="phase")
        return f"phase:{self.run_id}:{stable}"

    def phase_subject(self, phase_name: str, phase_id: str | None = None) -> dict[str, str]:
        return {
            "id": self.phase_subject_id(phase_name, phase_id),
            "kind": "phase",
            "label": phase_name,
            "parentId": self.workflow_subject_id,
            "role": "author-phase",
        }

    def agent_state(
        self,
        agent_id: str,
        label: str | None = None,
        phase_name: str | None = None,
        phase_id: str | None = None,
    ) -> WorkerRuntimeState:
        existing = self.agents.get(agent_id)
        if existing:
            if label:
                existing.label = label
            if phase_name:
                existing.phase_name = phase_name
            if phase_id:
                existing.phase_id = phase_id
            return existing
        state = WorkerRuntimeState(
            agent_id=agent_id,
            label=label or "Workflow Worker",
            phase_name=phase_name or "Workflow",
            phase_id=phase_id or FIXED_PHASE_IDS.get(phase_name or "", "workflow"),
            current_model_started=self.started_at,
        )
        self.agents[agent_id] = state
        return state

    def active_state(self, member_name: str) -> WorkerRuntimeState:
        if self.active_agent_id is None:
            fallback = self.agent_state(
                f"unmapped-{member_name}",
                member_name,
                "Workflow",
                "workflow",
            )
        else:
            fallback = self.agent_state(self.active_agent_id)
        fallback.member_name = member_name
        return fallback

    def context_owner_id(self, state: WorkerRuntimeState) -> str:
        return _safe_id(
            f"{self.session_id}:{state.agent_id}",
            prefix="context",
        )

    def agent_subject(self, state: WorkerRuntimeState) -> dict[str, str]:
        return {
            "id": _safe_id(f"{self.run_id}:{state.agent_id}", prefix="agent"),
            "kind": "agent",
            "label": state.label,
            "parentId": self.phase_subject_id(state.phase_name, state.phase_id),
            "role": "swarmflow-worker",
            "contextOwnerId": self.context_owner_id(state),
        }

    def register_progress(self, progress: Any) -> WorkerRuntimeState | None:
        if progress.kind != "agent_started":
            return None
        agent_id = str(progress.agent_id or f"agent-{len(self.agents) + 1}")
        state = self.agent_state(
            agent_id,
            str(progress.label or "Workflow Worker"),
            str(progress.phase or "Workflow"),
            FIXED_PHASE_IDS.get(str(progress.phase or "")),
        )
        self.active_agent_id = state.agent_id
        return state

    def emit_progress_boundary(
        self,
        progress: Any,
        state: WorkerRuntimeState | None,
    ) -> None:
        """Register hierarchy synchronously before worker callbacks can emit children."""

        if progress.kind == "workflow_started":
            self.event(
                "swarm.workflow",
                "start",
                title=f"SwarmFlow · {progress.name or 'visualization-two-phase'}",
                summary="Agent Core WorkflowObserver 已登记固定工作流；Monitor 将继续聚合状态。",
                subject=self.workflow_subject,
                payload={
                    "status": "running",
                    "teamId": self.team_name,
                    "runId": self.run_id,
                },
                definition={
                    "repository": "agent-core",
                    "path": "openjiuwen/agent_teams/workflow/observer.py",
                    "symbol": "WorkflowObserver",
                },
            )
            descriptions = {
                "Understand Input": "分析输入并形成供下一阶段使用的结构化理解。",
                "Synthesize Response": "读取分析结果并生成最终响应。",
            }
            for phase_name, phase_id in FIXED_PHASE_IDS.items():
                self.event(
                    "swarm.phase",
                    "instant",
                    title=f"Phase · {phase_name}",
                    summary=descriptions[phase_name],
                    subject=self.phase_subject(phase_name, phase_id),
                    payload={
                        "status": "planned",
                        "runId": self.run_id,
                        "agentCount": 1,
                        "completedAgentCount": 0,
                    },
                    definition={
                        "repository": "visualization-web",
                        "path": "services/local-server/scripts/workflows/swarmflow_v1.py",
                        "symbol": "META",
                    },
                )
            return

        if progress.kind != "agent_started" or state is None:
            return
        self.event(
            "swarm.phase",
            "start",
            title=f"Phase · {state.phase_name}",
            summary="Agent Core 已进入该固定阶段。",
            subject=self.phase_subject(state.phase_name, state.phase_id),
            payload={"status": "running", "runId": self.run_id},
        )
        self.event(
            "swarm.agent",
            "start",
            title=f"Worker · {state.label}",
            summary="临时 TeamHarness Worker 已创建，随后进入真实 DeepAgent/ReAct loop。",
            subject=self.agent_subject(state),
            payload={
                "status": "running",
                "runId": self.run_id,
                "nodeType": str(progress.node_type or "agent"),
                "workerEphemeral": True,
            },
            definition={
                "repository": "agent-core",
                "path": "openjiuwen/agent_teams/workflow/backends/team_worker_backend.py",
                "symbol": "TeamWorkerBackend",
            },
        )

    def event(self, kind: str, phase: str, **values: Any) -> None:
        self.event_number += 1
        attach_source_revision(values, self.source_revisions)
        event = {
            "eventId": f"{self.invocation_id}:bridge:{self.event_number}",
            "kind": kind,
            "phase": phase,
            "timestampMs": max(0, round((time.monotonic() - self.started_at) * 1_000)),
            "spanId": values.pop("spanId", f"{self.invocation_id}:workflow"),
            **values,
        }
        _emit_record({"type": "event", "event": event})

    def hook(
        self,
        state: WorkerRuntimeState,
        *,
        callback: str,
        examines: list[str],
        mutation: str = "无变更",
        signal: str = "continue",
        noop: bool = False,
    ) -> None:
        self.event(
            "rail.hook",
            "instant",
            title=f"SwarmFlowTraceRail · {state.label} · {callback}",
            summary="Worker 级显式探针记录了 Rail 的实际审查载荷、变更与控制信号。",
            hook={
                "rail": "SwarmFlowTraceRail",
                "railNodeId": f"swarmflow-rail:{state.agent_id}",
                "callback": callback,
                "priority": TRACE_RAIL_PRIORITY,
                "namespace": "inner",
                "durationMs": 0,
                "mutationDiff": mutation,
                "controlSignal": signal,
                "noop": noop,
                "exact": True,
                "examines": [item[:240] for item in examines[:100] if item],
            },
            subject=self.agent_subject(state),
            spanId=(
                f"{self.invocation_id}:{state.agent_id}:rail:{callback}:{self.event_number}"
            ),
        )

    def emit_workflow_update(self, item: dict[str, Any]) -> None:
        workflow = item.get("workflow")
        if not isinstance(workflow, dict):
            return
        workflow_status = str(workflow.get("status") or "running")
        self.event(
            "swarm.workflow",
            _event_phase(workflow_status),
            title=f"SwarmFlow · {workflow.get('name') or 'workflow'}",
            summary="JiuwenSwarm WorkflowMonitorHandler 聚合了结构化 WorkflowProgressEvent。",
            subject=self.workflow_subject,
            payload={
                "status": workflow_status,
                "teamId": self.team_name,
                "runId": self.run_id,
                "agentCount": int(workflow.get("agent_count") or 0),
                "completedAgentCount": int(workflow.get("completed_agent_count") or 0),
            },
            definition={
                "repository": "jiuwenswarm",
                "path": "jiuwenswarm/agents/harness/team/handlers/workflow_monitor_handler.py",
                "symbol": "WorkflowMonitorHandler",
            },
        )
        phases = workflow.get("phases")
        if not isinstance(phases, list):
            return
        for phase in phases:
            if not isinstance(phase, dict):
                continue
            phase_name = str(phase.get("name") or "Workflow phase")
            phase_id = str(phase.get("id") or FIXED_PHASE_IDS.get(phase_name) or "phase")
            phase_status = str(phase.get("status") or "planned")
            phase_subject = self.phase_subject(phase_name, phase_id)
            self.event(
                "swarm.phase",
                _event_phase(phase_status),
                title=f"Phase · {phase_name}",
                summary=str(phase.get("description") or "固定工作流阶段状态已更新。"),
                subject=phase_subject,
                payload={
                    "status": phase_status,
                    "runId": self.run_id,
                    "agentCount": int(phase.get("agent_count") or 0),
                    "completedAgentCount": int(phase.get("completed_agent_count") or 0),
                },
                definition={
                    "repository": "jiuwenswarm",
                    "path": "jiuwenswarm/agents/harness/team/handlers/workflow_state.py",
                    "symbol": "WorkflowPhaseState",
                },
            )
            agents = phase.get("agents")
            if not isinstance(agents, list):
                continue
            for agent in agents:
                if not isinstance(agent, dict):
                    continue
                agent_id = str(agent.get("id") or f"agent-{len(self.agents) + 1}")
                state = self.agent_state(
                    agent_id,
                    str(agent.get("name") or "Workflow Worker"),
                    phase_name,
                    phase_id,
                )
                agent_status = str(agent.get("status") or "running")
                details: list[dict[str, str]] = []
                if isinstance(agent.get("outcome"), str) and agent["outcome"]:
                    details.append({"label": "outcome", "value": agent["outcome"][:MAX_DETAIL]})
                if isinstance(agent.get("error"), str) and agent["error"]:
                    details.append({"label": "error", "value": agent["error"][:MAX_DETAIL]})
                self.event(
                    "swarm.agent",
                    _event_phase(agent_status),
                    title=f"Worker · {state.label}",
                    summary="临时 TeamHarness Worker 状态由真实 SwarmFlow 进度事件更新。",
                    subject=self.agent_subject(state),
                    details=details,
                    payload={
                        "status": agent_status,
                        "runId": self.run_id,
                        "nodeType": str(agent.get("node_type") or "agent"),
                        "workerEphemeral": True,
                    },
                    definition={
                        "repository": "agent-core",
                        "path": "openjiuwen/agent_teams/workflow/backends/team_worker_backend.py",
                        "symbol": "TeamWorkerBackend",
                    },
                )


def _reviewed_messages(messages: list[Any]) -> list[str]:
    result: list[str] = []
    for index, message in enumerate(messages):
        result.append(f"message {index + 1} · {_message_role(message)}")
        result.extend(_chunks(_message_raw(message), maximum=100 - len(result)))
        if len(result) >= 100:
            break
    return result[:100]


def _build_trace_rail(symbols: dict[str, Any], emitter: SwarmFlowTraceEmitter, context: Any):
    AgentRail = symbols["AgentRail"]
    InvokeInputs = symbols["InvokeInputs"]
    ModelCallInputs = symbols["ModelCallInputs"]
    ToolCallInputs = symbols["ToolCallInputs"]
    UserMessageInputs = symbols["UserMessageInputs"]
    member_name = str(getattr(context, "member_name", None) or "workflow-worker")
    state = emitter.active_state(member_name)

    class SwarmFlowTraceRail(AgentRail):
        priority = TRACE_RAIL_PRIORITY

        async def before_invoke(self, ctx):
            state.invoke_count += 1
            query = ctx.inputs.query if isinstance(ctx.inputs, InvokeInputs) else ""
            emitter.event(
                "agent.invoke",
                "start",
                title=f"{state.label} DeepAgent invoke",
                summary="临时 SwarmFlow Worker 的真实 DeepAgent/ReAct loop 已接管该阶段输入。",
                subject=emitter.agent_subject(state),
                payload={
                    "status": "running",
                    "runId": emitter.run_id,
                    "workerMemberName": member_name,
                    "queryCharacters": len(_text(query)),
                },
                spanId=f"{emitter.invocation_id}:{state.agent_id}:invoke:{state.invoke_count}",
            )

        async def after_invoke(self, ctx):
            result = ctx.inputs.result if isinstance(ctx.inputs, InvokeInputs) else None
            model_context = getattr(ctx, "context", None)
            context_messages = list(model_context.get_messages()) if model_context is not None else []
            final_messages = list(state.last_model_window or context_messages)
            if state.last_model_response is not None:
                final_messages.append(state.last_model_response)
            serialized = _context_messages(
                final_messages,
                emitter.context_owner_id(state),
                f"SwarmFlow {state.label} final ModelContext",
            )
            if serialized:
                emitter.event(
                    "context.snapshot",
                    "instant",
                    title=f"{state.label} final context",
                    summary="该 Worker 完成后的完整连续 ModelContext；不会与另一个 Worker 合并。",
                    token={
                        "used": state.total_tokens,
                        "delta": 0,
                        "budget": emitter.trace_max_tokens,
                    },
                    context={
                        "operation": "replace",
                        "ownerId": emitter.context_owner_id(state),
                        "messages": serialized,
                    },
                    subject=emitter.agent_subject(state),
                )
            failed = ctx.exception is not None or (
                isinstance(result, dict) and result.get("result_type") == "error"
            )
            emitter.event(
                "agent.invoke",
                "error" if failed else "end",
                title=f"{state.label} {'failed' if failed else 'completed'}",
                summary="Worker 已退出本次真实 DeepAgent/ReAct loop。",
                subject=emitter.agent_subject(state),
                payload={
                    "status": "failed" if failed else "completed",
                    "runId": emitter.run_id,
                },
                spanId=f"{emitter.invocation_id}:{state.agent_id}:invoke:{state.invoke_count}",
            )

        async def on_user_message(self, ctx):
            parts = ctx.inputs.parts if isinstance(ctx.inputs, UserMessageInputs) else []
            raw = "\n".join(_text(part) for part in parts)
            emitter.event(
                "agent.user_message",
                "instant",
                title=f"{state.label} admitted workflow prompt",
                summary="阶段 prompt 经过 Worker Rail 后进入该 Worker 的独立 Context。",
                subject=emitter.agent_subject(state),
            )
            emitter.event(
                "context.delta",
                "instant",
                title=f"{state.label} input appended",
                context={
                    "operation": "append",
                    "ownerId": emitter.context_owner_id(state),
                    "messages": [
                        {
                            "id": f"{emitter.context_owner_id(state)}:input:{state.invoke_count}",
                            "role": "user",
                            "label": "SwarmFlow worker input",
                            "raw": raw,
                            "preview": _redacted_preview(raw),
                            "tokens": _estimated_tokens(raw),
                            "source": "SwarmFlow worker prompt",
                        }
                    ],
                },
                subject=emitter.agent_subject(state),
            )
            emitter.hook(
                state,
                callback="on_user_message",
                examines=_chunks(raw, maximum=100),
            )

        async def before_model_call(self, ctx):
            state.model_calls += 1
            state.current_model_invocation = (
                f"{emitter.invocation_id}:{state.agent_id}:model:{state.model_calls}"
            )
            state.current_model_started = time.monotonic()
            messages = list(ctx.inputs.messages or []) if isinstance(ctx.inputs, ModelCallInputs) else []
            incoming_tools = list(ctx.inputs.tools or []) if isinstance(ctx.inputs, ModelCallInputs) else []
            removed = sorted(
                {_tool_name(tool) for tool in incoming_tools if _tool_name(tool) != "unknown"}
            )
            if isinstance(ctx.inputs, ModelCallInputs):
                ctx.inputs.tools = []
            emitter.hook(
                state,
                callback="before_model_call.tool_boundary",
                examines=[
                    "allowed tool schemas: none",
                    f"incoming tool schemas: {len(incoming_tools)}",
                    *[f"removed: {name}" for name in removed[:98]],
                ],
                mutation=(f"移除 {len(removed)} 个 Tool schema" if removed else "无变更"),
            )
            inspectors = ctx.extra.setdefault("_stream_chunk_inspectors", {})
            if isinstance(inspectors, dict):
                inspectors[f"openjiuwen-visualization-{state.agent_id}"] = self._inspect_stream_chunk
            emitter.event(
                "model.call",
                "start",
                title=f"{state.label} · {emitter.provider_label} call {state.model_calls}",
                summary="该 Worker 正在发送自己的完整 ContextWindow；工具 schema 已固定为空。",
                iteration=state.model_calls,
                model={
                    "invocationId": state.current_model_invocation,
                    "providerId": emitter.provider_id,
                    "modelId": emitter.model_id,
                    "source": "live",
                    "budget": {
                        "maxTotalTokens": emitter.trace_max_tokens,
                        "currency": "USD",
                    },
                },
                subject=emitter.agent_subject(state),
                spanId=state.current_model_invocation,
            )
            emitter.hook(
                state,
                callback="before_model_call",
                examines=_reviewed_messages(messages),
            )

        async def _inspect_stream_chunk(self, ctx, chunk):
            del ctx
            content = _text(getattr(chunk, "content", ""))
            if not content:
                return
            emitter.event(
                "model.stream",
                "instant",
                title=f"{state.label} model stream delta",
                iteration=state.model_calls,
                model={
                    "invocationId": state.current_model_invocation,
                    "providerId": emitter.provider_id,
                    "modelId": emitter.model_id,
                    "source": "live",
                    "delta": content,
                },
                subject=emitter.agent_subject(state),
                spanId=state.current_model_invocation,
            )

        async def after_model_call(self, ctx):
            if not isinstance(ctx.inputs, ModelCallInputs):
                return
            messages = list(ctx.inputs.messages or [])
            state.last_model_window = messages
            response = ctx.inputs.response
            state.last_model_response = response
            serialized = _context_messages(
                messages,
                emitter.context_owner_id(state),
                f"SwarmFlow {state.label} actual model window",
            )
            usage = _usage(response)
            call_tokens = (
                usage["totalTokens"] if usage else sum(message["tokens"] for message in serialized)
            )
            state.total_tokens += call_tokens
            emitter.event(
                "context.snapshot",
                "instant",
                title=f"{state.label} model window {state.model_calls}",
                summary="AFTER_MODEL_CALL 暴露的实际发送窗口；原文完整保存在当前 Context owner 下。",
                iteration=state.model_calls,
                token={
                    "used": state.total_tokens,
                    "delta": call_tokens,
                    "budget": emitter.trace_max_tokens,
                },
                context={
                    "operation": "replace",
                    "ownerId": emitter.context_owner_id(state),
                    "messages": serialized,
                },
                subject=emitter.agent_subject(state),
            )
            response_text = _text(_message_value(response, "content"))
            emitter.event(
                "model.call",
                "end",
                title=f"{state.label} model call {state.model_calls} completed",
                summary="模型返回当前阶段的文本分支。",
                iteration=state.model_calls,
                durationMs=max(
                    0,
                    round((time.monotonic() - state.current_model_started) * 1_000),
                ),
                model={
                    "invocationId": state.current_model_invocation,
                    "providerId": emitter.provider_id,
                    "modelId": emitter.model_id,
                    "source": "live",
                    "responseText": response_text,
                    "finishReason": _text(_message_value(response, "finish_reason"), 240)
                    or "unknown",
                },
                subject=emitter.agent_subject(state),
                spanId=state.current_model_invocation,
            )
            if usage:
                emitter.event(
                    "model.usage",
                    "instant",
                    title=f"{state.label} model usage {state.model_calls}",
                    iteration=state.model_calls,
                    token={
                        "used": state.total_tokens,
                        "delta": call_tokens,
                        "budget": emitter.trace_max_tokens,
                    },
                    model={
                        "invocationId": state.current_model_invocation,
                        "providerId": emitter.provider_id,
                        "modelId": emitter.model_id,
                        "source": "live",
                        "usage": usage,
                    },
                    subject=emitter.agent_subject(state),
                    spanId=state.current_model_invocation,
                )
            if state.last_react_model_call < state.model_calls:
                state.react_iterations += 1
                state.last_react_model_call = state.model_calls
                emitter.event(
                    "agent.react_iteration",
                    "end",
                    title=f"{state.label} ReAct iteration {state.react_iterations}",
                    iteration=state.react_iterations,
                    summary="真实 Model/Observation 循环完成一次；本 profile 的 Tool schema 边界为空。",
                    subject=emitter.agent_subject(state),
                    spanId=(
                        f"{emitter.invocation_id}:{state.agent_id}:react:"
                        f"{state.react_iterations}"
                    ),
                )

        async def on_model_exception(self, ctx):
            emitter.hook(
                state,
                callback="on_model_exception",
                examines=[
                    f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}"
                ],
                signal="fail",
            )

        async def before_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            arguments = _text(ctx.inputs.tool_args, MAX_DETAIL)
            message = f"Tool '{tool_name}' is denied by the fixed SwarmFlow visualization profile."
            tool_call_id = _text(_message_value(ctx.inputs.tool_call, "id"), 240)
            ctx.extra["_skip_tool"] = True
            ctx.inputs.tool_result = {"error": message}
            ctx.inputs.tool_msg = symbols["ToolMessage"](
                content=message,
                tool_call_id=tool_call_id,
            )
            emitter.hook(
                state,
                callback="before_tool_call",
                examines=[f"tool: {tool_name}", *_chunks(arguments, maximum=98)],
                mutation="阻止全部 Tool 执行",
                signal="deny",
            )
            emitter.event(
                "tool.call",
                "error",
                title=f"{state.label} · {tool_name} denied",
                summary="固定 SwarmFlow V1 profile 不向 Worker 开放任何工具。",
                details=[{"label": "policy", "value": "fixed-no-tools"}],
                subject=emitter.agent_subject(state),
                spanId=f"{emitter.invocation_id}:{state.agent_id}:tool:{state.model_calls}",
            )

        async def after_react_iteration(self, ctx):
            del ctx
            if state.last_react_model_call >= state.model_calls:
                return
            state.react_iterations += 1
            state.last_react_model_call = state.model_calls
            emitter.event(
                "agent.react_iteration",
                "end",
                title=f"{state.label} ReAct iteration {state.react_iterations}",
                iteration=state.react_iterations,
                summary="Worker 完成一次真实 Model/Tool/Observation 决策迭代。",
                subject=emitter.agent_subject(state),
                spanId=(
                    f"{emitter.invocation_id}:{state.agent_id}:react:{state.react_iterations}"
                ),
            )

    return SwarmFlowTraceRail()


class _LocalWorkflowMonitor:
    """Minimal monitor transport that preserves JiuwenSwarm handler semantics."""

    def __init__(self) -> None:
        self._event_queue: asyncio.Queue[Any] = asyncio.Queue()
        self._workflow_event_queue: asyncio.Queue[Any] = asyncio.Queue()
        self.started = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        if self.started:
            self.started = False
            await self._workflow_event_queue.put(None)

    def publish(self, event: Any) -> None:
        self._workflow_event_queue.put_nowait(event)

    async def drain(self) -> None:
        await self._workflow_event_queue.join()

    async def workflow_events(self):
        while True:
            item = await self._workflow_event_queue.get()
            try:
                if item is None:
                    break
                yield item
            finally:
                self._workflow_event_queue.task_done()


def _workflow_handler(symbols: dict[str, Any], monitor: _LocalWorkflowMonitor, session_id: str):
    WorkflowMonitorHandler = symbols["WorkflowMonitorHandler"]

    class VisualizationWorkflowMonitorHandler(WorkflowMonitorHandler):
        def _persist(self) -> None:
            return None

    return VisualizationWorkflowMonitorHandler(monitor=monitor, session_id=session_id)


async def _drain_workflow_updates(emitter: SwarmFlowTraceEmitter, handler: Any) -> None:
    async for item in handler.events():
        emitter.emit_workflow_update(item)


def _publish_progress(
    symbols: dict[str, Any],
    emitter: SwarmFlowTraceEmitter,
    monitor: _LocalWorkflowMonitor,
    name_box: dict[str, str | None],
    progress: Any,
) -> None:
    state = emitter.register_progress(progress)
    emitter.emit_progress_boundary(progress, state)
    if progress.kind == "workflow_started":
        name_box["name"] = progress.name
        name_box["description"] = progress.description
    team_event = symbols["WorkflowProgressTeamEvent"](
        team_name=emitter.team_name,
        kind=progress.kind,
        run_id=emitter.run_id,
        workflow_name=name_box.get("name"),
        description=name_box.get("description"),
        phase=progress.phase,
        label=progress.label,
        prompt=progress.prompt,
        model=progress.model or emitter.model_id,
        outcome=progress.outcome,
        text=progress.message,
        phases=progress.phases,
        correlation_id=progress.correlation_id,
        node_type=progress.node_type,
        agent_id=progress.agent_id,
        answer=progress.answer,
        tokens=progress.tokens,
        budget=progress.budget,
        phase_type=progress.phase_type,
        nested_phase=progress.nested_phase,
        parent_phase=progress.parent_phase,
    )
    monitor.publish(
        symbols["EventMessage"](
            event_type=symbols["TeamEvent"].WORKFLOW_PROGRESS,
            payload=team_event.model_dump(),
            sender_id="swarmflow",
        )
    )


def _build_worker_spec(
    symbols: dict[str, Any],
    request: dict[str, Any],
    emitter: SwarmFlowTraceEmitter,
):
    workspace = Path(request["workspace"]).resolve(strict=False)
    workspace.mkdir(parents=True, exist_ok=True)
    from openjiuwen.agent_teams.paths import configure_openjiuwen_home

    configure_openjiuwen_home(workspace / "openjiuwen-home")
    symbols["register_rail_provider"](
        TRACE_RAIL_TYPE,
        lambda params, context: _build_trace_rail(symbols, emitter, context),
    )
    if request["modelMode"] == "deterministic":
        _install_deterministic_models(symbols)
    model_id = (
        "deterministic/swarmflow-worker"
        if request["modelMode"] == "deterministic"
        else request["modelId"]
    )
    trace_rail = symbols["RailSpec"](type=TRACE_RAIL_TYPE)
    return symbols["DeepAgentSpec"](
        model=_model_spec(symbols, request, model_id),
        system_prompt=(
            "You are an ephemeral SwarmFlow worker. Complete only the supplied phase prompt. "
            "Do not use tools, files, shell, network, MCP, Skills, Subagents, team coordination, "
            "or human interaction. Return one concise text result."
        ),
        rails=[trace_rail],
        tools=[],
        subagents=[],
        mcps=[],
        max_iterations=request["maxIterations"],
        enable_task_loop=False,
        enable_task_planning=False,
        enable_sys_operation=False,
        enable_skill_discovery=False,
        enable_security_rail=True,
        auto_create_workspace=True,
    )


def _read_request() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("Request must be an object")
    required = {
        "invocationId": 240,
        "teamName": 240,
        "sessionId": 240,
        "runId": 240,
        "modelId": 240,
        "input": 120_000,
        "workspace": 4_000,
        "workflowScript": 4_000,
    }
    for name, maximum in required.items():
        field_value = value.get(name)
        if not isinstance(field_value, str) or not field_value.strip() or len(field_value) > maximum:
            raise ValueError(f"Invalid {name}")
    system_prompt = value.get("systemPrompt")
    if system_prompt is not None and (
        not isinstance(system_prompt, str) or len(system_prompt) > 32_000
    ):
        raise ValueError("Invalid systemPrompt")
    for name, minimum, maximum in (
        ("maxOutputTokens", 16, 16_384),
        ("maxIterations", 1, 20),
        ("traceMaxTokens", 1, 10_000_000),
    ):
        field_value = value.get(name)
        if isinstance(field_value, bool) or not isinstance(field_value, int):
            raise ValueError(f"Invalid {name}")
        if not minimum <= field_value <= maximum:
            raise ValueError(f"Invalid {name}")
    value["modelMode"] = "live"
    value["providerId"] = "openrouter"
    value["sourceRevisions"] = source_revisions(value.get("sourceRevisions"))
    return value


async def _run(request: dict[str, Any]) -> None:
    workspace = Path(request["workspace"]).resolve(strict=False)
    workspace.mkdir(parents=True, exist_ok=True)
    temp_root = workspace / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(temp_root)
    workflow_script = Path(request["workflowScript"]).resolve(strict=True)
    symbols = _symbols()
    emitter = SwarmFlowTraceEmitter(request)
    worker_spec = _build_worker_spec(symbols, request, emitter)
    monitor = _LocalWorkflowMonitor()
    handler = _workflow_handler(symbols, monitor, request["sessionId"])
    name_box: dict[str, str | None] = {
        "name": "visualization-two-phase",
        "description": "Fixed two-phase visualization workflow",
    }
    observer = symbols["WorkflowObserver"](
        on_event=lambda progress: _publish_progress(
            symbols,
            emitter,
            monitor,
            name_box,
            progress,
        )
    )
    drain_task = None
    runner_started = False
    emitter.event(
        "trace.status",
        "start",
        title="SwarmFlow trace started",
        summary="固定子进程开始运行真实 Agent Core SwarmFlow。",
    )
    emitter.event(
        "swarm.team",
        "start",
        title="SwarmFlow runtime container",
        summary="该容器只承载 workflow；Worker 是临时 TeamHarness，不是协作 teammate。",
        subject=emitter.team_subject,
        payload={
            "status": "running",
            "teamId": emitter.team_name,
            "runId": emitter.run_id,
            "teamMode": "workflow",
            "dispatchMode": "sequential",
            "swarmFlow": True,
        },
        definition={
            "repository": "agent-core",
            "path": "openjiuwen/agent_teams/workflow/runner.py",
            "symbol": "run_swarmflow",
        },
    )
    try:
        await symbols["Runner"].start()
        runner_started = True
        await handler.start()
        drain_task = asyncio.create_task(
            _drain_workflow_updates(emitter, handler),
            name="visualization-swarmflow-monitor",
        )
        result = await asyncio.wait_for(
            symbols["run_swarmflow"](
                str(workflow_script),
                model=None,
                observer=observer,
                args={
                    "input": request["input"],
                    "system_prompt": request.get("systemPrompt"),
                },
                team_name=request["teamName"],
                language="cn",
                worker_base_spec=worker_spec,
                build_context=symbols["BuildContext"](
                    language="cn",
                    project_dir=str(workspace),
                ),
                session_id=request["sessionId"],
                run_id=request["runId"],
            ),
            timeout=RUN_TIMEOUT_SECONDS,
        )
        await monitor.drain()
        await handler.stop()
        await drain_task
        drain_task = None
        emitter.event(
            "swarm.team",
            "end",
            title="SwarmFlow runtime completed",
            summary="两个临时 Worker 已结束；阶段、Rail、模型和独立 Context 证据已归一化。",
            subject=emitter.team_subject,
            payload={
                "status": "completed",
                "teamId": emitter.team_name,
                "runId": emitter.run_id,
                "resultPreview": _redacted_preview(_text(result, MAX_DETAIL)),
            },
        )
        emitter.event(
            "trace.status",
            "end",
            title="SwarmFlow trace complete",
            summary="本次运行使用真实 run_swarmflow、TeamWorkerBackend 与 WorkflowMonitorHandler。",
        )
    except BaseException as exc:
        emitter.event(
            "swarm.workflow",
            "error",
            title="SwarmFlow workflow failed",
            summary="隔离运行失败；输入、凭据与原始异常文本不会写入错误元数据。",
            subject=emitter.workflow_subject,
            details=[{"label": "error", "value": type(exc).__name__}],
            payload={"status": "failed", "runId": emitter.run_id},
        )
        emitter.event(
            "swarm.team",
            "error",
            title="SwarmFlow runtime failed",
            summary="固定工作流容器已停止。",
            subject=emitter.team_subject,
            payload={"status": "failed", "teamId": emitter.team_name},
        )
        emitter.event(
            "trace.status",
            "error",
            title="SwarmFlow trace failed",
            summary=f"SwarmFlow bridge stopped with {type(exc).__name__}.",
        )
        raise
    finally:
        with contextlib.suppress(Exception):
            await handler.stop()
        if drain_task is not None:
            if not drain_task.done():
                drain_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await drain_task
        if runner_started:
            with contextlib.suppress(Exception):
                await symbols["Runner"].stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args(argv)
    if arguments.probe:
        return _probe()
    try:
        if arguments.self_test:
            self_test_root = (
                Path.cwd() / ".swarmflow-runtime-self-test" / str(os.getpid())
            ).resolve()
            self_test_root.mkdir(parents=True, exist_ok=True)
            request = {
                "invocationId": "swarmflow-self-test",
                "teamName": "visualization_swarmflow_self_test",
                "sessionId": f"session_self_test_{os.getpid()}",
                "runId": f"workflow_self_test_{os.getpid()}",
                "modelId": "deterministic/swarmflow-worker",
                "providerId": "deterministic",
                "modelMode": "deterministic",
                "input": "Run the deterministic two-phase SwarmFlow self-test.",
                "systemPrompt": "Exercise both real workflow workers.",
                "maxOutputTokens": 128,
                "maxIterations": 4,
                "traceMaxTokens": 32_768,
                "workspace": str(self_test_root),
                "workflowScript": str(
                    (Path(__file__).parent / "workflows" / "swarmflow_v1.py").resolve()
                ),
            }
        else:
            request = _read_request()
        asyncio.run(_run(request))
        if arguments.self_test:
            required = {
                "agent.invoke",
                "agent.user_message",
                "agent.react_iteration",
                "context.delta",
                "context.snapshot",
                "model.call",
                "model.usage",
                "rail.hook",
                "swarm.agent",
                "swarm.phase",
                "swarm.team",
                "swarm.workflow",
                "trace.status",
            }
            observed = {kind for kind, _phase in _OBSERVED_EVENTS}
            missing = sorted(required - observed)
            if missing or ("trace.status", "end") not in _OBSERVED_EVENTS:
                raise RuntimeError(
                    "SwarmFlow self-test event coverage failed: "
                    + (", ".join(missing) if missing else "terminal event missing")
                )
            if not {"team", "workflow", "phase", "agent"}.issubset(
                _OBSERVED_SUBJECT_KINDS
            ):
                raise RuntimeError("SwarmFlow self-test subject hierarchy is incomplete")
            if _OBSERVED_PARENT_ORDER_ERRORS:
                child, parent = _OBSERVED_PARENT_ORDER_ERRORS[0]
                raise RuntimeError(
                    f"SwarmFlow subject {child} appeared before parent {parent}"
                )
            if len(_LAST_CONTEXT_BY_OWNER) != 2:
                raise RuntimeError("SwarmFlow workers did not retain two independent contexts")
            raw_context = "\n".join(
                _text(message.get("raw"))
                for messages in _LAST_CONTEXT_BY_OWNER.values()
                for message in messages
            )
            if "Deterministic JiuwenSwarm" not in raw_context:
                raise RuntimeError("SwarmFlow self-test final worker contexts are incomplete")
    except Exception as exc:
        _emit_record(
            {
                "type": "error",
                "code": "swarmflow_bridge_failed",
                "message": f"SwarmFlow bridge failed with {type(exc).__name__}.",
            }
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
