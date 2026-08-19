"""Fixed JSON-line bridge from the local service into a real Agent Core runtime.

The bridge intentionally accepts one request on stdin and emits only prefixed,
normalized records on stdout. Agent Core logs are ignored by the parent process.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from runtime_source_identity import attach_source_revision, source_revisions


RECORD_PREFIX = "OPENJIUWEN_VISUALIZATION\t"
MAX_TEXT = 1_000_000
MAX_DETAIL = 4_000
ALLOWLISTED_TOOLS = frozenset({"inspect_input"})
_OBSERVED_EVENTS: list[tuple[str, str]] = []
_LAST_CONTEXT_MESSAGES: list[dict[str, Any]] = []

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _emit_record(value: dict[str, Any]) -> None:
    global _LAST_CONTEXT_MESSAGES
    if value.get("type") == "event" and isinstance(value.get("event"), dict):
        event = value["event"]
        _OBSERVED_EVENTS.append((str(event.get("kind")), str(event.get("phase"))))
        context = event.get("context")
        if (
            event.get("kind") == "context.snapshot"
            and isinstance(context, dict)
            and context.get("operation") == "replace"
            and isinstance(context.get("messages"), list)
        ):
            _LAST_CONTEXT_MESSAGES = list(context["messages"])
    print(
        RECORD_PREFIX + json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def _runtime_symbols() -> dict[str, Any]:
    from openjiuwen.core.foundation.llm import (
        AssistantMessage,
        AssistantMessageChunk,
        Model,
        ModelClientConfig,
        ModelRequestConfig,
        ToolCall,
        UsageMetadata,
    )
    from openjiuwen.core.foundation.tool import tool
    from openjiuwen.core.runner import Runner
    from openjiuwen.core.single_agent.rail.base import (
        AgentCallbackContext,
        AgentRail,
        InvokeInputs,
        ModelCallInputs,
        ToolCallInputs,
        UserMessageInputs,
    )
    from openjiuwen.harness import create_deep_agent

    return {
        "Model": Model,
        "ModelClientConfig": ModelClientConfig,
        "ModelRequestConfig": ModelRequestConfig,
        "AssistantMessage": AssistantMessage,
        "AssistantMessageChunk": AssistantMessageChunk,
        "ToolCall": ToolCall,
        "UsageMetadata": UsageMetadata,
        "tool": tool,
        "Runner": Runner,
        "AgentCallbackContext": AgentCallbackContext,
        "AgentRail": AgentRail,
        "InvokeInputs": InvokeInputs,
        "ModelCallInputs": ModelCallInputs,
        "ToolCallInputs": ToolCallInputs,
        "UserMessageInputs": UserMessageInputs,
        "create_deep_agent": create_deep_agent,
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
                "code": "agent_core_dependency_unavailable",
                "message": f"Agent Core Python dependency is unavailable: {dependency}.",
            }
        )
        return 1
    except Exception as exc:
        _emit_record(
            {
                "type": "probe",
                "ready": False,
                "code": "agent_core_import_failed",
                "message": f"Agent Core import failed with {type(exc).__name__}.",
            }
        )
        return 1
    _emit_record(
        {
            "type": "probe",
            "ready": True,
            "code": "ready",
            "message": "Agent Core DeepAgent runtime imports succeeded.",
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


def _message_role(message: Any) -> str:
    if isinstance(message, dict):
        role = message.get("role")
    else:
        role = getattr(message, "role", None)
    role = str(role or "assistant").lower()
    return role if role in {"system", "user", "assistant", "tool", "summary"} else "assistant"


def _message_value(message: Any, name: str) -> Any:
    return message.get(name) if isinstance(message, dict) else getattr(message, name, None)


def _message_raw(message: Any) -> str:
    content = _text(_message_value(message, "content"))
    additions: list[str] = []
    reasoning = _message_value(message, "reasoning_content")
    if reasoning:
        additions.append("[reasoning]\n" + _text(reasoning))
    tool_calls = _message_value(message, "tool_calls")
    if tool_calls:
        if isinstance(tool_calls, list):
            normalized = []
            for call in tool_calls:
                normalized.append(
                    {
                        "id": _message_value(call, "id"),
                        "name": _message_value(call, "name"),
                        "arguments": _message_value(call, "arguments"),
                    }
                )
            additions.append("[tool_calls]\n" + _text(normalized))
        else:
            additions.append("[tool_calls]\n" + _text(tool_calls))
    if additions:
        return (content + ("\n\n" if content else "") + "\n\n".join(additions))[:MAX_TEXT]
    return content[:MAX_TEXT]


def _context_messages(messages: list[Any], source: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, message in enumerate(messages[:250]):
        role = _message_role(message)
        raw = _message_raw(message)
        digest = hashlib.sha256(f"{index}:{role}:{raw}".encode("utf-8")).hexdigest()[:18]
        result.append(
            {
                "id": f"agent-core:{digest}",
                "role": role,
                "label": f"Agent Core {role} message",
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
    normalized: dict[str, int] = {}
    for key, value in fields.items():
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            normalized[key] = value
    if not all(key in normalized for key in ("inputTokens", "outputTokens", "totalTokens")):
        return None
    return normalized


class RuntimeTraceEmitter:
    def __init__(self, request: dict[str, Any]) -> None:
        self.invocation_id = request["invocationId"]
        self.model_id = request["modelId"]
        self.provider_id = request.get("providerId", "openrouter")
        self.provider_label = "OpenRouter" if self.provider_id == "openrouter" else "Deterministic model"
        self.trace_max_tokens = request["traceMaxTokens"]
        self.source_revisions = source_revisions(request.get("sourceRevisions"))
        self.started_at = time.monotonic()
        self.event_number = 0
        self.model_call_number = 0
        self.react_iteration = 0
        self.total_tokens = 0
        self.current_model_invocation = f"{self.invocation_id}:model:0"
        self.current_model_started = self.started_at
        self.last_model_window: list[Any] = []
        self.last_model_response: Any = None

    def event(self, kind: str, phase: str, **values: Any) -> None:
        self.event_number += 1
        if "definition" not in values:
            definition = {
                "agent.invoke": {
                    "repository": "agent-core",
                    "path": "openjiuwen/harness/deep_agent.py",
                    "symbol": "DeepAgent",
                },
                "agent.task_iteration": {
                    "repository": "agent-core",
                    "path": "openjiuwen/harness/deep_agent.py",
                    "symbol": "DeepAgent",
                },
                "agent.react_iteration": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/single_agent/agents/react_agent.py",
                    "symbol": "ReActAgent",
                },
                "model.call": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/foundation/llm/model.py",
                    "symbol": "Model",
                },
                "model.stream": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/foundation/llm/model.py",
                    "symbol": "Model",
                },
                "model.usage": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/foundation/llm/model.py",
                    "symbol": "Model",
                },
                "rail.chain": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/single_agent/rail/base.py",
                    "symbol": "AgentRail",
                },
                "rail.hook": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/single_agent/rail/base.py",
                    "symbol": "AgentRail",
                },
                "context.snapshot": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/context_engine/base.py",
                    "symbol": "ModelContext",
                },
                "context.delta": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/context_engine/base.py",
                    "symbol": "ModelContext",
                },
                "tool.call": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/single_agent/ability_manager.py",
                    "symbol": "AbilityManager",
                },
                "ability.register": {
                    "repository": "agent-core",
                    "path": "openjiuwen/core/single_agent/ability_manager.py",
                    "symbol": "AbilityManager",
                },
            }.get(kind)
            if definition:
                values["definition"] = definition
        attach_source_revision(values, self.source_revisions)
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
        rail_node_id: str,
        callback: str,
        namespace: str,
        examines: list[str],
        mutation: str = "无变更",
        signal: str = "continue",
        noop: bool = False,
        duration_ms: int = 0,
    ) -> None:
        self.event(
            "rail.hook",
            "instant",
            title=f"VisualizationTraceRail · {callback}",
            summary="显式观测 Rail 记录了审查载荷、变更与控制信号。",
            hook={
                "rail": "VisualizationTraceRail",
                "railNodeId": rail_node_id,
                "callback": callback,
                "priority": 1_000,
                "namespace": namespace,
                "durationMs": duration_ms,
                "mutationDiff": mutation,
                "controlSignal": signal,
                "noop": noop,
                "exact": True,
                "examines": examines[:100],
            },
            activeNodeIds=[rail_node_id],
            spanId=f"{self.invocation_id}:rail:{callback}",
        )


def _build_trace_rail(symbols: dict[str, Any], emitter: RuntimeTraceEmitter):
    AgentRail = symbols["AgentRail"]
    InvokeInputs = symbols["InvokeInputs"]
    ModelCallInputs = symbols["ModelCallInputs"]
    ToolCallInputs = symbols["ToolCallInputs"]
    UserMessageInputs = symbols["UserMessageInputs"]

    class VisualizationTraceRail(AgentRail):
        priority = 1_000

        async def before_invoke(self, ctx):
            query = ctx.inputs.query if isinstance(ctx.inputs, InvokeInputs) else ""
            query_text = _text(query)
            emitter.event(
                "agent.invoke",
                "start",
                title="DeepAgent invoke started",
                summary="create_deep_agent 进入独立 Agent 执行；内部 ReAct loop 即将接管。",
                activeNodeIds=["input", "deep-agent"],
            )
            emitter.hook(
                rail_node_id="rail-init",
                callback="before_invoke",
                namespace="outer",
                examines=["DeepAgent configured", "inner ReActAgent available", f"query chars: {len(query_text)}"],
            )

        async def after_invoke(self, ctx):
            result = ctx.inputs.result if isinstance(ctx.inputs, InvokeInputs) else None
            context = getattr(ctx, "context", None)
            context_messages = list(context.get_messages()) if context is not None else []
            final_messages = list(emitter.last_model_window or context_messages)
            if emitter.last_model_response is not None:
                final_messages.append(emitter.last_model_response)
            serialized = _context_messages(
                final_messages,
                "agent-core ModelContext · final",
            )
            if serialized:
                emitter.event(
                    "context.snapshot",
                    "instant",
                    title="Final Agent Core context",
                    summary="DeepAgent 完成后保存的完整 ModelContext；原文可在 Context Window 展开。",
                    token={
                        "used": emitter.total_tokens,
                        "delta": 0,
                        "budget": emitter.trace_max_tokens,
                    },
                    context={"operation": "replace", "messages": serialized},
                    activeNodeIds=["context", "output"],
                )
            failed = ctx.exception is not None or (
                isinstance(result, dict) and result.get("result_type") == "error"
            )
            emitter.hook(
                rail_node_id="rail-trajectory",
                callback="after_invoke",
                namespace="outer",
                examines=[
                    f"react iterations: {emitter.react_iteration}",
                    f"processed tokens: {emitter.total_tokens}",
                    f"result type: {result.get('result_type', 'unknown') if isinstance(result, dict) else 'unknown'}",
                ],
                signal="fail" if failed else "continue",
            )
            emitter.event(
                "agent.invoke",
                "error" if failed else "end",
                title="DeepAgent invoke failed" if failed else "DeepAgent invoke completed",
                summary="独立 Agent 已返回最终结果。" if not failed else "独立 Agent 在返回前发生错误。",
                activeNodeIds=["deep-agent", "output"],
            )
            emitter.event(
                "trace.status",
                "error" if failed else "end",
                title="Agent Core trace failed" if failed else "Agent Core trace complete",
                summary="真实 DeepAgent、ReAct、Rail、Tool 与 Context 事件已归一化。",
                activeNodeIds=["output"],
            )

        async def on_user_message(self, ctx):
            parts = ctx.inputs.parts if isinstance(ctx.inputs, UserMessageInputs) else []
            raw = "\n".join(_text(part) for part in parts)
            emitter.event(
                "agent.user_message",
                "instant",
                title="Agent Core user message admitted",
                summary="ON_USER_MESSAGE Rail 审查完成，输入进入 ModelContext。",
                activeNodeIds=["input"],
            )
            emitter.hook(
                rail_node_id="rail-safety",
                callback="on_user_message",
                namespace="inner",
                examines=_chunks(raw),
                mutation="无变更 · 原文按输入批次保留",
                signal="continue",
            )

        async def before_model_call(self, ctx):
            emitter.model_call_number += 1
            emitter.current_model_invocation = (
                f"{emitter.invocation_id}:model:{emitter.model_call_number}"
            )
            emitter.current_model_started = time.monotonic()
            messages = ctx.inputs.messages if isinstance(ctx.inputs, ModelCallInputs) else []
            tools = ctx.inputs.tools if isinstance(ctx.inputs, ModelCallInputs) else []
            inspectors = ctx.extra.setdefault("_stream_chunk_inspectors", {})
            if isinstance(inspectors, dict):
                inspectors["openjiuwen-visualization"] = self._inspect_stream_chunk
            emitter.event(
                "model.call",
                "start",
                title=f"{emitter.provider_label} call {emitter.model_call_number}",
                summary=f"ReActAgent 正在构造最终 ContextWindow 并调用 {emitter.provider_label}。",
                iteration=emitter.model_call_number,
                model={
                    **emitter.model_identity(),
                    "budget": {
                        "maxTotalTokens": emitter.trace_max_tokens,
                        "currency": "USD",
                    },
                },
                activeNodeIds=["context", "model"],
                spanId=f"{emitter.invocation_id}:model:{emitter.model_call_number}",
            )
            emitter.hook(
                rail_node_id="rail-context",
                callback="before_model_call",
                namespace="inner",
                examines=[
                    f"preview messages: {len(messages)}",
                    f"registered tool schemas: {len(tools or [])}",
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
                title="Agent Core model stream delta",
                iteration=emitter.model_call_number,
                model={**emitter.model_identity(), "delta": content},
                activeNodeIds=["model"],
                spanId=f"{emitter.invocation_id}:model:{emitter.model_call_number}",
            )

        async def after_model_call(self, ctx):
            if not isinstance(ctx.inputs, ModelCallInputs):
                return
            messages = list(ctx.inputs.messages or [])
            emitter.last_model_window = messages
            serialized = _context_messages(messages, "agent-core final ContextWindow")
            response = ctx.inputs.response
            emitter.last_model_response = response
            usage = _usage(response)
            call_tokens = usage["totalTokens"] if usage else sum(
                message["tokens"] for message in serialized
            )
            emitter.total_tokens += call_tokens
            emitter.event(
                "context.snapshot",
                "instant",
                title=f"Final model window {emitter.model_call_number}",
                summary="AFTER_MODEL_CALL 暴露的实际发送窗口；不是调用前预览。",
                iteration=emitter.model_call_number,
                token={
                    "used": emitter.total_tokens,
                    "delta": call_tokens,
                    "budget": emitter.trace_max_tokens,
                },
                context={"operation": "replace", "messages": serialized},
                activeNodeIds=["context"],
            )
            emitter.hook(
                rail_node_id="rail-context",
                callback="after_model_call",
                namespace="inner",
                examines=[
                    f"actual messages: {len(messages)}",
                    f"window estimated tokens: {sum(message['tokens'] for message in serialized)}",
                    f"provider reported tokens: {usage['totalTokens'] if usage else 'unavailable'}",
                    *[
                        f"{message['role']} · {message['raw'][:200]}"
                        for message in serialized[:20]
                    ],
                ],
            )
            response_text = _text(_message_value(response, "content"))
            tool_calls = _message_value(response, "tool_calls") or []
            details = []
            for call in list(tool_calls)[:20]:
                details.append(
                    {
                        "label": "tool call",
                        "value": f"{_message_value(call, 'name')}({_text(_message_value(call, 'arguments'), 3_500)})",
                    }
                )
            emitter.event(
                "model.call",
                "end",
                title=f"{emitter.provider_label} call {emitter.model_call_number} completed",
                summary="模型选择工具分支。" if tool_calls else "模型选择最终回答分支。",
                iteration=emitter.model_call_number,
                durationMs=max(0, round((time.monotonic() - emitter.current_model_started) * 1_000)),
                details=details,
                model={
                    **emitter.model_identity(),
                    "responseText": response_text,
                    "finishReason": _text(_message_value(response, "finish_reason"), 240) or "unknown",
                },
                activeNodeIds=["model", "decision"],
                spanId=f"{emitter.invocation_id}:model:{emitter.model_call_number}",
            )
            if usage:
                emitter.event(
                    "model.usage",
                    "instant",
                    title=f"{emitter.provider_label} usage {emitter.model_call_number}",
                    iteration=emitter.model_call_number,
                    token={
                        "used": emitter.total_tokens,
                        "delta": call_tokens,
                        "budget": emitter.trace_max_tokens,
                    },
                    model={**emitter.model_identity(), "usage": usage},
                    activeNodeIds=["model"],
                    spanId=f"{emitter.invocation_id}:model:{emitter.model_call_number}",
                )

        async def on_model_exception(self, ctx):
            emitter.hook(
                rail_node_id="rail-retry",
                callback="on_model_exception",
                namespace="inner",
                examines=[
                    f"exception: {type(ctx.exception).__name__ if ctx.exception else 'unknown'}",
                    f"retry attempt: {ctx.retry_attempt}",
                ],
                signal="retry" if ctx.retry_attempt == 0 else "fail",
            )
            emitter.event(
                "model.call",
                "error",
                title=f"{emitter.provider_label} call failed",
                summary="模型异常已交由 Agent Core Rail 链处理。",
                details=[
                    {
                        "label": "exception",
                        "value": type(ctx.exception).__name__ if ctx.exception else "unknown",
                    }
                ],
                model={**emitter.model_identity(), "finishReason": "error"},
                activeNodeIds=["model", "rail-retry"],
                spanId=f"{emitter.invocation_id}:model:{emitter.model_call_number}",
            )

        async def before_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            tool_name = ctx.inputs.tool_name
            arguments = _text(ctx.inputs.tool_args, MAX_DETAIL)
            allowed = tool_name in ALLOWLISTED_TOOLS
            if not allowed:
                ctx.request_force_finish(
                    {
                        "output": f"Tool {tool_name} is outside the visualization allowlist.",
                        "result_type": "error",
                    }
                )
            emitter.hook(
                rail_node_id="rail-tool",
                callback="before_tool_call",
                namespace="inner",
                examines=[f"tool name: {tool_name}", *_chunks(arguments, maximum=90)],
                signal="continue" if allowed else "block",
                mutation="无变更 · 命中只读工具白名单" if allowed else "阻断未注册工具",
            )
            emitter.event(
                "tool.call",
                "start" if allowed else "error",
                title=f"Tool {tool_name} {'started' if allowed else 'blocked'}",
                summary="ToolAllowlistRail 已核对工具名与参数。",
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "arguments", "value": arguments},
                    {"label": "allowlist", "value": "allow" if allowed else "block"},
                ],
                activeNodeIds=["decision", "tool", "rail-tool"],
                spanId=f"{emitter.invocation_id}:tool:{emitter.model_call_number}",
            )

        async def after_tool_call(self, ctx):
            if not isinstance(ctx.inputs, ToolCallInputs):
                return
            result = _text(ctx.inputs.tool_result, MAX_TEXT)
            tool_name = ctx.inputs.tool_name
            emitter.hook(
                rail_node_id="rail-tool",
                callback="after_tool_call",
                namespace="inner",
                examines=[f"tool name: {tool_name}", *_chunks(result, maximum=90)],
                signal="continue",
            )
            emitter.event(
                "tool.call",
                "end",
                title=f"Tool {tool_name} completed",
                summary="工具结果已返回 AbilityManager，下一步将写入 ToolMessage。",
                details=[
                    {"label": "tool", "value": tool_name},
                    {"label": "result", "value": result[:MAX_DETAIL]},
                ],
                activeNodeIds=["tool", "context"],
                spanId=f"{emitter.invocation_id}:tool:{emitter.model_call_number}",
            )
            emitter.event(
                "context.delta",
                "instant",
                title=f"Tool result · {tool_name}",
                summary="工具 observation 进入 ReAct Context。",
                context={
                    "operation": "append",
                    "messages": [
                        {
                            "id": f"{emitter.invocation_id}:tool:{emitter.model_call_number}",
                            "role": "tool",
                            "label": f"{tool_name} result",
                            "raw": result,
                            "preview": _redacted_preview(result),
                            "tokens": _estimated_tokens(result),
                            "source": "agent-core AbilityManager",
                        }
                    ],
                },
                activeNodeIds=["tool", "context"],
            )

        async def on_tool_exception(self, ctx):
            tool_name = ctx.inputs.tool_name if isinstance(ctx.inputs, ToolCallInputs) else "unknown"
            emitter.hook(
                rail_node_id="rail-tool",
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
            emitter.react_iteration += 1
            emitter.hook(
                rail_node_id="rail-trajectory",
                callback="after_react_iteration",
                namespace="inner",
                examines=[
                    f"iteration: {emitter.react_iteration}",
                    f"model calls: {emitter.model_call_number}",
                    f"processed tokens: {emitter.total_tokens}",
                ],
            )
            emitter.event(
                "agent.react_iteration",
                "end",
                title=f"ReAct iteration {emitter.react_iteration} completed",
                summary="LLM、Tool 与 ToolMessage 已构成一个完整的成功迭代。",
                iteration=emitter.react_iteration,
                activeNodeIds=["react-loop", "decision"],
                spanId=f"{emitter.invocation_id}:react:{emitter.react_iteration}",
            )

    return VisualizationTraceRail()


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
        "modelId": _required_request(value.get("modelId"), "modelId", 240),
        "input": _required_request(value.get("input"), "input", 64_000),
        "systemPrompt": value.get("systemPrompt"),
        "maxOutputTokens": value.get("maxOutputTokens"),
        "maxIterations": value.get("maxIterations"),
        "traceMaxTokens": value.get("traceMaxTokens"),
        "workspace": _required_request(value.get("workspace"), "workspace", 2_000),
        "sourceRevisions": source_revisions(value.get("sourceRevisions")),
    }
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


async def _run(request: dict[str, Any]) -> None:
    symbols = _runtime_symbols()
    Model = symbols["Model"]
    ModelClientConfig = symbols["ModelClientConfig"]
    ModelRequestConfig = symbols["ModelRequestConfig"]
    Runner = symbols["Runner"]
    create_deep_agent = symbols["create_deep_agent"]
    tool = symbols["tool"]

    @tool(
        name="inspect_input",
        description=(
            "Inspect the user's complete input before answering. This read-only tool "
            "returns deterministic length, line, word, and code-marker observations."
        ),
    )
    def inspect_input(text: str) -> str:
        observations = {
            "characters": len(text),
            "lines": text.count("\n") + 1,
            "words": len(text.split()),
            "containsCodeFence": "```" in text,
            "containsUrl": bool(re.search(r"https?://", text)),
        }
        return json.dumps(observations, ensure_ascii=False, separators=(",", ":"))

    if request.get("modelMode") == "deterministic":
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
        responses = [
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="inspect-input-1",
                        type="function",
                        name="inspect_input",
                        arguments=json.dumps(
                            {"text": request["input"]},
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                        index=0,
                    )
                ],
                finish_reason="tool_calls",
                usage_metadata=UsageMetadata(
                    model_name=request["modelId"],
                    input_tokens=input_tokens,
                    output_tokens=8,
                    total_tokens=input_tokens + 8,
                ),
            ),
            AssistantMessage(
                content="Deterministic Agent Core self-test completed.",
                finish_reason="stop",
                usage_metadata=UsageMetadata(
                    model_name=request["modelId"],
                    input_tokens=input_tokens + 12,
                    output_tokens=10,
                    total_tokens=input_tokens + 22,
                ),
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
    else:
        api_key = os.environ.get("OPENJIUWEN_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OpenRouter key is unavailable")
        model = Model(
            model_client_config=ModelClientConfig(
                client_provider="OpenRouter",
                api_key=api_key,
                api_base="https://openrouter.ai/api/v1",
                timeout=360.0,
                custom_headers={
                    "HTTP-Referer": os.environ.get("OPENJIUWEN_OPENROUTER_SITE_URL", "https://github.com/LasVie/OpenJiuwen_Visualization"),
                    "X-OpenRouter-Title": os.environ.get("OPENJIUWEN_OPENROUTER_APP_NAME", "OpenJiuwen Visualization"),
                },
            ),
            model_config=ModelRequestConfig(
                model=request["modelId"],
                temperature=0.1,
                top_p=0.9,
                max_tokens=request["maxOutputTokens"],
            ),
        )
    emitter = RuntimeTraceEmitter(request)
    rail = _build_trace_rail(symbols, emitter)
    system_prompt = "\n\n".join(
        part
        for part in (
            request.get("systemPrompt") or "You are a concise OpenJiuwen assistant.",
            (
                "Before answering, call the inspect_input tool exactly once with the complete "
                "user request. Use its observation, then answer the request. Do not call any "
                "tool that is not registered."
            ),
        )
        if part
    )
    workspace = Path(request["workspace"])
    workspace.mkdir(parents=True, exist_ok=True)
    agent = create_deep_agent(
        model=model,
        system_prompt=system_prompt,
        tools=[inspect_input],
        rails=[rail],
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
    emitter.event(
        "ability.register",
        "instant",
        title="Read-only tool registered",
        summary="DeepAgent AbilityManager 已注册固定白名单工具 inspect_input。",
        details=[
            {"label": "tool", "value": "inspect_input"},
            {"label": "policy", "value": "read-only-allowlist"},
        ],
        payload={
            "tools": ["inspect_input"],
            "policy": "read-only-allowlist",
        },
        activeNodeIds=["tool"],
    )
    emitter.hook(
        rail_node_id="rail-init",
        callback="init",
        namespace="outer",
        examines=[
            "VisualizationTraceRail · priority 1000",
            "inspect_input · read-only allowlist",
            "DeepAgent outer invoke + ReAct inner callbacks",
        ],
    )
    await Runner.start()
    try:
        async for _chunk in Runner.run_agent_streaming(agent, {"query": request["input"]}):
            pass
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
            runtime_workspace = (Path.cwd() / ".agent-core-runtime").resolve()
            runtime_workspace.mkdir(parents=True, exist_ok=True)
            os.chdir(runtime_workspace)
            request = {
                "invocationId": "agent-core-self-test",
                "modelId": "deterministic/tool-loop",
                "providerId": "deterministic",
                "modelMode": "deterministic",
                "input": "Inspect this deterministic input.\nhttps://example.invalid/self-test",
                "systemPrompt": "Exercise the real DeepAgent execution path.",
                "maxOutputTokens": 128,
                "maxIterations": 4,
                "traceMaxTokens": 8_192,
                "workspace": str(runtime_workspace / "self-test"),
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
                "tool.call",
                "trace.status",
            }
            observed = {kind for kind, _phase in _OBSERVED_EVENTS}
            missing = sorted(required - observed)
            if missing or ("trace.status", "end") not in _OBSERVED_EVENTS:
                raise RuntimeError(
                    "Agent Core self-test event coverage failed: "
                    + (", ".join(missing) if missing else "terminal event missing")
                )
            final_roles = [_message_role(message) for message in _LAST_CONTEXT_MESSAGES]
            final_raw = "\n".join(
                _text(message.get("raw")) for message in _LAST_CONTEXT_MESSAGES
            )
            if not {"system", "user", "assistant", "tool"}.issubset(final_roles):
                raise RuntimeError("Agent Core self-test final context is incomplete")
            if "Deterministic Agent Core self-test completed." not in final_raw:
                raise RuntimeError("Agent Core self-test final answer is missing from context")
    except Exception as exc:
        _emit_record(
            {
                "type": "error",
                "code": "agent_core_bridge_failed",
                "message": f"Agent Core bridge failed with {type(exc).__name__}.",
            }
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
