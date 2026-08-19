"""Fixed JSON-line bridge into a real JiuwenSwarm Agent Team runtime.

The browser can choose only bounded text/model settings. Team shape, tools,
storage, workspaces, provider assembly, and process entrypoint stay fixed here.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from runtime_source_identity import attach_source_revision, source_revisions


RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
TRACE_RAIL_TYPE = "visualization.swarm.trace"
TRACE_RAIL_PRIORITY = -1_000_000
MAX_TEXT = 1_000_000
MAX_DETAIL = 4_000
RUN_TIMEOUT_SECONDS = 240
SAFE_SWARM_RAILS = frozenset(
    {
        TRACE_RAIL_TYPE,
        "swarm.runtime_prompt",
        "swarm.response_prompt",
        "swarm.avatar_prompt",
        "swarm.context_processor",
    }
)
ALLOWED_TEAM_TOOLS = {
    "leader": frozenset({"create_task", "view_task", "send_message"}),
    "teammate": frozenset({"view_task", "send_message", "member_complete_task"}),
}
_OBSERVED_EVENTS: list[tuple[str, str]] = []
_OBSERVED_SUBJECT_KINDS: set[str] = set()
_OBSERVED_REGISTERED_TOOLS: set[str] = set()
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
        if event.get("kind") == "ability.register":
            payload = event.get("payload")
            if isinstance(payload, dict) and isinstance(payload.get("tools"), list):
                _OBSERVED_REGISTERED_TOOLS.update(
                    str(tool) for tool in payload["tools"] if isinstance(tool, str)
                )
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


def _runtime_symbols() -> dict[str, Any]:
    from jiuwenswarm.agents.harness.team.handlers.team_monitor_handler import TeamMonitorHandler
    from jiuwenswarm.agents.swarm import enrich_team_spec_for_swarm
    from openjiuwen.agent_teams.schema.blueprint import (
        LeaderSpec,
        StorageSpec,
        TeamAgentSpec,
        TransportSpec,
    )
    from openjiuwen.agent_teams.schema.team import TeamMemberSpec, TeamRole
    from openjiuwen.agent_teams.team_workspace.models import TeamWorkspaceConfig
    from openjiuwen.core.foundation.llm import (
        AssistantMessage,
        AssistantMessageChunk,
        Model,
        ModelClientConfig,
        ModelRequestConfig,
        ToolCall,
        ToolMessage,
        UsageMetadata,
    )
    from openjiuwen.core.runner import Runner
    from openjiuwen.core.single_agent.rail.base import (
        AgentRail,
        InvokeInputs,
        ModelCallInputs,
        ToolCallInputs,
        UserMessageInputs,
    )
    from openjiuwen.harness.schema.deep_agent_spec import (
        DeepAgentSpec,
        RailSpec,
        TeamModelConfig,
        WorkspaceSpec,
        register_rail_provider,
    )

    return {
        "AssistantMessage": AssistantMessage,
        "AssistantMessageChunk": AssistantMessageChunk,
        "Model": Model,
        "ModelClientConfig": ModelClientConfig,
        "ModelRequestConfig": ModelRequestConfig,
        "ToolCall": ToolCall,
        "ToolMessage": ToolMessage,
        "UsageMetadata": UsageMetadata,
        "AgentRail": AgentRail,
        "InvokeInputs": InvokeInputs,
        "ModelCallInputs": ModelCallInputs,
        "ToolCallInputs": ToolCallInputs,
        "UserMessageInputs": UserMessageInputs,
        "DeepAgentSpec": DeepAgentSpec,
        "LeaderSpec": LeaderSpec,
        "StorageSpec": StorageSpec,
        "TeamAgentSpec": TeamAgentSpec,
        "TeamMemberSpec": TeamMemberSpec,
        "TeamModelConfig": TeamModelConfig,
        "TeamRole": TeamRole,
        "TransportSpec": TransportSpec,
        "WorkspaceSpec": WorkspaceSpec,
        "TeamWorkspaceConfig": TeamWorkspaceConfig,
        "RailSpec": RailSpec,
        "Runner": Runner,
        "TeamMonitorHandler": TeamMonitorHandler,
        "enrich_team_spec_for_swarm": enrich_team_spec_for_swarm,
        "register_rail_provider": register_rail_provider,
    }


def _probe() -> int:
    try:
        _runtime_symbols()
    except ModuleNotFoundError as exc:
        dependency = (exc.name or "unknown").split(".", 1)[0]
        _emit_record(
            {
                "type": "probe",
                "ready": False,
                "code": "jiuwenswarm_dependency_unavailable",
                "message": f"JiuwenSwarm Python dependency is unavailable: {dependency}.",
            }
        )
        return 1
    except Exception as exc:
        _emit_record(
            {
                "type": "probe",
                "ready": False,
                "code": "jiuwenswarm_import_failed",
                "message": f"JiuwenSwarm import failed with {type(exc).__name__}.",
            }
        )
        return 1
    _emit_record(
        {
            "type": "probe",
            "ready": True,
            "code": "ready",
            "message": "JiuwenSwarm provider assembly and Agent Team imports succeeded.",
            "frameworkVersion": "source-checkout",
        }
    )
    return 0


def _text(value: Any, maximum: int = MAX_TEXT) -> str:
    if isinstance(value, str):
        result = value
    elif value is None:
        result = ""
    else:
        try:
            result = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            result = str(value)
    return result[:maximum]


def _estimated_tokens(value: str) -> int:
    if not value:
        return 0
    ascii_count = sum(ord(character) < 128 for character in value)
    non_ascii_count = len(value) - ascii_count
    return max(1, math.ceil(ascii_count / 4) + math.ceil(non_ascii_count / 1.6))


def _redacted_preview(value: str) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    compact = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", compact)
    compact = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[secret]", compact)
    compact = re.sub(r"(?i)(api[_ -]?key\s*[:=]\s*)\S+", r"\1[secret]", compact)
    return compact[:160] + ("…" if len(compact) > 160 else "")


def _chunks(value: str, size: int = 220, maximum: int = 100) -> list[str]:
    if not value:
        return ["(empty)"]
    chunks = [value[index:index + size] for index in range(0, len(value), size)]
    if len(chunks) > maximum:
        return [*chunks[: maximum - 1], f"[truncated {len(value) - size * (maximum - 1)} chars]"]
    return chunks


def _message_value(message: Any, name: str) -> Any:
    return message.get(name) if isinstance(message, dict) else getattr(message, name, None)


def _message_role(message: Any) -> str:
    role = str(_message_value(message, "role") or "assistant").lower()
    return role if role in {"system", "user", "assistant", "tool", "summary"} else "assistant"


def _message_raw(message: Any) -> str:
    content = _text(_message_value(message, "content"))
    additions: list[str] = []
    reasoning = _message_value(message, "reasoning_content")
    if reasoning:
        additions.append("[reasoning]\n" + _text(reasoning))
    tool_calls = _message_value(message, "tool_calls")
    if tool_calls:
        normalized = [
            {
                "id": _message_value(call, "id"),
                "name": _message_value(call, "name"),
                "arguments": _message_value(call, "arguments"),
            }
            for call in list(tool_calls)[:100]
        ]
        additions.append("[tool_calls]\n" + _text(normalized))
    return (content + ("\n\n" if content and additions else "") + "\n\n".join(additions))[:MAX_TEXT]


def _context_messages(messages: list[Any], owner_id: str, source: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, message in enumerate(messages[:250]):
        role = _message_role(message)
        raw = _message_raw(message)
        digest = hashlib.sha256(f"{owner_id}:{index}:{role}:{raw}".encode("utf-8")).hexdigest()[:18]
        result.append(
            {
                "id": f"{owner_id}:{digest}",
                "role": role,
                "label": f"{role} message",
                "raw": raw,
                "preview": _redacted_preview(raw),
                "tokens": _estimated_tokens(raw),
                "source": source,
            }
        )
    return result


def _usage(response: Any) -> dict[str, int] | None:
    metadata = _message_value(response, "usage_metadata")
    if metadata is None:
        return None
    if hasattr(metadata, "model_dump"):
        metadata = metadata.model_dump()
    if not isinstance(metadata, dict):
        return None
    fields = {
        "inputTokens": metadata.get("input_tokens", 0),
        "outputTokens": metadata.get("output_tokens", 0),
        "totalTokens": metadata.get("total_tokens", 0),
        "cachedInputTokens": metadata.get("cache_tokens", 0),
        "reasoningTokens": metadata.get("reasoning_tokens", 0),
    }
    normalized = {
        key: value
        for key, value in fields.items()
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
    }
    if not all(key in normalized for key in ("inputTokens", "outputTokens", "totalTokens")):
        return None
    return normalized


def _tool_name(tool: Any) -> str:
    for name in ("name", "id"):
        value = _message_value(tool, name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    function = _message_value(tool, "function")
    value = _message_value(function, "name")
    return value.strip() if isinstance(value, str) and value.strip() else "unknown"


@dataclass(slots=True)
class MemberRuntimeState:
    member_name: str
    role: str
    label: str
    model_calls: int = 0
    react_iterations: int = 0
    total_tokens: int = 0
    invoke_count: int = 0
    registered_tools: set[str] = field(default_factory=set)
    current_model_invocation: str = ""
    current_model_started: float = 0
    last_model_window: list[Any] = field(default_factory=list)
    last_model_response: Any = None


class SwarmTraceEmitter:
    def __init__(self, request: dict[str, Any]) -> None:
        self.invocation_id = request["invocationId"]
        self.team_name = request["teamName"]
        self.session_id = request["sessionId"]
        self.model_id = request["modelId"]
        self.provider_id = request.get("providerId", "openrouter")
        self.provider_label = "OpenRouter" if self.provider_id == "openrouter" else "Deterministic model"
        self.trace_max_tokens = request["traceMaxTokens"]
        self.source_revisions = source_revisions(request.get("sourceRevisions"))
        self.started_at = time.monotonic()
        self.event_number = 0
        self.members: dict[str, MemberRuntimeState] = {}
        self.leader_turns = 0
        self.leader_turn_event = asyncio.Event()

    @property
    def team_subject_id(self) -> str:
        return f"team:{self.team_name}"

    def member_subject_id(self, member_name: str) -> str:
        return f"member:{self.team_name}:{member_name}"

    def context_owner_id(self, member_name: str) -> str:
        return f"context:{self.session_id}:{member_name}"

    def member_state(self, member_name: str, role: str, label: str | None = None) -> MemberRuntimeState:
        existing = self.members.get(member_name)
        if existing:
            if label:
                existing.label = label
            return existing
        state = MemberRuntimeState(
            member_name=member_name,
            role=role,
            label=label or member_name,
            current_model_started=self.started_at,
        )
        self.members[member_name] = state
        return state

    def subject(self, state: MemberRuntimeState) -> dict[str, str]:
        return {
            "id": self.member_subject_id(state.member_name),
            "kind": "member",
            "label": state.label,
            "parentId": self.team_subject_id,
            "role": state.role,
            "contextOwnerId": self.context_owner_id(state.member_name),
        }

    def event(self, kind: str, phase: str, **values: Any) -> None:
        self.event_number += 1
        attach_source_revision(values, self.source_revisions)
        event = {
            "eventId": f"{self.invocation_id}:bridge:{self.event_number}",
            "kind": kind,
            "phase": phase,
            "timestampMs": max(0, round((time.monotonic() - self.started_at) * 1_000)),
            "spanId": values.pop("spanId", f"{self.invocation_id}:team"),
            **values,
        }
        _emit_record({"type": "event", "event": event})

    def model_identity(self, state: MemberRuntimeState) -> dict[str, Any]:
        return {
            "invocationId": state.current_model_invocation,
            "providerId": self.provider_id,
            "modelId": self.model_id,
            "source": "live",
        }

    def hook(
        self,
        state: MemberRuntimeState,
        *,
        callback: str,
        namespace: str,
        examines: list[str],
        mutation: str = "无变更",
        signal: str = "continue",
        noop: bool = False,
    ) -> None:
        self.event(
            "rail.hook",
            "instant",
            title=f"SwarmTraceRail · {state.label} · {callback}",
            summary="成员级显式探针记录了 Rail 审查载荷与控制信号。",
            hook={
                "rail": "SwarmTraceRail",
                "railNodeId": f"swarm-rail:{state.member_name}",
                "callback": callback,
                "priority": TRACE_RAIL_PRIORITY,
                "namespace": namespace,
                "durationMs": 0,
                "mutationDiff": mutation,
                "controlSignal": signal,
                "noop": noop,
                "exact": True,
                "examines": examines[:100],
            },
            subject=self.subject(state),
            spanId=f"{self.invocation_id}:{state.member_name}:rail:{callback}:{self.event_number}",
        )


def _build_trace_rail(symbols: dict[str, Any], emitter: SwarmTraceEmitter, context: Any):
    AgentRail = symbols["AgentRail"]
    InvokeInputs = symbols["InvokeInputs"]
    ModelCallInputs = symbols["ModelCallInputs"]
    ToolCallInputs = symbols["ToolCallInputs"]
    UserMessageInputs = symbols["UserMessageInputs"]
    role_value = getattr(getattr(context, "role", None), "value", getattr(context, "role", None))
    role = str(role_value or "teammate")
    member_name = str(getattr(context, "member_name", None) or ("team_leader" if role == "leader" else "analyst"))
    label = "Team Leader" if role == "leader" else "Analysis Member"
    state = emitter.member_state(member_name, role, label)

    class SwarmTraceRail(AgentRail):
        # Run last so the model sees the final allowlisted schema set after all
        # framework rails have contributed their tools. Tool execution is also
        # denied here as a second boundary if another rail ever reintroduces one.
        priority = TRACE_RAIL_PRIORITY

        async def before_invoke(self, ctx):
            state.invoke_count += 1
            query = ctx.inputs.query if isinstance(ctx.inputs, InvokeInputs) else ""
            emitter.event(
                "swarm.member",
                "start",
                title=f"{state.label} started turn {state.invoke_count}",
                summary="真实 Team member 的 DeepAgent harness 已进入一次执行。",
                subject=emitter.subject(state),
                payload={"status": "running", "teamId": emitter.team_name},
                definition={
                    "repository": "agent-core",
                    "path": "openjiuwen/agent_teams/agent/team_agent.py",
                    "symbol": "TeamAgent",
                },
            )
            emitter.event(
                "agent.invoke",
                "start",
                title=f"{state.label} DeepAgent invoke",
                summary="成员内部真实 ReAct loop 接管当前 Team 输入。",
                subject=emitter.subject(state),
                payload={"turn": state.invoke_count, "queryCharacters": len(_text(query))},
                spanId=f"{emitter.invocation_id}:{state.member_name}:invoke:{state.invoke_count}",
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
                emitter.context_owner_id(state.member_name),
                f"JiuwenSwarm {state.member_name} final ModelContext",
            )
            if serialized:
                emitter.event(
                    "context.snapshot",
                    "instant",
                    title=f"{state.label} final context",
                    summary="当前成员本轮完成后的完整 ModelContext；与其他成员 Context 隔离。",
                    token={"used": state.total_tokens, "delta": 0, "budget": emitter.trace_max_tokens},
                    context={
                        "operation": "replace",
                        "ownerId": emitter.context_owner_id(state.member_name),
                        "messages": serialized,
                    },
                    subject=emitter.subject(state),
                )
            failed = ctx.exception is not None or (
                isinstance(result, dict) and result.get("result_type") == "error"
            )
            emitter.event(
                "agent.invoke",
                "error" if failed else "end",
                title=f"{state.label} turn {'failed' if failed else 'completed'}",
                summary="成员本轮已退出内部 ReAct loop。",
                subject=emitter.subject(state),
                payload={"status": "failed" if failed else "waiting", "turn": state.invoke_count},
                spanId=f"{emitter.invocation_id}:{state.member_name}:invoke:{state.invoke_count}",
            )
            if state.role == "leader":
                emitter.leader_turns += 1
                emitter.leader_turn_event.set()

        async def on_user_message(self, ctx):
            parts = ctx.inputs.parts if isinstance(ctx.inputs, UserMessageInputs) else []
            raw = "\n".join(_text(part) for part in parts)
            emitter.event(
                "agent.user_message",
                "instant",
                title=f"{state.label} admitted input",
                summary="输入经过成员 Rail 后进入该成员独立 Context。",
                subject=emitter.subject(state),
            )
            emitter.event(
                "context.delta",
                "instant",
                title=f"{state.label} input appended",
                context={
                    "operation": "append",
                    "ownerId": emitter.context_owner_id(state.member_name),
                    "messages": [
                        {
                            "id": f"{emitter.context_owner_id(state.member_name)}:input:{state.invoke_count}",
                            "role": "user",
                            "label": "Team input",
                            "raw": raw,
                            "preview": _redacted_preview(raw),
                            "tokens": _estimated_tokens(raw),
                            "source": "JiuwenSwarm member input",
                        }
                    ],
                },
                subject=emitter.subject(state),
            )
            emitter.hook(state, callback="on_user_message", namespace="inner", examines=_chunks(raw))

        async def before_model_call(self, ctx):
            state.model_calls += 1
            state.current_model_invocation = (
                f"{emitter.invocation_id}:{state.member_name}:model:{state.model_calls}"
            )
            state.current_model_started = time.monotonic()
            messages = ctx.inputs.messages if isinstance(ctx.inputs, ModelCallInputs) else []
            incoming_tools = ctx.inputs.tools if isinstance(ctx.inputs, ModelCallInputs) else []
            allowed_tools = ALLOWED_TEAM_TOOLS.get(state.role, ALLOWED_TEAM_TOOLS["teammate"])
            tools = [tool for tool in list(incoming_tools or []) if _tool_name(tool) in allowed_tools]
            if isinstance(ctx.inputs, ModelCallInputs):
                ctx.inputs.tools = tools
            removed = sorted(
                {
                    _tool_name(tool)
                    for tool in list(incoming_tools or [])
                    if _tool_name(tool) not in allowed_tools and _tool_name(tool) != "unknown"
                }
            )
            emitter.hook(
                state,
                callback="before_model_call.tool_allowlist",
                namespace="inner",
                examines=[
                    f"role: {state.role}",
                    f"allowed: {', '.join(sorted(allowed_tools))}",
                    *[f"removed: {name}" for name in removed[:100]],
                ],
                mutation=(
                    f"移除 {len(removed)} 个非团队协作 Tool schema"
                    if removed
                    else "无变更"
                ),
            )
            inspectors = ctx.extra.setdefault("_stream_chunk_inspectors", {})
            if isinstance(inspectors, dict):
                inspectors[f"openjiuwen-visualization-{state.member_name}"] = self._inspect_stream_chunk
            names = sorted({_tool_name(tool) for tool in list(tools or []) if _tool_name(tool) != "unknown"})
            new_names = [name for name in names if name not in state.registered_tools]
            if new_names:
                state.registered_tools.update(new_names)
                emitter.event(
                    "ability.register",
                    "instant",
                    title=f"{state.label} tool schemas registered",
                    summary="仅记录当前真实 Model call 可见的 Tool schema；不从 prompt 推断。",
                    details=[{"label": "tool", "value": name} for name in new_names[:100]],
                    payload={"tools": new_names[:100], "policy": "fixed-team-profile"},
                    subject=emitter.subject(state),
                )
            emitter.event(
                "model.call",
                "start",
                title=f"{state.label} · {emitter.provider_label} call {state.model_calls}",
                summary="成员正在把自己的 ContextWindow 发送到模型。",
                iteration=state.model_calls,
                model={
                    **emitter.model_identity(state),
                    "budget": {"maxTotalTokens": emitter.trace_max_tokens, "currency": "USD"},
                },
                subject=emitter.subject(state),
                spanId=state.current_model_invocation,
            )
            emitter.hook(
                state,
                callback="before_model_call",
                namespace="inner",
                examines=[
                    f"messages: {len(messages)}",
                    f"tool schemas: {len(tools or [])}",
                    *[
                        f"{_message_role(message)} · {_redacted_preview(_message_raw(message))}"
                        for message in list(messages)[:20]
                    ],
                ],
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
                model={**emitter.model_identity(state), "delta": content},
                subject=emitter.subject(state),
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
                emitter.context_owner_id(state.member_name),
                f"JiuwenSwarm {state.member_name} actual model window",
            )
            usage = _usage(response)
            call_tokens = usage["totalTokens"] if usage else sum(message["tokens"] for message in serialized)
            state.total_tokens += call_tokens
            emitter.event(
                "context.snapshot",
                "instant",
                title=f"{state.label} model window {state.model_calls}",
                summary="AFTER_MODEL_CALL 暴露的实际发送窗口；不是跨成员合并视图。",
                iteration=state.model_calls,
                token={"used": state.total_tokens, "delta": call_tokens, "budget": emitter.trace_max_tokens},
                context={
                    "operation": "replace",
                    "ownerId": emitter.context_owner_id(state.member_name),
                    "messages": serialized,
                },
                subject=emitter.subject(state),
            )
            response_text = _text(_message_value(response, "content"))
            tool_calls = list(_message_value(response, "tool_calls") or [])
            details = [
                {
                    "label": "tool call",
                    "value": f"{_message_value(call, 'name')}({_text(_message_value(call, 'arguments'), 3_500)})",
                }
                for call in tool_calls[:20]
            ]
            emitter.event(
                "model.call",
                "end",
                title=f"{state.label} model call {state.model_calls} completed",
                summary="模型选择团队工具分支。" if tool_calls else "模型返回当前成员文本分支。",
                iteration=state.model_calls,
                durationMs=max(0, round((time.monotonic() - state.current_model_started) * 1_000)),
                details=details,
                model={
                    **emitter.model_identity(state),
                    "responseText": response_text,
                    "finishReason": _text(_message_value(response, "finish_reason"), 240) or "unknown",
                },
                subject=emitter.subject(state),
                spanId=state.current_model_invocation,
            )
            if usage:
                emitter.event(
                    "model.usage",
                    "instant",
                    title=f"{state.label} model usage {state.model_calls}",
                    iteration=state.model_calls,
                    token={"used": state.total_tokens, "delta": call_tokens, "budget": emitter.trace_max_tokens},
                    model={**emitter.model_identity(state), "usage": usage},
                    subject=emitter.subject(state),
                    spanId=state.current_model_invocation,
                )

        async def on_model_exception(self, ctx):
            emitter.hook(
                state,
                callback="on_model_exception",
                namespace="inner",
                examines=[f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}"],
                signal="fail",
            )
            emitter.event(
                "model.call",
                "error",
                title=f"{state.label} model call failed",
                summary="模型异常已交由成员 Rail 链处理。",
                model={**emitter.model_identity(state), "finishReason": "error"},
                subject=emitter.subject(state),
                spanId=state.current_model_invocation or f"{emitter.invocation_id}:{state.member_name}:model:error",
            )

        async def before_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            arguments = _text(ctx.inputs.tool_args, MAX_DETAIL)
            allowed_tools = ALLOWED_TEAM_TOOLS.get(state.role, ALLOWED_TEAM_TOOLS["teammate"])
            if tool_name not in allowed_tools:
                message = f"Tool '{tool_name}' is denied by the fixed JiuwenSwarm visualization profile."
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
                    namespace="inner",
                    examines=[f"tool: {tool_name}", *_chunks(arguments, maximum=90)],
                    mutation="阻止非 allowlist 工具执行",
                    signal="deny",
                )
                emitter.event(
                    "tool.call",
                    "error",
                    title=f"{state.label} · {tool_name} denied",
                    summary="固定 Agent Team profile 阻止了非团队协作工具。",
                    details=[{"label": "policy", "value": "fixed-team-tool-allowlist"}],
                    subject=emitter.subject(state),
                    spanId=f"{emitter.invocation_id}:{state.member_name}:tool:{state.model_calls}",
                )
                return
            emitter.hook(
                state,
                callback="before_tool_call",
                namespace="inner",
                examines=[f"tool: {tool_name}", *_chunks(arguments, maximum=90)],
                signal="continue",
            )
            emitter.event(
                "tool.call",
                "start",
                title=f"{state.label} · {tool_name}",
                summary="固定 Team profile 中已注册的工具开始执行。",
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "arguments", "value": arguments or "{}"},
                ],
                subject=emitter.subject(state),
                spanId=f"{emitter.invocation_id}:{state.member_name}:tool:{state.model_calls}",
            )

        async def after_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            result = _text(ctx.inputs.tool_result, MAX_TEXT)
            emitter.event(
                "tool.call",
                "end",
                title=f"{state.label} · {tool_name} completed",
                summary="真实 Team tool 结果已回到该成员的 ReAct Context。",
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "result", "value": result[:MAX_DETAIL] or "(empty)"},
                ],
                subject=emitter.subject(state),
                spanId=f"{emitter.invocation_id}:{state.member_name}:tool:{state.model_calls}",
            )

        async def on_tool_exception(self, ctx):
            tool_name = ctx.inputs.tool_name if isinstance(ctx.inputs, ToolCallInputs) else "unknown"
            emitter.hook(
                state,
                callback="on_tool_exception",
                namespace="inner",
                examines=[
                    f"tool: {tool_name}",
                    f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}",
                ],
                signal="fail",
            )

        async def after_react_iteration(self, ctx):
            del ctx
            state.react_iterations += 1
            emitter.event(
                "agent.react_iteration",
                "end",
                title=f"{state.label} ReAct iteration {state.react_iterations}",
                iteration=state.react_iterations,
                summary="成员完成一次真实 Model/Tool/Observation 决策迭代。",
                subject=emitter.subject(state),
                spanId=f"{emitter.invocation_id}:{state.member_name}:react:{state.react_iterations}",
            )

    return SwarmTraceRail()


def _required_request(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Invalid {name}")
    return value


def _read_request() -> dict[str, Any]:
    value = json.loads(sys.stdin.read())
    if not isinstance(value, dict):
        raise ValueError("Request must be an object")
    request = {
        "invocationId": _required_request(value.get("invocationId"), "invocationId", 240),
        "teamName": _required_request(value.get("teamName"), "teamName", 120),
        "sessionId": _required_request(value.get("sessionId"), "sessionId", 120),
        "modelId": _required_request(value.get("modelId"), "modelId", 240),
        "input": _required_request(value.get("input"), "input", 64_000),
        "systemPrompt": value.get("systemPrompt"),
        "maxOutputTokens": value.get("maxOutputTokens"),
        "maxIterations": value.get("maxIterations"),
        "traceMaxTokens": value.get("traceMaxTokens"),
        "workspace": _required_request(value.get("workspace"), "workspace", 2_000),
        "providerId": value.get("providerId", "openrouter"),
        "modelMode": value.get("modelMode", "live"),
        "sourceRevisions": source_revisions(value.get("sourceRevisions")),
    }
    if request["systemPrompt"] is not None and (
        not isinstance(request["systemPrompt"], str) or len(request["systemPrompt"]) > 32_000
    ):
        raise ValueError("Invalid systemPrompt")
    for name, minimum, maximum in (
        ("maxOutputTokens", 16, 4_096),
        ("maxIterations", 2, 20),
        ("traceMaxTokens", 256, 10_000_000),
    ):
        item = request[name]
        if isinstance(item, bool) or not isinstance(item, int) or not minimum <= item <= maximum:
            raise ValueError(f"Invalid {name}")
    if request["providerId"] not in {"openrouter", "deterministic"}:
        raise ValueError("Invalid providerId")
    return request


def _minimal_swarm_config(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "preferred_language": "zh",
        "models": {
            "default": {
                "model_client_config": {
                    "client_provider": "OpenRouter",
                    "model_name": request["modelId"],
                }
            }
        },
        "react": {
            "context_engine": {"enabled": False},
            "evolution": {"skill_evolution": False},
            "subagents": {
                "statusline-setup": {"enabled": False},
                "browser_agent": {"enabled": False},
                "code_agent": {"enabled": False},
            },
        },
        "symphony": {"skill_retrieval": {"enabled": False}},
        "mcp": {"servers": []},
        "channels": {},
        "hooks": {},
        "plugins": {},
    }


def _model_spec(symbols: dict[str, Any], request: dict[str, Any], role_model_id: str):
    api_key = os.environ.get("OPENJIUWEN_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if request["modelMode"] != "deterministic" and not api_key:
        raise RuntimeError("OpenRouter key is unavailable")
    return symbols["TeamModelConfig"](
        model_client_config=symbols["ModelClientConfig"](
            client_provider="OpenAI" if request["modelMode"] == "deterministic" else "OpenRouter",
            api_key=api_key or "deterministic-self-test",
            api_base="http://127.0.0.1/never-called"
            if request["modelMode"] == "deterministic"
            else "https://openrouter.ai/api/v1",
            timeout=360.0,
            verify_ssl=request["modelMode"] != "deterministic",
            custom_headers={}
            if request["modelMode"] == "deterministic"
            else {
                "HTTP-Referer": os.environ.get(
                    "OPENJIUWEN_OPENROUTER_SITE_URL",
                    "https://github.com/LasVie/OpenJiuwen_Visualization",
                ),
                "X-OpenRouter-Title": os.environ.get(
                    "OPENJIUWEN_OPENROUTER_APP_NAME",
                    "OpenJiuwen Visualization",
                ),
            },
        ),
        model_request_config=symbols["ModelRequestConfig"](
            model=role_model_id,
            temperature=0.1,
            top_p=0.9,
            max_tokens=request["maxOutputTokens"],
        ),
    )


def _install_deterministic_models(symbols: dict[str, Any]) -> None:
    TeamModelConfig = symbols["TeamModelConfig"]
    AssistantMessage = symbols["AssistantMessage"]
    AssistantMessageChunk = symbols["AssistantMessageChunk"]
    UsageMetadata = symbols["UsageMetadata"]
    original_build = TeamModelConfig.build

    def deterministic_build(config):
        model = original_build(config)
        model_name = config.model_request_config.model_name
        content = (
            "Deterministic JiuwenSwarm leader self-test completed."
            if model_name == "deterministic/leader"
            else "Deterministic JiuwenSwarm member is ready."
        )

        def response():
            return AssistantMessage(
                content=content,
                finish_reason="stop",
                usage_metadata=UsageMetadata(
                    model_name=model_name,
                    input_tokens=24,
                    output_tokens=12,
                    total_tokens=36,
                ),
            )

        async def invoke(*args, **kwargs):
            del args, kwargs
            return response()

        async def stream(*args, **kwargs):
            del args, kwargs
            value = response()
            yield AssistantMessageChunk(
                content=value.content,
                finish_reason=value.finish_reason,
                usage_metadata=value.usage_metadata,
            )

        model._client.invoke = invoke
        model._client.stream = stream
        return model

    TeamModelConfig.build = deterministic_build


def _build_team_spec(symbols: dict[str, Any], request: dict[str, Any], emitter: SwarmTraceEmitter):
    workspace = Path(request["workspace"]).resolve(strict=False)
    workspace.mkdir(parents=True, exist_ok=True)
    skills_dir = workspace / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)

    from openjiuwen.agent_teams.paths import configure_openjiuwen_home
    import jiuwenswarm.agents.swarm.assembly as swarm_assembly

    configure_openjiuwen_home(workspace / "openjiuwen-home")
    config = _minimal_swarm_config(request)
    swarm_assembly.get_config = lambda: config
    swarm_assembly.get_agent_skills_dir = lambda: skills_dir

    symbols["register_rail_provider"](
        TRACE_RAIL_TYPE,
        lambda params, context: _build_trace_rail(symbols, emitter, context),
    )
    leader_model_id = "deterministic/leader" if request["modelMode"] == "deterministic" else request["modelId"]
    member_model_id = "deterministic/member" if request["modelMode"] == "deterministic" else request["modelId"]
    RailSpec = symbols["RailSpec"]
    leader_prompt = "\n\n".join(
        part
        for part in (
            request.get("systemPrompt"),
            (
                "You lead a fixed two-member analysis team. Delegate one bounded analysis task "
                "to the predefined member named analyst with create_task, wait for its completion, "
                "then synthesize the final answer. Use only team collaboration tools; never use "
                "filesystem, shell, network, MCP, Skill, Subagent, or SwarmFlow capabilities."
            ),
        )
        if part
    )
    teammate_prompt = (
        "You are the predefined analysis member. Complete only tasks assigned to analyst, "
        "report the result through the available team collaboration tools, and do not use "
        "filesystem, shell, network, MCP, Skill, Subagent, or SwarmFlow capabilities."
    )
    trace_rail = RailSpec(type=TRACE_RAIL_TYPE)
    DeepAgentSpec = symbols["DeepAgentSpec"]
    spec = symbols["TeamAgentSpec"](
        agents={
            "leader": DeepAgentSpec(
                model=_model_spec(symbols, request, leader_model_id),
                system_prompt=leader_prompt,
                rails=[trace_rail],
                tools=[],
                subagents=[],
                mcps=[],
                max_iterations=request["maxIterations"],
                enable_task_loop=True,
                enable_sys_operation=False,
                enable_skill_discovery=False,
                enable_security_rail=True,
                auto_create_workspace=True,
            ),
            "teammate": DeepAgentSpec(
                model=_model_spec(symbols, request, member_model_id),
                system_prompt=teammate_prompt,
                rails=[trace_rail],
                tools=[],
                subagents=[],
                mcps=[],
                max_iterations=request["maxIterations"],
                enable_task_loop=True,
                enable_sys_operation=False,
                enable_skill_discovery=False,
                enable_security_rail=True,
                auto_create_workspace=True,
            ),
        },
        team_name=request["teamName"],
        lifecycle="temporary",
        spawn_mode="inprocess",
        transport=symbols["TransportSpec"](type="inprocess"),
        storage=(
            symbols["StorageSpec"](type="memory")
            if request["modelMode"] == "deterministic"
            else symbols["StorageSpec"](
                type="sqlite",
                params={"connection_string": str(workspace / "team.db")},
            )
        ),
        workspace=symbols["TeamWorkspaceConfig"](
            enabled=False,
            root_path=str(workspace / "team-workspace"),
            version_control=False,
        ),
        leader=symbols["LeaderSpec"](
            member_name="team_leader",
            display_name="Team Leader",
            desc="Coordinates one bounded analysis task and synthesizes the response.",
            prompt=leader_prompt,
        ),
        predefined_members=[
            symbols["TeamMemberSpec"](
                member_name="analyst",
                display_name="Analysis Member",
                desc="Performs the assigned analysis and reports evidence to the leader.",
                prompt=teammate_prompt,
                role_type=symbols["TeamRole"].TEAMMATE,
            )
        ],
        team_mode="predefined",
        dispatch_mode="scheduled",
        teammate_mode="build_mode",
        enable_task_verification=False,
        enable_swarmflow=False,
        enable_permissions=False,
        language="zh",
    )
    symbols["enrich_team_spec_for_swarm"](
        spec,
        session_id=request["sessionId"],
        mode="team",
        project_dir=str(workspace),
        trusted_dirs=[str(workspace)],
        request_id=request["invocationId"],
        channel_id="web",
        request_metadata={"mode": "team", "source": "openjiuwen-visualization"},
    )
    for role in ("leader", "teammate"):
        member_spec = spec.agents[role]
        spec.agents[role] = member_spec.model_copy(
            update={
                "rails": [rail for rail in (member_spec.rails or []) if rail.type in SAFE_SWARM_RAILS],
                "tools": [],
                "subagents": [],
                "mcps": [],
                "enable_sys_operation": False,
                "enable_skill_discovery": False,
            }
        )
    if request["modelMode"] == "deterministic":
        _install_deterministic_models(symbols)
    return spec


def _member_subject(emitter: SwarmTraceEmitter, member: Any) -> tuple[MemberRuntimeState, dict[str, str]]:
    role = str(getattr(member, "role", None) or "teammate")
    state = emitter.member_state(
        str(member.member_name),
        role,
        str(getattr(member, "display_name", None) or member.member_name),
    )
    return state, emitter.subject(state)


async def _emit_monitor_snapshot(emitter: SwarmTraceEmitter, monitor: Any) -> None:
    team_info = await monitor.get_team_info()
    emitter.event(
        "swarm.team",
        "instant",
        title="JiuwenSwarm Agent Team runtime ready",
        summary="Runner 已激活 TeamAgentSpec，TeamMonitor 查询到真实团队状态。",
        subject={"id": emitter.team_subject_id, "kind": "team", "label": getattr(team_info, "display_name", None) or "Visualization Agent Team"},
        payload={"status": "running", "teamId": emitter.team_name, "runId": emitter.session_id},
        definition={
            "repository": "jiuwenswarm",
            "path": "jiuwenswarm/agents/swarm/assembly.py",
            "symbol": "enrich_team_spec_for_swarm",
        },
    )
    for member in await monitor.get_members():
        state, subject = _member_subject(emitter, member)
        emitter.event(
            "swarm.member",
            "instant",
            title=f"{state.label} joined the team",
            summary="TeamMonitor 快照确认该成员已存在于真实 roster。",
            subject=subject,
            payload={
                "status": str(getattr(member, "status", None) or "observed"),
                "executionStatus": str(getattr(member, "execution_status", None) or "unknown"),
                "teamId": emitter.team_name,
            },
            definition={
                "repository": "jiuwenswarm",
                "path": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
                "symbol": "TeamMonitorHandler",
            },
        )
    for task in await monitor.get_tasks():
        await _emit_task_snapshot(emitter, task)


async def _emit_task_snapshot(emitter: SwarmTraceEmitter, task: Any) -> None:
    task_id = str(task.task_id)
    assignee = str(getattr(task, "assignee", None) or "")
    payload = {
        "status": str(getattr(task, "status", None) or "observed"),
        "taskId": task_id,
        "teamId": emitter.team_name,
    }
    if assignee:
        payload["assigneeId"] = emitter.member_subject_id(assignee)
    emitter.event(
        "swarm.task",
        "instant",
        title=str(getattr(task, "title", None) or task_id),
        summary=_redacted_preview(str(getattr(task, "content", None) or "")) or "Team task observed.",
        subject={
            "id": f"task:{emitter.team_name}:{task_id}",
            "kind": "task",
            "label": str(getattr(task, "title", None) or task_id),
            "parentId": emitter.team_subject_id,
        },
        payload=payload,
        definition={
            "repository": "jiuwenswarm",
            "path": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
            "symbol": "TeamMonitorHandler._handle_task",
        },
    )


def _monitor_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in data.items()
        if key not in {"type", "team_id", "member_id", "task_id", "title", "content", "from_member", "to_member"}
        and value is not None
    }


async def _emit_monitor_event(emitter: SwarmTraceEmitter, item: dict[str, Any]) -> None:
    category = item.get("event_type")
    data = item.get("event")
    if not isinstance(data, dict):
        return
    event_type = str(data.get("type") or "observed")
    definition = {
        "repository": "jiuwenswarm",
        "path": "jiuwenswarm/agents/harness/team/handlers/team_monitor_handler.py",
        "symbol": "TeamMonitorHandler._convert_event_to_dict",
    }
    if category == "team.member":
        member_name = str(data.get("member_id") or "unknown")
        role = str(data.get("role") or data.get("mode") or "teammate")
        state = emitter.member_state(member_name, role, str(data.get("name") or member_name))
        status = str(data.get("new_status") or data.get("status") or event_type.rsplit(".", 1)[-1])
        emitter.event(
            "swarm.member",
            "instant",
            title=f"{state.label} · {event_type}",
            summary="JiuwenSwarm TeamMonitorHandler 转换的真实成员事件。",
            subject=emitter.subject(state),
            payload={"status": status, "teamId": emitter.team_name, "eventType": event_type, **_monitor_payload(data)},
            definition=definition,
        )
        return
    if category == "team.task":
        task_id = str(data.get("task_id") or "unknown")
        assignee = str(data.get("member_id") or "")
        payload = {
            "status": str(data.get("status") or event_type.rsplit(".", 1)[-1]),
            "taskId": task_id,
            "teamId": emitter.team_name,
            "eventType": event_type,
            **_monitor_payload(data),
        }
        if assignee:
            payload["assigneeId"] = emitter.member_subject_id(assignee)
        content = str(data.get("content") or "")
        emitter.event(
            "swarm.task",
            "instant",
            title=str(data.get("title") or f"Task {task_id}"),
            summary=_redacted_preview(content) or f"JiuwenSwarm task event · {event_type}",
            details=[{"label": "task content", "value": content[:MAX_DETAIL]}] if content else [],
            subject={
                "id": f"task:{emitter.team_name}:{task_id}",
                "kind": "task",
                "label": str(data.get("title") or f"Task {task_id}"),
                "parentId": emitter.team_subject_id,
            },
            payload=payload,
            definition=definition,
        )
        return
    if category == "team.message":
        sender = str(data.get("from_member") or "team_leader")
        recipient = str(data.get("to_member") or "")
        sender_state = emitter.member_state(sender, "leader" if sender == "team_leader" else "teammate")
        from_subject = emitter.member_subject_id(sender)
        to_subject = emitter.member_subject_id(recipient) if recipient else emitter.team_subject_id
        content = str(data.get("content") or "")
        emitter.event(
            "swarm.message",
            "instant",
            title=f"{sender_state.label} · {event_type}",
            summary=_redacted_preview(content) or "Team message observed.",
            details=[{"label": "message", "value": content[:MAX_DETAIL]}] if content else [],
            subject=emitter.subject(sender_state),
            payload={
                "status": "delivered",
                "teamId": emitter.team_name,
                "eventType": event_type,
                "fromSubjectId": from_subject,
                "toSubjectId": to_subject,
                "protocol": str(data.get("protocol") or "plain"),
            },
            definition=definition,
        )


async def _drain_monitor(emitter: SwarmTraceEmitter, handler: Any) -> None:
    current = asyncio.current_task()
    if current is not None:
        handler.set_consumer_task(current)
    async for item in handler.events():
        await _emit_monitor_event(emitter, item)


async def _wait_for_team_turn(
    emitter: SwarmTraceEmitter,
    monitor: Any,
) -> None:
    await asyncio.wait_for(emitter.leader_turn_event.wait(), timeout=RUN_TIMEOUT_SECONDS)
    first_turns = emitter.leader_turns
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        tasks = await monitor.get_tasks()
        if not tasks:
            await asyncio.sleep(0.5)
            return
        if all(str(task.status) in {"completed", "cancelled"} for task in tasks):
            if emitter.leader_turns > first_turns:
                await asyncio.sleep(0.5)
                return
        await asyncio.sleep(0.25)
    return


async def _run(request: dict[str, Any]) -> None:
    symbols = _runtime_symbols()
    emitter = SwarmTraceEmitter(request)
    spec = _build_team_spec(symbols, request, emitter)
    Runner = symbols["Runner"]
    TeamMonitorHandler = symbols["TeamMonitorHandler"]
    emitter.event(
        "trace.status",
        "start",
        title="JiuwenSwarm trace started",
        summary="固定子进程开始装配真实 JiuwenSwarm Agent Team。",
    )
    emitter.event(
        "swarm.team",
        "start",
        title="JiuwenSwarm Agent Team assembly",
        summary="enrich_team_spec_for_swarm 已应用受控 provider profile；当前不是 SwarmFlow。",
        subject={"id": emitter.team_subject_id, "kind": "team", "label": "Visualization Agent Team"},
        payload={
            "status": "planned",
            "teamId": emitter.team_name,
            "runId": emitter.session_id,
            "teamMode": "predefined",
            "dispatchMode": "scheduled",
            "swarmFlow": False,
        },
        definition={
            "repository": "jiuwenswarm",
            "path": "jiuwenswarm/agents/swarm/assembly.py",
            "symbol": "enrich_team_spec_for_swarm",
        },
    )
    monitor_handler = None
    monitor_task = None
    stream_task = None
    await Runner.start()
    try:
        runtime_ready = asyncio.get_running_loop().create_future()

        async def consume_stream() -> None:
            try:
                async for chunk in Runner.run_agent_team_streaming(
                    agent_team=spec,
                    inputs={"query": request["input"], "request_id": request["invocationId"]},
                    session=request["sessionId"],
                ):
                    payload = getattr(chunk, "payload", None)
                    if (
                        isinstance(payload, dict)
                        and payload.get("event_type") == "team.runtime_ready"
                        and not runtime_ready.done()
                    ):
                        runtime_ready.set_result(payload)
            except BaseException as exc:
                if not runtime_ready.done():
                    runtime_ready.set_exception(exc)
                raise

        stream_task = asyncio.create_task(consume_stream(), name="visualization-swarm-stream")
        ready_payload = await asyncio.wait_for(runtime_ready, timeout=90)
        emitter.event(
            "swarm.team",
            "instant",
            title="Agent Team runtime activated",
            summary="Runner.run_agent_team_streaming emitted team.runtime_ready.",
            subject={"id": emitter.team_subject_id, "kind": "team", "label": "Visualization Agent Team"},
            payload={
                "status": "running",
                "teamId": emitter.team_name,
                "runId": emitter.session_id,
                "activationKind": str(ready_payload.get("activation_kind") or "unknown"),
            },
            definition={
                "repository": "agent-core",
                "path": "openjiuwen/core/runner/team_runner.py",
                "symbol": "Runner.run_agent_team_streaming",
            },
        )
        monitor = await Runner.get_agent_team_monitor(
            team_name=request["teamName"],
            session_id=request["sessionId"],
        )
        if monitor is None:
            raise RuntimeError("TeamMonitor is unavailable after runtime_ready")
        monitor_handler = TeamMonitorHandler(monitor, request["sessionId"])
        await monitor_handler.start()
        await _emit_monitor_snapshot(emitter, monitor)
        monitor_task = asyncio.create_task(_drain_monitor(emitter, monitor_handler), name="visualization-swarm-monitor")
        await asyncio.wait_for(_wait_for_team_turn(emitter, monitor), timeout=RUN_TIMEOUT_SECONDS)
        await Runner.stop_agent_team(team_name=request["teamName"], session_id=request["sessionId"])
        if stream_task and not stream_task.done():
            stream_task.cancel()
        if stream_task:
            with contextlib.suppress(asyncio.CancelledError):
                await stream_task
        if monitor_handler is not None:
            await monitor_handler.stop()
            monitor_handler = None
        if monitor_task is not None:
            if not monitor_task.done():
                monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitor_task
            monitor_task = None
        emitter.event(
            "swarm.team",
            "end",
            title="JiuwenSwarm Agent Team completed",
            summary="固定 Agent Team 已停止，成员、任务、消息与独立 Context 证据已归一化。",
            subject={"id": emitter.team_subject_id, "kind": "team", "label": "Visualization Agent Team"},
            payload={"status": "completed", "teamId": emitter.team_name, "runId": emitter.session_id},
        )
        emitter.event(
            "trace.status",
            "end",
            title="JiuwenSwarm trace complete",
            summary="本次运行使用真实 JiuwenSwarm provider assembly 与 Agent Core Team runtime。",
        )
    finally:
        if monitor_handler is not None:
            await monitor_handler.stop()
        if monitor_task is not None and not monitor_task.done():
            monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitor_task
        if stream_task is not None:
            if not stream_task.done():
                stream_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await stream_task
        with contextlib.suppress(Exception):
            await Runner.stop_agent_team(team_name=request["teamName"], session_id=request["sessionId"])
        await Runner.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args(argv)
    if arguments.probe:
        return _probe()
    try:
        if arguments.self_test:
            runtime_workspace = (Path.cwd() / ".jiuwenswarm-runtime-self-test").resolve()
            runtime_workspace.mkdir(parents=True, exist_ok=True)
            request = {
                "invocationId": "jiuwenswarm-self-test",
                "teamName": "visualization_self_test",
                "sessionId": "session_self_test",
                "modelId": "deterministic/leader",
                "providerId": "deterministic",
                "modelMode": "deterministic",
                "input": "Run the deterministic JiuwenSwarm Agent Team self-test.",
                "systemPrompt": "Exercise the real provider assembly and Agent Team path.",
                "maxOutputTokens": 128,
                "maxIterations": 4,
                "traceMaxTokens": 32_768,
                "workspace": str(runtime_workspace),
            }
        else:
            request = _read_request()
        asyncio.run(_run(request))
        if arguments.self_test:
            required = {
                "agent.invoke",
                "agent.user_message",
                "context.delta",
                "context.snapshot",
                "model.call",
                "model.usage",
                "rail.hook",
                "swarm.member",
                "swarm.team",
                "trace.status",
            }
            observed = {kind for kind, _phase in _OBSERVED_EVENTS}
            missing = sorted(required - observed)
            if missing or ("trace.status", "end") not in _OBSERVED_EVENTS:
                raise RuntimeError(
                    "JiuwenSwarm self-test event coverage failed: "
                    + (", ".join(missing) if missing else "terminal event missing")
                )
            if not {"team", "member"}.issubset(_OBSERVED_SUBJECT_KINDS):
                raise RuntimeError("JiuwenSwarm self-test subject hierarchy is incomplete")
            expected_leader_tools = ALLOWED_TEAM_TOOLS["leader"]
            if _OBSERVED_REGISTERED_TOOLS != expected_leader_tools:
                raise RuntimeError(
                    "JiuwenSwarm self-test tool boundary failed: "
                    + ", ".join(sorted(_OBSERVED_REGISTERED_TOOLS))
                )
            leader_owner = "context:session_self_test:team_leader"
            final_raw = "\n".join(
                _text(message.get("raw")) for message in _LAST_CONTEXT_BY_OWNER.get(leader_owner, [])
            )
            if "Deterministic JiuwenSwarm leader self-test completed." not in final_raw:
                raise RuntimeError("JiuwenSwarm self-test final leader context is incomplete")
    except Exception as exc:
        _emit_record(
            {
                "type": "error",
                "code": "jiuwenswarm_bridge_failed",
                "message": f"JiuwenSwarm bridge failed with {type(exc).__name__}.",
            }
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
