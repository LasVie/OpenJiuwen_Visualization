"""Fixed JSON-line bridge for a real foreground Agent Core Subagent run.

One parent DeepAgent delegates exactly one task through the framework-owned
``task_tool`` to one child DeepAgent.  Both model-visible tool sets are filtered
again at the final Rail boundary, and the child has no repository or network
capability.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from runtime_source_identity import attach_source_revision, source_revisions

from agent_core_bridge import (
    _chunks,
    _estimated_tokens,
    _message_raw,
    _message_role,
    _message_value,
    _redacted_preview,
    _text,
    _usage,
)


RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
MAX_TEXT = 1_000_000
MAX_DETAIL = 4_000
TRACE_RAIL_PRIORITY = -1_000_000
_OBSERVED_EVENTS: list[tuple[str, str]] = []
_OBSERVED_SUBJECT_KINDS: set[str] = set()
_OBSERVED_TOOLS: dict[str, set[str]] = {"parent": set(), "child": set()}
_LAST_CONTEXT_BY_OWNER: dict[str, list[dict[str, Any]]] = {}
_OBSERVED_CHILD_SESSION = ""

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _emit_record(value: dict[str, Any]) -> None:
    global _OBSERVED_CHILD_SESSION
    event = value.get("event") if value.get("type") == "event" else None
    if isinstance(event, dict):
        _OBSERVED_EVENTS.append((str(event.get("kind")), str(event.get("phase"))))
        subject = event.get("subject")
        if isinstance(subject, dict) and isinstance(subject.get("kind"), str):
            _OBSERVED_SUBJECT_KINDS.add(subject["kind"])
        context = event.get("context")
        if (
            event.get("kind") == "context.snapshot"
            and isinstance(context, dict)
            and context.get("operation") == "replace"
            and isinstance(context.get("ownerId"), str)
            and isinstance(context.get("messages"), list)
        ):
            _LAST_CONTEXT_BY_OWNER[context["ownerId"]] = list(context["messages"])
        if event.get("kind") == "ability.register" and isinstance(event.get("payload"), dict):
            role = event["payload"].get("role")
            tools = event["payload"].get("tools")
            if role in _OBSERVED_TOOLS and isinstance(tools, list):
                _OBSERVED_TOOLS[role].update(str(tool) for tool in tools)
        if event.get("kind") == "swarm.subagent" and event.get("phase") == "start":
            observation = event.get("subagent")
            if isinstance(observation, dict):
                _OBSERVED_CHILD_SESSION = str(observation.get("sessionId") or "")
    print(RECORD_PREFIX + json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _runtime_symbols() -> dict[str, Any]:
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
    from openjiuwen.core.foundation.tool import tool
    from openjiuwen.core.runner import Runner
    from openjiuwen.core.single_agent.rail.base import (
        AgentRail,
        InvokeInputs,
        ModelCallInputs,
        ToolCallInputs,
        UserMessageInputs,
    )
    from openjiuwen.core.single_agent.schema.agent_card import AgentCard
    from openjiuwen.harness import create_deep_agent
    from openjiuwen.harness.schema.config import SubAgentConfig

    return {
        "AssistantMessage": AssistantMessage,
        "AssistantMessageChunk": AssistantMessageChunk,
        "Model": Model,
        "ModelClientConfig": ModelClientConfig,
        "ModelRequestConfig": ModelRequestConfig,
        "ToolCall": ToolCall,
        "ToolMessage": ToolMessage,
        "UsageMetadata": UsageMetadata,
        "tool": tool,
        "Runner": Runner,
        "AgentRail": AgentRail,
        "InvokeInputs": InvokeInputs,
        "ModelCallInputs": ModelCallInputs,
        "ToolCallInputs": ToolCallInputs,
        "UserMessageInputs": UserMessageInputs,
        "AgentCard": AgentCard,
        "SubAgentConfig": SubAgentConfig,
        "create_deep_agent": create_deep_agent,
    }


def _probe() -> int:
    try:
        _runtime_symbols()
    except ModuleNotFoundError as exc:
        dependency = (exc.name or "unknown").split(".", 1)[0]
        _emit_record({
            "type": "probe",
            "ready": False,
            "code": "subagent_dependency_unavailable",
            "message": f"Agent Core Subagent dependency is unavailable: {dependency}.",
        })
        return 1
    except Exception as exc:
        _emit_record({
            "type": "probe",
            "ready": False,
            "code": "subagent_import_failed",
            "message": f"Agent Core Subagent import failed with {type(exc).__name__}.",
        })
        return 1
    _emit_record({
        "type": "probe",
        "ready": True,
        "code": "ready",
        "message": "Agent Core DeepAgent, SubAgentConfig, and TaskTool imports succeeded.",
        "frameworkVersion": "source-checkout",
    })
    return 0


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            return function["name"]
        if isinstance(tool.get("name"), str):
            return tool["name"]
    name = getattr(tool, "name", None)
    return str(name) if name else "unknown"


def _context_messages(
    messages: list[Any],
    owner_id: str,
    source: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, message in enumerate(messages[:250]):
        role = _message_role(message)
        raw = _message_raw(message)
        digest = hashlib.sha256(
            f"{owner_id}:{index}:{role}:{raw}".encode("utf-8")
        ).hexdigest()[:18]
        result.append({
            "id": f"{owner_id}:message:{digest}",
            "role": role,
            "label": f"{role} message",
            "raw": raw,
            "preview": _redacted_preview(raw),
            "tokens": _estimated_tokens(raw),
            "source": source,
        })
    return result


def _result_text(result: Any) -> str:
    if isinstance(result, dict):
        return _text(result.get("output") or result.get("data") or result)
    return _text(result)


class SubagentTraceEmitter:
    def __init__(
        self,
        request: dict[str, Any],
        *,
        role: str,
        invocation_id: str,
        subject: dict[str, str],
        context_owner_id: str,
        allowed_tools: set[str],
    ) -> None:
        self.root_invocation_id = request["invocationId"]
        self.invocation_id = invocation_id
        self.role = role
        self.subject = subject
        self.context_owner_id = context_owner_id
        self.allowed_tools = allowed_tools
        self.model_id = request["modelId"]
        self.provider_id = request.get("providerId", "openrouter")
        self.provider_label = "OpenRouter" if self.provider_id == "openrouter" else "Deterministic model"
        self.trace_max_tokens = request["traceMaxTokens"]
        self.source_revisions = source_revisions(request.get("sourceRevisions"))
        self.started_at = request.setdefault("_startedAt", time.monotonic())
        self.event_number = 0
        self.model_call_number = 0
        self.react_iteration = 0
        self.invoke_count = 0
        self.total_tokens = 0
        self.current_model_invocation = f"{invocation_id}:model:0"
        self.current_model_started = self.started_at
        self.last_model_window: list[Any] = []
        self.last_model_response: Any = None
        self.registered_tools: set[str] = set()
        self.allowed_tool_calls = 0
        self.child_session_id = ""
        self.child_started = False
        self.child_finished = False
        self.parent_tool_span_id = f"{request['invocationId']}:parent:tool:1"

    def event(self, kind: str, phase: str, **values: Any) -> None:
        self.event_number += 1
        attach_source_revision(values, self.source_revisions)
        if kind != "trace.status":
            values.setdefault("subject", self.subject)
        context = values.get("context")
        if isinstance(context, dict):
            context.setdefault("ownerId", self.context_owner_id)
        event = {
            "eventId": f"{self.invocation_id}:bridge:{self.event_number}",
            "kind": kind,
            "phase": phase,
            "timestampMs": max(0, round((time.monotonic() - self.started_at) * 1_000)),
            "spanId": values.pop("spanId", f"{self.invocation_id}:agent"),
            **values,
        }
        _emit_record({"type": "event", "event": event})

    def model_identity(self) -> dict[str, Any]:
        return {
            "invocationId": self.current_model_invocation,
            "providerId": self.provider_id,
            "modelId": self.model_id,
            "source": "live",
        }

    def hook(
        self,
        *,
        callback: str,
        examines: list[str],
        rail_node_id: str = "rail-context",
        mutation: str = "无变更",
        signal: str = "continue",
        namespace: str = "inner",
    ) -> None:
        self.event(
            "rail.hook",
            "instant",
            title=f"SubagentBoundaryRail · {self.role} · {callback}",
            summary="最终边界 Rail 记录了审查内容、schema 变更和控制信号。",
            hook={
                "rail": "SubagentBoundaryRail",
                "railNodeId": rail_node_id,
                "callback": callback,
                "priority": TRACE_RAIL_PRIORITY,
                "namespace": namespace,
                "durationMs": 0,
                "mutationDiff": mutation,
                "controlSignal": signal,
                "noop": mutation == "无变更",
                "exact": True,
                "examines": examines[:100],
            },
            activeNodeIds=[rail_node_id],
            spanId=f"{self.invocation_id}:rail:{callback}:{self.event_number + 1}",
        )

    def observation(self, request: dict[str, Any], *, result: str = "", error: str = "") -> dict[str, Any]:
        value: dict[str, Any] = {
            "invocationId": request["childInvocationId"],
            "subagentType": request["childType"],
            "dispatcher": "task-tool",
            "runMode": "foreground",
            "parentSessionId": request["parentSessionId"],
            "sessionId": self.child_session_id,
            "contextOwnerId": request["childContextOwnerId"],
            "sessionPolicy": "ephemeral",
            "workspaceIsolation": "subdirectory",
            "toolPolicy": "configured",
            "toolCallSpanId": self.parent_tool_span_id,
        }
        if result:
            value["resultPreview"] = _redacted_preview(result)[:4_000]
        if error:
            value["error"] = error[:4_000]
        return value


def _build_trace_rail(
    symbols: dict[str, Any],
    emitter: SubagentTraceEmitter,
    request: dict[str, Any],
):
    AgentRail = symbols["AgentRail"]
    InvokeInputs = symbols["InvokeInputs"]
    ModelCallInputs = symbols["ModelCallInputs"]
    ToolCallInputs = symbols["ToolCallInputs"]
    UserMessageInputs = symbols["UserMessageInputs"]
    ToolMessage = symbols["ToolMessage"]

    class SubagentBoundaryRail(AgentRail):
        # Agent Core executes larger priorities first.  This rail must run last
        # so it filters the complete schema list produced by framework rails.
        priority = TRACE_RAIL_PRIORITY

        async def before_invoke(self, ctx):
            emitter.invoke_count += 1
            query = ctx.inputs.query if isinstance(ctx.inputs, InvokeInputs) else ""
            if emitter.role == "child" and not emitter.child_started:
                emitter.child_session_id = str(
                    getattr(ctx.inputs, "conversation_id", None) or "unknown-child-session"
                )
                emitter.child_started = True
                emitter.event(
                    "swarm.subagent",
                    "start",
                    title="TaskTool child started",
                    summary="TaskTool 已创建独立 child DeepAgent、sub-session 与 workspace 子目录。",
                    subagent=emitter.observation(request),
                    parentSpanId=emitter.parent_tool_span_id,
                    spanId=request["childInvocationId"],
                    definition={
                        "repository": "agent-core",
                        "path": "openjiuwen/harness/tools/subagent/task_tool.py",
                        "symbol": "TaskTool.invoke",
                    },
                )
            emitter.event(
                "agent.invoke",
                "start",
                title=f"{emitter.role.title()} DeepAgent invoke",
                summary=(
                    "父 DeepAgent ReAct loop 开始调度前台子任务。"
                    if emitter.role == "parent"
                    else "子 DeepAgent 在独立 Context 中开始执行委派任务。"
                ),
                payload={"role": emitter.role, "queryCharacters": len(_text(query))},
            )
            emitter.hook(
                callback="before_invoke",
                namespace="outer",
                rail_node_id="rail-init",
                examines=[
                    f"role: {emitter.role}",
                    f"query characters: {len(_text(query))}",
                    "foreground: true",
                    "max depth: 1",
                ],
            )

        async def after_invoke(self, ctx):
            result = ctx.inputs.result if isinstance(ctx.inputs, InvokeInputs) else None
            model_context = getattr(ctx, "context", None)
            context_messages = list(model_context.get_messages()) if model_context is not None else []
            final_messages = list(emitter.last_model_window or context_messages)
            if emitter.last_model_response is not None:
                final_messages.append(emitter.last_model_response)
            serialized = _context_messages(
                final_messages,
                emitter.context_owner_id,
                f"Subagent runtime {emitter.role} final ModelContext",
            )
            if serialized:
                emitter.event(
                    "context.snapshot",
                    "instant",
                    title=f"{emitter.role.title()} final context",
                    summary="该 Agent 完成后的完整 ModelContext；原文只存在于 Context 数据中。",
                    token={"used": emitter.total_tokens, "delta": 0, "budget": emitter.trace_max_tokens},
                    context={"operation": "replace", "messages": serialized},
                    activeNodeIds=["context", "output"],
                )
            failed = ctx.exception is not None or (
                isinstance(result, dict) and result.get("result_type") == "error"
            )
            result_text = _result_text(result)
            emitter.hook(
                callback="after_invoke",
                namespace="outer",
                rail_node_id="rail-trajectory",
                examines=[
                    f"role: {emitter.role}",
                    f"react iterations: {emitter.react_iteration}",
                    f"processed tokens: {emitter.total_tokens}",
                    f"result characters: {len(result_text)}",
                ],
                signal="fail" if failed else "continue",
            )
            emitter.event(
                "agent.invoke",
                "error" if failed else "end",
                title=f"{emitter.role.title()} DeepAgent {'failed' if failed else 'completed'}",
                summary="当前 Agent 已退出自己的 ReAct loop。",
                payload={"role": emitter.role, "status": "failed" if failed else "completed"},
            )
            if emitter.role == "child" and emitter.child_started and not emitter.child_finished:
                emitter.child_finished = True
                emitter.event(
                    "swarm.subagent",
                    "error" if failed else "end",
                    title="TaskTool child failed" if failed else "TaskTool child completed",
                    summary="子 Agent 最终结果返回父侧 task_tool。",
                    subagent=emitter.observation(
                        request,
                        result=result_text if not failed else "",
                        error="child invoke failed" if failed else "",
                    ),
                    parentSpanId=emitter.parent_tool_span_id,
                    spanId=request["childInvocationId"],
                    definition={
                        "repository": "agent-core",
                        "path": "openjiuwen/harness/tools/subagent/task_tool.py",
                        "symbol": "TaskTool.invoke",
                    },
                )

        async def on_user_message(self, ctx):
            parts = ctx.inputs.parts if isinstance(ctx.inputs, UserMessageInputs) else []
            raw = "\n".join(_text(part) for part in parts)
            emitter.event(
                "agent.user_message",
                "instant",
                title=f"{emitter.role.title()} input admitted",
                summary="输入经过当前 Agent Rail 后进入其独立 Context。",
            )
            emitter.event(
                "context.delta",
                "instant",
                title=f"{emitter.role.title()} input appended",
                context={
                    "operation": "append",
                    "messages": [{
                        "id": f"{emitter.context_owner_id}:input:{emitter.invoke_count}",
                        "role": "user",
                        "label": f"{emitter.role.title()} input",
                        "raw": raw,
                        "preview": _redacted_preview(raw),
                        "tokens": _estimated_tokens(raw),
                        "source": f"Subagent runtime {emitter.role} input",
                    }],
                },
                activeNodeIds=["input", "context"],
            )
            emitter.hook(
                callback="on_user_message",
                rail_node_id="rail-safety",
                examines=_chunks(raw),
                mutation="无变更 · 原文仅写入本 Agent Context",
            )

        async def before_model_call(self, ctx):
            if not isinstance(ctx.inputs, ModelCallInputs):
                return
            emitter.model_call_number += 1
            emitter.current_model_invocation = (
                f"{emitter.invocation_id}:model:{emitter.model_call_number}"
            )
            emitter.current_model_started = time.monotonic()
            messages = list(ctx.inputs.messages or [])
            incoming_tools = list(ctx.inputs.tools or [])
            tools = [tool for tool in incoming_tools if _tool_name(tool) in emitter.allowed_tools]
            ctx.inputs.tools = tools
            removed = sorted({
                _tool_name(tool) for tool in incoming_tools
                if _tool_name(tool) not in emitter.allowed_tools and _tool_name(tool) != "unknown"
            })
            emitter.hook(
                callback="before_model_call.tool_allowlist",
                examines=[
                    f"role: {emitter.role}",
                    f"allowed: {', '.join(sorted(emitter.allowed_tools))}",
                    *[f"removed: {name}" for name in removed],
                ],
                mutation=f"移除 {len(removed)} 个非 profile Tool schema" if removed else "无变更",
            )
            inspectors = ctx.extra.setdefault("_stream_chunk_inspectors", {})
            if isinstance(inspectors, dict):
                inspectors[f"openjiuwen-visualization-subagent-{emitter.role}"] = self._inspect_stream_chunk
            names = sorted({_tool_name(tool) for tool in tools if _tool_name(tool) != "unknown"})
            new_names = [name for name in names if name not in emitter.registered_tools]
            if new_names:
                emitter.registered_tools.update(new_names)
                emitter.event(
                    "ability.register",
                    "instant",
                    title=f"{emitter.role.title()} visible tool schemas",
                    summary="只记录当前实际 Model call 可见的最终 Tool schema。",
                    details=[{"label": "tool", "value": name} for name in new_names],
                    payload={"role": emitter.role, "tools": new_names, "policy": "fixed-subagent-profile"},
                    activeNodeIds=["tool"],
                )
            emitter.event(
                "model.call",
                "start",
                title=f"{emitter.role.title()} · {emitter.provider_label} call {emitter.model_call_number}",
                summary="当前 Agent 正在发送自己的 ContextWindow。",
                iteration=emitter.model_call_number,
                model={
                    **emitter.model_identity(),
                    "budget": {"maxTotalTokens": emitter.trace_max_tokens, "currency": "USD"},
                },
                activeNodeIds=["context", "model"],
                spanId=emitter.current_model_invocation,
            )
            emitter.hook(
                callback="before_model_call",
                examines=[
                    f"messages: {len(messages)}",
                    f"tool schemas: {len(tools)}",
                    *[
                        f"{_message_role(message)} · {_redacted_preview(_message_raw(message))}"
                        for message in messages[:20]
                    ],
                ],
            )

        async def _inspect_stream_chunk(self, ctx, chunk):
            del ctx
            content = _text(getattr(chunk, "content", ""))
            if content:
                emitter.event(
                    "model.stream",
                    "instant",
                    title=f"{emitter.role.title()} model stream delta",
                    iteration=emitter.model_call_number,
                    model={**emitter.model_identity(), "delta": content},
                    activeNodeIds=["model"],
                    spanId=emitter.current_model_invocation,
                )

        async def after_model_call(self, ctx):
            if not isinstance(ctx.inputs, ModelCallInputs):
                return
            messages = list(ctx.inputs.messages or [])
            emitter.last_model_window = messages
            response = ctx.inputs.response
            emitter.last_model_response = response
            serialized = _context_messages(
                messages,
                emitter.context_owner_id,
                f"Subagent runtime {emitter.role} actual model window",
            )
            usage = _usage(response)
            call_tokens = usage["totalTokens"] if usage else sum(message["tokens"] for message in serialized)
            emitter.total_tokens += call_tokens
            emitter.event(
                "context.snapshot",
                "instant",
                title=f"{emitter.role.title()} model window {emitter.model_call_number}",
                summary="AFTER_MODEL_CALL 暴露的实际发送窗口；父子 Context 不合并。",
                iteration=emitter.model_call_number,
                token={"used": emitter.total_tokens, "delta": call_tokens, "budget": emitter.trace_max_tokens},
                context={"operation": "replace", "messages": serialized},
                activeNodeIds=["context"],
            )
            response_text = _text(_message_value(response, "content"))
            tool_calls = list(_message_value(response, "tool_calls") or [])
            emitter.event(
                "model.call",
                "end",
                title=f"{emitter.role.title()} model call {emitter.model_call_number} completed",
                summary="模型选择 Tool 分支。" if tool_calls else "模型返回当前 Agent 文本分支。",
                iteration=emitter.model_call_number,
                durationMs=max(0, round((time.monotonic() - emitter.current_model_started) * 1_000)),
                details=[{
                    "label": "tool call",
                    "value": f"{_message_value(call, 'name')}({_redacted_preview(_text(_message_value(call, 'arguments')))})",
                } for call in tool_calls[:20]],
                model={
                    **emitter.model_identity(),
                    "responseText": response_text,
                    "finishReason": _text(_message_value(response, "finish_reason"), 240) or "unknown",
                },
                activeNodeIds=["model", "decision"],
                spanId=emitter.current_model_invocation,
            )
            if usage:
                emitter.event(
                    "model.usage",
                    "instant",
                    title=f"{emitter.role.title()} model usage {emitter.model_call_number}",
                    iteration=emitter.model_call_number,
                    token={"used": emitter.total_tokens, "delta": call_tokens, "budget": emitter.trace_max_tokens},
                    model={**emitter.model_identity(), "usage": usage},
                    activeNodeIds=["model"],
                    spanId=emitter.current_model_invocation,
                )

        async def on_model_exception(self, ctx):
            emitter.hook(
                callback="on_model_exception",
                rail_node_id="rail-retry",
                examines=[f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}"],
                signal="fail",
            )
            emitter.event(
                "model.call",
                "error",
                title=f"{emitter.role.title()} model call failed",
                summary="模型异常已交给 Agent Core Rail 链。",
                model={**emitter.model_identity(), "finishReason": "error"},
                spanId=emitter.current_model_invocation,
            )

        async def before_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            arguments = _text(ctx.inputs.tool_args, MAX_TEXT)
            allowed = tool_name in emitter.allowed_tools
            profile_error = ""
            tool_args = ctx.inputs.tool_args
            if isinstance(tool_args, str):
                try:
                    parsed_tool_args = json.loads(tool_args)
                except json.JSONDecodeError:
                    parsed_tool_args = None
                tool_args = parsed_tool_args
            if allowed and emitter.allowed_tool_calls >= 1:
                profile_error = "The fixed profile permits exactly one tool call for this agent."
            elif allowed and not isinstance(tool_args, dict):
                profile_error = "Tool arguments must be a structured object."
            elif emitter.role == "parent" and tool_name == "task_tool":
                if tool_args.get("subagent_type") != request["childType"]:
                    profile_error = "The fixed child type cannot be changed."
                elif tool_args.get("task_description") != request["input"]:
                    profile_error = "The complete input must be delegated without mutation."
            elif emitter.role == "child" and tool_name == "inspect_delegated_task":
                if tool_args.get("text") != request["input"]:
                    profile_error = "The complete delegated input must be inspected without mutation."
            allowed = allowed and not profile_error
            if not allowed:
                message = profile_error or f"Tool '{tool_name}' is denied by the fixed Subagent profile."
                tool_call_id = _text(_message_value(ctx.inputs.tool_call, "id"), 240)
                ctx.extra["_skip_tool"] = True
                ctx.inputs.tool_result = {"error": message}
                ctx.inputs.tool_msg = ToolMessage(content=message, tool_call_id=tool_call_id)
            else:
                emitter.allowed_tool_calls += 1
            if emitter.role == "parent" and tool_name == "task_tool":
                emitter.parent_tool_span_id = (
                    f"{emitter.invocation_id}:tool:{emitter.model_call_number}"
                )
            emitter.hook(
                callback="before_tool_call",
                rail_node_id="rail-tool",
                examines=[
                    f"tool: {tool_name}",
                    f"argument characters: {len(arguments)}",
                    f"argument preview: {_redacted_preview(arguments)}",
                ],
                mutation="无变更 · 命中固定 profile" if allowed else "阻止非 allowlist 工具执行",
                signal="continue" if allowed else "deny",
            )
            emitter.event(
                "tool.call",
                "start" if allowed else "error",
                title=f"{emitter.role.title()} · {tool_name} {'started' if allowed else 'denied'}",
                summary="最终执行边界已核对工具名和参数。",
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "arguments", "value": _redacted_preview(arguments) or "{}"},
                    {"label": "policy", "value": "allow" if allowed else "deny"},
                ],
                activeNodeIds=["decision", "tool", "rail-tool"],
                spanId=f"{emitter.invocation_id}:tool:{emitter.model_call_number}",
            )

        async def after_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            result = _text(ctx.inputs.tool_result, MAX_TEXT)
            emitter.event(
                "tool.call",
                "end",
                title=f"{emitter.role.title()} · {tool_name} completed",
                summary=(
                    "子 Agent 结果已返回父侧 task_tool。"
                    if emitter.role == "parent" and tool_name == "task_tool"
                    else "只读检查结果已返回子 Agent Context。"
                ),
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "result", "value": _redacted_preview(result) or "(empty)"},
                ],
                activeNodeIds=["tool", "context"],
                spanId=f"{emitter.invocation_id}:tool:{emitter.model_call_number}",
            )
            emitter.event(
                "context.delta",
                "instant",
                title=f"{emitter.role.title()} tool result · {tool_name}",
                summary="Tool observation 进入当前 Agent 的 ReAct Context。",
                context={
                    "operation": "append",
                    "messages": [{
                        "id": f"{emitter.context_owner_id}:tool:{emitter.model_call_number}",
                        "role": "tool",
                        "label": f"{tool_name} result",
                        "raw": result,
                        "preview": _redacted_preview(result),
                        "tokens": _estimated_tokens(result),
                        "source": f"Subagent runtime {emitter.role} AbilityManager",
                    }],
                },
                activeNodeIds=["tool", "context"],
            )

        async def on_tool_exception(self, ctx):
            tool_name = ctx.inputs.tool_name if isinstance(ctx.inputs, ToolCallInputs) else "unknown"
            emitter.hook(
                callback="on_tool_exception",
                rail_node_id="rail-tool",
                examines=[
                    f"tool: {tool_name}",
                    f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}",
                ],
                signal="fail",
            )

        async def after_react_iteration(self, ctx):
            del ctx
            emitter.react_iteration += 1
            emitter.event(
                "agent.react_iteration",
                "end",
                title=f"{emitter.role.title()} ReAct iteration {emitter.react_iteration}",
                summary="模型、Tool 与 observation 构成一次真实迭代。",
                iteration=emitter.react_iteration,
                activeNodeIds=["react-loop", "decision"],
                spanId=f"{emitter.invocation_id}:react:{emitter.react_iteration}",
            )

    return SubagentBoundaryRail()


def _required_request(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Invalid {name}")
    return value


def _read_request() -> dict[str, Any]:
    value = json.loads(sys.stdin.read())
    if not isinstance(value, dict):
        raise ValueError("Request must be an object")
    request = {
        name: _required_request(value.get(name), name, maximum)
        for name, maximum in (
            ("invocationId", 240),
            ("childInvocationId", 240),
            ("parentSessionId", 240),
            ("parentSubjectId", 240),
            ("parentContextOwnerId", 240),
            ("childSubjectId", 240),
            ("childContextOwnerId", 240),
            ("childType", 120),
            ("modelId", 240),
            ("input", 64_000),
            ("workspace", 2_000),
        )
    }
    request.update({
        "systemPrompt": value.get("systemPrompt"),
        "maxOutputTokens": value.get("maxOutputTokens"),
        "maxIterations": value.get("maxIterations"),
        "traceMaxTokens": value.get("traceMaxTokens"),
        "sourceRevisions": source_revisions(value.get("sourceRevisions")),
    })
    if request["systemPrompt"] is not None and (
        not isinstance(request["systemPrompt"], str)
        or len(request["systemPrompt"]) > 32_000
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
    return request


def _build_model(symbols: dict[str, Any], request: dict[str, Any]):
    Model = symbols["Model"]
    ModelClientConfig = symbols["ModelClientConfig"]
    ModelRequestConfig = symbols["ModelRequestConfig"]
    if request.get("modelMode") != "deterministic":
        api_key = os.environ.get("OPENJIUWEN_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OpenRouter key is unavailable")
        return Model(
            model_client_config=ModelClientConfig(
                client_provider="OpenRouter",
                api_key=api_key,
                api_base="https://openrouter.ai/api/v1",
                timeout=360.0,
                custom_headers={
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
            model_config=ModelRequestConfig(
                model=request["modelId"],
                temperature=0.1,
                top_p=0.9,
                max_tokens=request["maxOutputTokens"],
            ),
        )

    AssistantMessage = symbols["AssistantMessage"]
    AssistantMessageChunk = symbols["AssistantMessageChunk"]
    ToolCall = symbols["ToolCall"]
    UsageMetadata = symbols["UsageMetadata"]
    model = Model(
        model_client_config=ModelClientConfig(
            client_provider="OpenAI",
            api_key="deterministic-self-test",
            api_base="http://127.0.0.1/never-called",
            verify_ssl=False,
        ),
        model_config=ModelRequestConfig(model=request["modelId"]),
    )
    input_tokens = max(8, _estimated_tokens(request["input"]))

    def usage(extra_input: int, output: int):
        return UsageMetadata(
            model_name=request["modelId"],
            input_tokens=input_tokens + extra_input,
            output_tokens=output,
            total_tokens=input_tokens + extra_input + output,
        )

    responses = [
        AssistantMessage(
            content="",
            tool_calls=[ToolCall(
                id="delegate-child-1",
                type="function",
                name="task_tool",
                arguments=json.dumps({
                    "subagent_type": request["childType"],
                    "task_description": request["input"],
                }, ensure_ascii=False, separators=(",", ":")),
                index=0,
            )],
            finish_reason="tool_calls",
            usage_metadata=usage(0, 12),
        ),
        AssistantMessage(
            content="",
            tool_calls=[ToolCall(
                id="inspect-delegated-task-1",
                type="function",
                name="inspect_delegated_task",
                arguments=json.dumps({"text": request["input"]}, ensure_ascii=False, separators=(",", ":")),
                index=0,
            )],
            finish_reason="tool_calls",
            usage_metadata=usage(8, 10),
        ),
        AssistantMessage(
            content="Deterministic child analysis completed.",
            finish_reason="stop",
            usage_metadata=usage(18, 10),
        ),
        AssistantMessage(
            content="Deterministic parent synthesis completed.",
            finish_reason="stop",
            usage_metadata=usage(30, 11),
        ),
    ]
    response_index = 0

    def next_response():
        nonlocal response_index
        response = responses[min(response_index, len(responses) - 1)]
        response_index += 1
        return response

    async def deterministic_invoke(*args, **kwargs):
        del args, kwargs
        return next_response()

    async def deterministic_stream(*args, **kwargs):
        del args, kwargs
        response = next_response()
        yield AssistantMessageChunk(
            content=response.content,
            tool_calls=response.tool_calls,
            finish_reason=response.finish_reason,
            usage_metadata=response.usage_metadata,
        )

    model._client.invoke = deterministic_invoke
    model._client.stream = deterministic_stream
    return model


async def _run(request: dict[str, Any]) -> None:
    symbols = _runtime_symbols()
    tool = symbols["tool"]

    @tool(
        name="inspect_delegated_task",
        description=(
            "Inspect the complete delegated task exactly once. This read-only tool returns "
            "only deterministic length, line, word, hash, and marker observations."
        ),
    )
    def inspect_delegated_task(text: str) -> str:
        observations = {
            "characters": len(text),
            "lines": text.count("\n") + 1,
            "words": len(text.split()),
            "sha256_12": hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:12],
            "containsCodeFence": "```" in text,
            "containsUrl": bool(re.search(r"https?://", text)),
        }
        return json.dumps(observations, ensure_ascii=False, separators=(",", ":"))

    model = _build_model(symbols, request)
    parent_subject = {
        "id": request["parentSubjectId"],
        "kind": "member",
        "label": "Subagent Dispatcher",
        "role": "parent",
        "contextOwnerId": request["parentContextOwnerId"],
    }
    child_subject = {
        "id": request["childSubjectId"],
        "kind": "subagent",
        "label": "Analysis Subagent",
        "parentId": request["parentSubjectId"],
        "role": "child",
        "contextOwnerId": request["childContextOwnerId"],
    }
    parent_emitter = SubagentTraceEmitter(
        request,
        role="parent",
        invocation_id=f"{request['invocationId']}:parent",
        subject=parent_subject,
        context_owner_id=request["parentContextOwnerId"],
        allowed_tools={"task_tool"},
    )
    child_emitter = SubagentTraceEmitter(
        request,
        role="child",
        invocation_id=request["childInvocationId"],
        subject=child_subject,
        context_owner_id=request["childContextOwnerId"],
        allowed_tools={"inspect_delegated_task"},
    )
    child_emitter.parent_tool_span_id = parent_emitter.parent_tool_span_id
    parent_rail = _build_trace_rail(symbols, parent_emitter, request)
    child_rail = _build_trace_rail(symbols, child_emitter, request)
    parent_prompt = "\n\n".join(part for part in (
        request.get("systemPrompt") or "You are a concise parent dispatcher.",
        (
            f"For every request, call task_tool exactly once with subagent_type "
            f"'{request['childType']}' and the complete user request as task_description. "
            "Wait for the foreground child result, then synthesize the final answer. "
            "Do not call any other tool and do not answer before delegation."
        ),
    ) if part)
    child_prompt = (
        "You are a bounded analysis child. Call inspect_delegated_task exactly once with the "
        "complete delegated task, use the observation, and return a concise analysis. Do not "
        "call any other tool and do not attempt filesystem, shell, network, MCP, skill, or subagent access."
    )
    workspace = Path(request["workspace"])
    workspace.mkdir(parents=True, exist_ok=True)
    SubAgentConfig = symbols["SubAgentConfig"]
    AgentCard = symbols["AgentCard"]
    child_spec = SubAgentConfig(
        agent_card=AgentCard(
            name=request["childType"],
            description="One bounded analysis child with one deterministic read-only inspection tool.",
        ),
        system_prompt=child_prompt,
        tools=[inspect_delegated_task],
        model=model,
        rails=[child_rail],
        max_iterations=request["maxIterations"],
        parallel_tool_calls=False,
        restrict_to_work_dir=True,
        factory_kwargs={
            "enable_sys_operation": False,
            "enable_security_rail": True,
            "enable_model_anomaly_detection_rail": True,
        },
    )
    agent = symbols["create_deep_agent"](
        model=model,
        system_prompt=parent_prompt,
        tools=[],
        subagents=[child_spec],
        rails=[parent_rail],
        add_general_purpose_agent=False,
        enable_async_subagent=False,
        enable_task_loop=False,
        max_iterations=request["maxIterations"],
        workspace=str(workspace),
        restrict_to_work_dir=True,
        parallel_tool_calls=False,
        enable_read_image_multimodal=False,
        enable_sys_operation=False,
        enable_security_rail=True,
        enable_model_anomaly_detection_rail=True,
    )
    parent_emitter.event(
        "trace.status",
        "start",
        title="Subagent trace started",
        summary="固定子进程开始运行父 DeepAgent → task_tool → 子 DeepAgent 链路。",
    )
    parent_emitter.event(
        "swarm.member",
        "start",
        title="Subagent dispatcher started",
        summary="父 DeepAgent 只获得前台 task_tool；该链路不是 Agent Team 或 SwarmFlow。",
        payload={"status": "running", "sessionId": request["parentSessionId"]},
        definition={
            "repository": "agent-core",
            "path": "openjiuwen/harness/deep_agent.py",
            "symbol": "DeepAgent.create_subagent",
        },
    )
    parent_emitter.hook(
        callback="init.fixed_profile",
        namespace="outer",
        rail_node_id="rail-init",
        examines=[
            "parent tools: task_tool",
            "child tools: inspect_delegated_task",
            "max depth: 1",
            "max children: 1",
            "foreground: true",
            "nested subagents: disabled",
        ],
    )
    Runner = symbols["Runner"]
    await Runner.start()
    try:
        async for _chunk in Runner.run_agent_streaming(
            agent,
            {"query": request["input"]},
            session=request["parentSessionId"],
        ):
            pass
        if parent_emitter.allowed_tool_calls != 1:
            raise RuntimeError("Parent did not execute exactly one allowed task_tool call")
        if child_emitter.allowed_tool_calls != 1:
            raise RuntimeError("Child did not execute exactly one allowed inspection call")
        if not child_emitter.child_started or not child_emitter.child_finished:
            raise RuntimeError("Child lifecycle did not complete")
        parent_emitter.event(
            "swarm.member",
            "end",
            title="Subagent dispatcher completed",
            summary="父 DeepAgent 已接收 child 结果并完成最终综合。",
            payload={"status": "completed", "sessionId": request["parentSessionId"]},
        )
        parent_emitter.event(
            "trace.status",
            "end",
            title="Subagent trace complete",
            summary="真实 TaskTool 委派、父子 ReAct、Rail、Tool 与隔离 Context 已归一化。",
        )
    finally:
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
            runtime_workspace = (Path.cwd() / ".subagent-runtime-self-test").resolve()
            runtime_workspace.mkdir(parents=True, exist_ok=True)
            request = {
                "invocationId": "subagent-self-test",
                "childInvocationId": "subagent-self-test:child:1",
                "parentSessionId": "session_subagent_self_test",
                "parentSubjectId": "member:subagent-self-test:parent",
                "parentContextOwnerId": "context:subagent-self-test:parent",
                "childSubjectId": "subagent:subagent-self-test:child",
                "childContextOwnerId": "context:subagent-self-test:child",
                "childType": "analysis_subagent",
                "modelId": "deterministic/subagent-loop",
                "providerId": "deterministic",
                "modelMode": "deterministic",
                "input": "Run the deterministic TaskTool Subagent self-test.",
                "systemPrompt": "Exercise the real parent and child DeepAgent path.",
                "maxOutputTokens": 128,
                "maxIterations": 6,
                "traceMaxTokens": 16_384,
                "workspace": str(runtime_workspace / "run"),
            }
        else:
            request = _read_request()
        asyncio.run(_run(request))
        if arguments.self_test:
            required = {
                "ability.register",
                "agent.invoke",
                "agent.react_iteration",
                "agent.user_message",
                "context.delta",
                "context.snapshot",
                "model.call",
                "model.usage",
                "rail.hook",
                "swarm.member",
                "swarm.subagent",
                "tool.call",
                "trace.status",
            }
            observed = {kind for kind, _phase in _OBSERVED_EVENTS}
            missing = sorted(required - observed)
            if missing or ("trace.status", "end") not in _OBSERVED_EVENTS:
                raise RuntimeError(
                    "Subagent self-test event coverage failed: "
                    + (", ".join(missing) if missing else "terminal event missing")
                )
            if not {"member", "subagent"}.issubset(_OBSERVED_SUBJECT_KINDS):
                raise RuntimeError("Subagent self-test subject hierarchy is incomplete")
            if _OBSERVED_TOOLS["parent"] != {"task_tool"}:
                raise RuntimeError("Subagent parent tool boundary failed")
            if _OBSERVED_TOOLS["child"] != {"inspect_delegated_task"}:
                raise RuntimeError("Subagent child tool boundary failed")
            if not _OBSERVED_CHILD_SESSION.startswith("session_subagent_self_test_sub_analysis_subagent_"):
                raise RuntimeError("Subagent child session isolation was not observed")
            parent_raw = "\n".join(
                _text(message.get("raw"))
                for message in _LAST_CONTEXT_BY_OWNER.get("context:subagent-self-test:parent", [])
            )
            child_raw = "\n".join(
                _text(message.get("raw"))
                for message in _LAST_CONTEXT_BY_OWNER.get("context:subagent-self-test:child", [])
            )
            if "Deterministic parent synthesis completed." not in parent_raw:
                raise RuntimeError("Subagent parent final context is incomplete")
            if "Deterministic child analysis completed." not in child_raw:
                raise RuntimeError("Subagent child final context is incomplete")
    except Exception as exc:
        _emit_record({
            "type": "error",
            "code": "subagent_bridge_failed",
            "message": f"Subagent bridge failed with {type(exc).__name__}.",
        })
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
