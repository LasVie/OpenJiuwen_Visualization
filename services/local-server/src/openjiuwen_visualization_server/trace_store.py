"""Thread-safe, memory-only storage for normalized runtime trace events."""

from __future__ import annotations

import copy
import json
import math
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


API_VERSION = "1.0.0"
CORE_EVENT_KINDS = frozenset(
    {
        "agent.invoke",
        "agent.user_message",
        "agent.task_iteration",
        "agent.react_iteration",
        "model.call",
        "model.stream",
        "model.usage",
        "model.cancel",
        "tool.call",
        "rail.chain",
        "rail.hook",
        "context.snapshot",
        "context.delta",
        "ability.register",
        "trace.status",
    }
)
SWARM_EVENT_KINDS = frozenset(
    {
        "swarm.team",
        "swarm.member",
        "swarm.task",
        "swarm.message",
        "swarm.workflow",
        "swarm.phase",
        "swarm.agent",
        "swarm.human",
        "swarm.subagent",
    }
)
EVENT_KINDS = CORE_EVENT_KINDS | SWARM_EVENT_KINDS
EVENT_PHASES = frozenset({"start", "end", "error", "instant"})
TRACE_OWNERS = frozenset({"agent-core", "jiuwenswarm"})
CONTEXT_ROLES = frozenset({"system", "user", "assistant", "tool", "summary"})
SUBJECT_KINDS = frozenset(
    {"team", "workflow", "phase", "member", "agent", "subagent", "human", "task"}
)
EVENT_FIELDS = frozenset(
    {
        "eventId",
        "kind",
        "phase",
        "timestampMs",
        "spanId",
        "parentSpanId",
        "iteration",
        "title",
        "summary",
        "durationMs",
        "activeNodeIds",
        "activeEdgeIds",
        "details",
        "token",
        "context",
        "hook",
        "model",
        "subject",
        "definition",
        "payload",
    }
)


class TraceStoreError(ValueError):
    """A stable API error raised by trace storage or validation."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _utc_timestamp(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def _required_text(value: Any, field_name: str, *, max_length: int = 240) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TraceStoreError("invalid_event", f"{field_name} must be a non-empty string.")
    normalized = value.strip()
    if len(normalized) > max_length:
        raise TraceStoreError("invalid_event", f"{field_name} exceeds {max_length} characters.")
    return normalized


def _optional_text(value: Any, field_name: str, *, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TraceStoreError("invalid_event", f"{field_name} must be a string.")
    if len(value) > max_length:
        raise TraceStoreError("invalid_event", f"{field_name} exceeds {max_length} characters.")
    return value


def _finite_number(value: Any, field_name: str, *, minimum: float | None = 0) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TraceStoreError("invalid_event", f"{field_name} must be a number.")
    if not math.isfinite(value) or (minimum is not None and value < minimum):
        constraint = "finite" if minimum is None else f"finite and >= {minimum}"
        raise TraceStoreError("invalid_event", f"{field_name} must be {constraint}.")
    return value


def _non_negative_integer(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TraceStoreError("invalid_event", f"{field_name} must be a non-negative integer.")
    return value


def _validate_string_list(value: Any, field_name: str, *, maximum: int = 100) -> None:
    if not isinstance(value, list) or len(value) > maximum:
        raise TraceStoreError("invalid_event", f"{field_name} must be an array of at most {maximum} strings.")
    for item in value:
        _required_text(item, field_name, max_length=240)


def _validate_json_value(value: Any, field_name: str, *, depth: int = 0) -> None:
    if depth > 16:
        raise TraceStoreError("invalid_event", f"{field_name} exceeds the JSON nesting limit.")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        _finite_number(value, field_name, minimum=None)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, f"{field_name}[{index}]", depth=depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TraceStoreError("invalid_event", f"{field_name} keys must be strings.")
            _validate_json_value(item, f"{field_name}.{key}", depth=depth + 1)
        return
    raise TraceStoreError("invalid_event", f"{field_name} must contain only JSON values.")


def _validate_token(token: Any) -> None:
    if not isinstance(token, dict):
        raise TraceStoreError("invalid_event", "token must be an object.")
    unknown = set(token) - {"used", "delta", "tool", "budget"}
    if unknown:
        raise TraceStoreError("invalid_event", f"token contains unsupported field: {sorted(unknown)[0]}")
    token["used"] = _finite_number(token.get("used"), "token.used")
    if "delta" in token:
        token["delta"] = _finite_number(token["delta"], "token.delta", minimum=None)
    for field_name in ("tool", "budget"):
        if field_name in token:
            token[field_name] = _finite_number(token[field_name], f"token.{field_name}")


def _validate_context_message(message: Any, index: int) -> None:
    if not isinstance(message, dict):
        raise TraceStoreError("invalid_event", f"context.messages[{index}] must be an object.")
    unknown = set(message) - {"id", "role", "label", "raw", "preview", "tokens", "source"}
    if unknown:
        raise TraceStoreError(
            "invalid_event",
            f"context.messages[{index}] contains unsupported field: {sorted(unknown)[0]}",
        )
    prefix = f"context.messages[{index}]"
    message["id"] = _required_text(message.get("id"), f"{prefix}.id")
    role = _required_text(message.get("role"), f"{prefix}.role", max_length=20)
    if role not in CONTEXT_ROLES:
        raise TraceStoreError("invalid_event", f"Unsupported context role: {role}")
    message["role"] = role
    message["label"] = _required_text(message.get("label"), f"{prefix}.label", max_length=240)
    raw = message.get("raw")
    if not isinstance(raw, str) or len(raw) > 1_000_000:
        raise TraceStoreError("invalid_event", f"{prefix}.raw must be a string of at most 1000000 characters.")
    if "preview" in message:
        preview = message["preview"]
        if not isinstance(preview, str) or len(preview) > 8_000:
            raise TraceStoreError("invalid_event", f"{prefix}.preview must be a string of at most 8000 characters.")
    message["tokens"] = _finite_number(message.get("tokens"), f"{prefix}.tokens")
    message["source"] = _required_text(message.get("source"), f"{prefix}.source", max_length=240)


def _validate_context(context: Any) -> None:
    if not isinstance(context, dict):
        raise TraceStoreError("invalid_event", "context must be an object.")
    unknown = set(context) - {"operation", "ownerId", "messages", "removeMessageIds"}
    if unknown:
        raise TraceStoreError("invalid_event", f"context contains unsupported field: {sorted(unknown)[0]}")
    operation = _required_text(context.get("operation"), "context.operation", max_length=20)
    if operation not in {"append", "replace", "remove"}:
        raise TraceStoreError("invalid_event", f"Unsupported context operation: {operation}")
    context["operation"] = operation
    if "ownerId" in context:
        context["ownerId"] = _required_text(context["ownerId"], "context.ownerId")
    messages = context.get("messages", [])
    if not isinstance(messages, list) or len(messages) > 250:
        raise TraceStoreError("invalid_event", "context.messages must contain at most 250 items.")
    for index, message in enumerate(messages):
        _validate_context_message(message, index)
    if "removeMessageIds" in context:
        _validate_string_list(context["removeMessageIds"], "context.removeMessageIds", maximum=250)


def _validate_subject(subject: Any) -> None:
    if not isinstance(subject, dict):
        raise TraceStoreError("invalid_event", "subject must be an object.")
    allowed = {"id", "kind", "label", "parentId", "role", "contextOwnerId"}
    unknown = set(subject) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"subject contains unsupported field: {sorted(unknown)[0]}")
    subject["id"] = _required_text(subject.get("id"), "subject.id")
    kind = _required_text(subject.get("kind"), "subject.kind", max_length=40)
    if kind not in SUBJECT_KINDS:
        raise TraceStoreError("invalid_event", f"Unsupported subject kind: {kind}")
    subject["kind"] = kind
    subject["label"] = _required_text(subject.get("label"), "subject.label", max_length=240)
    for field_name in ("parentId", "role", "contextOwnerId"):
        if field_name in subject:
            subject[field_name] = _required_text(subject[field_name], f"subject.{field_name}")
    if subject.get("parentId") == subject["id"]:
        raise TraceStoreError("invalid_event", "subject.parentId must differ from subject.id.")


def _validate_hook(hook: Any) -> None:
    if not isinstance(hook, dict):
        raise TraceStoreError("invalid_event", "hook must be an object.")
    allowed = {
        "rail",
        "railNodeId",
        "callback",
        "priority",
        "namespace",
        "durationMs",
        "mutationDiff",
        "controlSignal",
        "noop",
        "exact",
        "examines",
    }
    unknown = set(hook) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"hook contains unsupported field: {sorted(unknown)[0]}")
    hook["rail"] = _required_text(hook.get("rail"), "hook.rail")
    hook["callback"] = _required_text(hook.get("callback"), "hook.callback")
    if "railNodeId" in hook:
        hook["railNodeId"] = _required_text(hook["railNodeId"], "hook.railNodeId")
    priority = hook.get("priority")
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise TraceStoreError("invalid_event", "hook.priority must be an integer.")
    if hook.get("namespace") not in {"outer", "inner"}:
        raise TraceStoreError("invalid_event", "hook.namespace must be outer or inner.")
    hook["durationMs"] = _finite_number(hook.get("durationMs"), "hook.durationMs")
    for field_name in ("mutationDiff", "controlSignal"):
        hook[field_name] = _required_text(hook.get(field_name), f"hook.{field_name}", max_length=4_000)
    for field_name in ("noop", "exact"):
        if field_name in hook and not isinstance(hook[field_name], bool):
            raise TraceStoreError("invalid_event", f"hook.{field_name} must be a boolean.")
    if "exact" not in hook:
        raise TraceStoreError("invalid_event", "hook.exact is required.")
    if "examines" in hook:
        _validate_string_list(hook["examines"], "hook.examines", maximum=100)


def _validate_model_usage(usage: Any) -> None:
    if not isinstance(usage, dict):
        raise TraceStoreError("invalid_event", "model.usage must be an object.")
    allowed = {
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cachedInputTokens",
        "reasoningTokens",
        "costMicros",
        "currency",
    }
    unknown = set(usage) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"model.usage contains unsupported field: {sorted(unknown)[0]}")
    for field_name in ("inputTokens", "outputTokens", "totalTokens"):
        usage[field_name] = _non_negative_integer(usage.get(field_name), f"model.usage.{field_name}")
    for field_name in ("cachedInputTokens", "reasoningTokens", "costMicros"):
        if field_name in usage:
            usage[field_name] = _non_negative_integer(usage[field_name], f"model.usage.{field_name}")
    if "currency" in usage:
        usage["currency"] = _required_text(usage["currency"], "model.usage.currency", max_length=12)


def _validate_model_budget(budget: Any) -> None:
    if not isinstance(budget, dict):
        raise TraceStoreError("invalid_event", "model.budget must be an object.")
    allowed = {
        "maxInputTokens",
        "maxOutputTokens",
        "maxTotalTokens",
        "maxCostMicros",
        "currency",
    }
    unknown = set(budget) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"model.budget contains unsupported field: {sorted(unknown)[0]}")
    for field_name in ("maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostMicros"):
        if field_name in budget:
            budget[field_name] = _non_negative_integer(budget[field_name], f"model.budget.{field_name}")
    if "currency" in budget:
        budget["currency"] = _required_text(budget["currency"], "model.budget.currency", max_length=12)


def _validate_model(model: Any, kind: str) -> None:
    if not isinstance(model, dict):
        raise TraceStoreError("invalid_event", "model must be an object.")
    allowed = {
        "invocationId",
        "providerId",
        "modelId",
        "source",
        "recordingId",
        "recordingSequence",
        "delta",
        "responseText",
        "finishReason",
        "cancelReason",
        "usage",
        "budget",
    }
    unknown = set(model) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"model contains unsupported field: {sorted(unknown)[0]}")
    for field_name in ("invocationId", "providerId", "modelId"):
        model[field_name] = _required_text(model.get(field_name), f"model.{field_name}")
    source = _required_text(model.get("source"), "model.source", max_length=20)
    if source not in {"live", "recording"}:
        raise TraceStoreError("invalid_event", "model.source must be live or recording.")
    model["source"] = source
    for field_name, max_length in {
        "recordingId": 240,
        "finishReason": 240,
        "cancelReason": 4_000,
    }.items():
        if field_name in model:
            model[field_name] = _required_text(model[field_name], f"model.{field_name}", max_length=max_length)
    for field_name in ("delta", "responseText"):
        if field_name in model:
            value = model[field_name]
            if not isinstance(value, str) or len(value) > 1_000_000:
                raise TraceStoreError("invalid_event", f"model.{field_name} must be a string of at most 1000000 characters.")
    if "recordingSequence" in model:
        value = model["recordingSequence"]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise TraceStoreError("invalid_event", "model.recordingSequence must be a non-negative integer.")
    if "usage" in model:
        _validate_model_usage(model["usage"])
    if "budget" in model:
        _validate_model_budget(model["budget"])
    if source == "recording" and ("recordingId" not in model or "recordingSequence" not in model):
        raise TraceStoreError(
            "invalid_event",
            "Recorded model events require model.recordingId and model.recordingSequence.",
        )
    if kind == "model.stream" and "delta" not in model:
        raise TraceStoreError("invalid_event", "model.stream events require model.delta.")
    if kind == "model.usage" and "usage" not in model:
        raise TraceStoreError("invalid_event", "model.usage events require model.usage.")
    if kind == "model.cancel" and "cancelReason" not in model:
        raise TraceStoreError("invalid_event", "model.cancel events require model.cancelReason.")


def _validate_definition(definition: Any) -> None:
    if not isinstance(definition, dict):
        raise TraceStoreError("invalid_event", "definition must be an object.")
    allowed = {"repository", "path", "revision", "symbol", "startLine", "endLine"}
    unknown = set(definition) - allowed
    if unknown:
        raise TraceStoreError("invalid_event", f"definition contains unsupported field: {sorted(unknown)[0]}")
    definition["repository"] = _required_text(definition.get("repository"), "definition.repository")
    definition["path"] = _required_text(definition.get("path"), "definition.path", max_length=2_000)
    for field_name in ("revision", "symbol"):
        if field_name in definition:
            definition[field_name] = _required_text(definition[field_name], f"definition.{field_name}", max_length=1_000)
    for field_name in ("startLine", "endLine"):
        if field_name in definition:
            value = definition[field_name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise TraceStoreError("invalid_event", f"definition.{field_name} must be a positive integer.")


def _validate_event(raw_event: Any) -> dict[str, Any]:
    if not isinstance(raw_event, dict):
        raise TraceStoreError("invalid_event", "Each event must be a JSON object.")

    event = copy.deepcopy(raw_event)
    unknown_fields = set(event) - EVENT_FIELDS
    if unknown_fields:
        raise TraceStoreError(
            "invalid_event",
            f"Event contains unsupported field: {sorted(unknown_fields)[0]}",
        )
    event["eventId"] = _required_text(event.get("eventId"), "eventId")
    event["spanId"] = _required_text(event.get("spanId"), "spanId")
    kind = _required_text(event.get("kind"), "kind")
    phase = _required_text(event.get("phase"), "phase")
    if kind not in EVENT_KINDS:
        raise TraceStoreError("invalid_event", f"Unsupported event kind: {kind}")
    if phase not in EVENT_PHASES:
        raise TraceStoreError("invalid_event", f"Unsupported event phase: {phase}")
    event["kind"] = kind
    event["phase"] = phase
    event["timestampMs"] = _finite_number(event.get("timestampMs"), "timestampMs")

    optional_text_fields = {
        "parentSpanId": 240,
        "title": 240,
        "summary": 4_000,
    }
    for field_name, max_length in optional_text_fields.items():
        value = _optional_text(event.get(field_name), field_name, max_length=max_length)
        if value is None:
            event.pop(field_name, None)
        else:
            event[field_name] = value

    for field_name in ("durationMs", "iteration"):
        if field_name in event:
            event[field_name] = _finite_number(event[field_name], field_name)
    if "iteration" in event and not isinstance(event["iteration"], int):
        raise TraceStoreError("invalid_event", "iteration must be an integer.")

    for field_name in ("activeNodeIds", "activeEdgeIds"):
        if field_name in event:
            _validate_string_list(event[field_name], field_name)

    if "token" in event:
        _validate_token(event["token"])
    if "context" in event:
        _validate_context(event["context"])
    if "hook" in event:
        _validate_hook(event["hook"])
    if "model" in event:
        _validate_model(event["model"], kind)
    if "subject" in event:
        _validate_subject(event["subject"])
    if kind == "rail.hook" and "hook" not in event:
        raise TraceStoreError("invalid_event", "rail.hook events require hook evidence.")
    if kind in {"model.stream", "model.usage", "model.cancel"} and "model" not in event:
        raise TraceStoreError("invalid_event", f"{kind} events require model evidence.")
    if "definition" in event:
        _validate_definition(event["definition"])
    if "payload" in event:
        if not isinstance(event["payload"], dict):
            raise TraceStoreError("invalid_event", "payload must be an object.")
        _validate_json_value(event["payload"], "payload")
    if "details" in event:
        details = event["details"]
        if not isinstance(details, list) or len(details) > 100:
            raise TraceStoreError("invalid_event", "details must be an array of at most 100 items.")
        for detail in details:
            if not isinstance(detail, dict):
                raise TraceStoreError("invalid_event", "Each details item must be an object.")
            unknown = set(detail) - {"label", "value"}
            if unknown:
                raise TraceStoreError(
                    "invalid_event",
                    f"details item contains unsupported field: {sorted(unknown)[0]}",
                )
            detail["label"] = _required_text(detail.get("label"), "details.label", max_length=120)
            detail["value"] = _required_text(detail.get("value"), "details.value", max_length=4_000)
    return event


@dataclass(slots=True)
class _TraceSession:
    id: str
    write_token: str
    owner: str
    label: str
    max_tokens: int
    created_epoch: float
    updated_epoch: float
    status: str = "open"
    events: list[dict[str, Any]] = field(default_factory=list)
    event_ids: set[str] = field(default_factory=set)
    event_bytes: int = 0
    subject_shapes: dict[str, tuple[str, str | None, str | None]] = field(default_factory=dict)
    model_shapes: dict[str, tuple[str, str, str, str | None]] = field(default_factory=dict)
    recording_sequences: dict[str, int] = field(default_factory=dict)

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "label": self.label,
            "status": self.status,
            "createdAt": _utc_timestamp(self.created_epoch),
            "updatedAt": _utc_timestamp(self.updated_epoch),
            "eventCount": len(self.events),
            "lastSequence": len(self.events),
            "maxTokens": self.max_tokens,
            "byteCount": self.event_bytes,
        }


class RuntimeTraceStore:
    """Bounded runtime event collector that never writes trace data to disk."""

    def __init__(
        self,
        *,
        max_sessions: int = 32,
        max_events_per_session: int = 10_000,
        max_bytes_per_session: int = 32 * 1024 * 1024,
        max_total_bytes: int = 128 * 1024 * 1024,
        ttl_seconds: float = 2 * 60 * 60,
        clock: Callable[[], float] = time.time,
        id_factory: Callable[[], str] | None = None,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        self._max_sessions = max_sessions
        self._max_events_per_session = max_events_per_session
        self._max_bytes_per_session = max_bytes_per_session
        self._max_total_bytes = max_total_bytes
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._id_factory = id_factory or (lambda: "tr_" + secrets.token_urlsafe(16))
        self._token_factory = token_factory or (lambda: "tw_" + secrets.token_urlsafe(24))
        self._sessions: dict[str, _TraceSession] = {}
        self._condition = threading.Condition(threading.RLock())

    def create(self, *, owner: str, label: str, max_tokens: int) -> tuple[dict[str, Any], str]:
        if owner not in TRACE_OWNERS:
            raise TraceStoreError("invalid_trace", "owner must be agent-core or jiuwenswarm.")
        normalized_label = _required_text(label, "label", max_length=160)
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 256 <= max_tokens <= 10_000_000:
            raise TraceStoreError("invalid_trace", "maxTokens must be an integer between 256 and 10000000.")

        with self._condition:
            self._cleanup_locked()
            self._evict_closed_for_session_capacity_locked()
            if len(self._sessions) >= self._max_sessions:
                raise TraceStoreError(
                    "trace_capacity_reached",
                    "The memory-only trace session limit has been reached.",
                    status=429,
                )
            trace_id = self._id_factory()
            while trace_id in self._sessions:
                trace_id = self._id_factory()
            now = self._clock()
            session = _TraceSession(
                id=trace_id,
                write_token=self._token_factory(),
                owner=owner,
                label=normalized_label,
                max_tokens=max_tokens,
                created_epoch=now,
                updated_epoch=now,
            )
            self._sessions[trace_id] = session
            return session.metadata(), session.write_token

    def append(
        self,
        trace_id: str,
        write_token: str | None,
        raw_events: Any,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if not isinstance(raw_events, list) or not 1 <= len(raw_events) <= 250:
            raise TraceStoreError("invalid_event", "events must contain between 1 and 250 items.")

        with self._condition:
            session = self._session_locked(trace_id)
            if not write_token or not secrets.compare_digest(write_token, session.write_token):
                raise TraceStoreError("invalid_trace_token", "Trace write token is missing or invalid.", status=403)

            validated = [_validate_event(event) for event in raw_events]
            for event in validated:
                if session.owner == "agent-core" and event["kind"] not in CORE_EVENT_KINDS:
                    raise TraceStoreError(
                        "invalid_event",
                        f"Event kind {event['kind']} is not valid for an agent-core trace.",
                    )
                if session.owner == "jiuwenswarm":
                    if event["kind"] != "trace.status" and "subject" not in event:
                        raise TraceStoreError(
                            "invalid_event",
                            "jiuwenswarm events require a subject so hierarchy remains deterministic.",
                        )
                    if "context" in event and not event["context"].get("ownerId"):
                        raise TraceStoreError(
                            "invalid_event",
                            "jiuwenswarm context events require context.ownerId.",
                        )

            seen_event_ids = set(session.event_ids)
            unique: list[dict[str, Any]] = []
            for event in validated:
                if event["eventId"] in seen_event_ids:
                    continue
                seen_event_ids.add(event["eventId"])
                unique.append(event)

            next_subject_shapes = dict(session.subject_shapes)
            for event in unique:
                subject = event.get("subject")
                if not subject:
                    continue
                subject_id = subject["id"]
                incoming = (
                    subject["kind"],
                    subject.get("parentId"),
                    subject.get("contextOwnerId"),
                )
                existing = next_subject_shapes.get(subject_id)
                if existing is None:
                    next_subject_shapes[subject_id] = incoming
                    continue
                if existing[0] != incoming[0]:
                    raise TraceStoreError(
                        "invalid_event",
                        f"subject {subject_id} changed kind within one trace.",
                    )
                if existing[1] and incoming[1] and existing[1] != incoming[1]:
                    raise TraceStoreError(
                        "invalid_event",
                        f"subject {subject_id} changed parentId within one trace.",
                    )
                if existing[2] and incoming[2] and existing[2] != incoming[2]:
                    raise TraceStoreError(
                        "invalid_event",
                        f"subject {subject_id} changed contextOwnerId within one trace.",
                    )
                next_subject_shapes[subject_id] = (
                    existing[0],
                    existing[1] or incoming[1],
                    existing[2] or incoming[2],
                )

            next_model_shapes = dict(session.model_shapes)
            next_recording_sequences = dict(session.recording_sequences)
            for event in unique:
                model = event.get("model")
                if not model:
                    continue
                invocation_id = model["invocationId"]
                incoming_shape = (
                    model["providerId"],
                    model["modelId"],
                    model["source"],
                    model.get("recordingId"),
                )
                existing_shape = next_model_shapes.get(invocation_id)
                if existing_shape is not None and existing_shape != incoming_shape:
                    raise TraceStoreError(
                        "invalid_event",
                        f"model invocation {invocation_id} changed provider, model, source, or recording within one trace.",
                    )
                next_model_shapes[invocation_id] = incoming_shape
                if model["source"] == "recording":
                    recording_id = model["recordingId"]
                    recording_sequence = model["recordingSequence"]
                    previous_sequence = next_recording_sequences.get(recording_id, -1)
                    if recording_sequence <= previous_sequence:
                        raise TraceStoreError(
                            "invalid_event",
                            f"model recording {recording_id} frame sequence must increase monotonically.",
                        )
                    next_recording_sequences[recording_id] = recording_sequence

            for subject_id in next_subject_shapes:
                cursor: str | None = subject_id
                seen_subjects: set[str] = set()
                while cursor and cursor in next_subject_shapes:
                    if cursor in seen_subjects:
                        raise TraceStoreError(
                            "invalid_event",
                            f"subject hierarchy contains a cycle at {cursor}.",
                        )
                    seen_subjects.add(cursor)
                    cursor = next_subject_shapes[cursor][1]
            if session.status != "open":
                if not unique:
                    return session.metadata(), []
                raise TraceStoreError("trace_closed", "This trace session no longer accepts events.", status=409)

            terminal_positions = [
                index
                for index, event in enumerate(unique)
                if event["kind"] == "trace.status" and event["phase"] in {"end", "error"}
            ]
            if len(terminal_positions) > 1 or (
                terminal_positions and terminal_positions[0] != len(unique) - 1
            ):
                raise TraceStoreError(
                    "invalid_event",
                    "A terminal trace.status event must be the final unique event in a batch.",
                )
            if len(session.events) + len(unique) > self._max_events_per_session:
                raise TraceStoreError("trace_event_limit", "The trace event limit has been reached.", status=413)

            encoded_sizes = [
                len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                for event in unique
            ]
            if session.event_bytes + sum(encoded_sizes) > self._max_bytes_per_session:
                raise TraceStoreError("trace_byte_limit", "The trace byte limit has been reached.", status=413)
            incoming_bytes = sum(encoded_sizes)
            self._evict_closed_for_bytes_locked(incoming_bytes, exclude_trace_id=session.id)
            if self._total_event_bytes_locked() + incoming_bytes > self._max_total_bytes:
                raise TraceStoreError("trace_total_byte_limit", "The global trace byte limit has been reached.", status=413)

            session.subject_shapes = next_subject_shapes
            session.model_shapes = next_model_shapes
            session.recording_sequences = next_recording_sequences
            accepted: list[dict[str, Any]] = []
            for event, encoded_size in zip(unique, encoded_sizes):
                now = self._clock()
                stored = {
                    **event,
                    "traceId": session.id,
                    "sequence": len(session.events) + 1,
                    "receivedAt": _utc_timestamp(now),
                }
                session.events.append(stored)
                session.event_ids.add(event["eventId"])
                session.event_bytes += encoded_size
                session.updated_epoch = now
                if event["kind"] == "trace.status":
                    if event["phase"] == "end":
                        session.status = "completed"
                    elif event["phase"] == "error":
                        session.status = "failed"
                accepted.append(copy.deepcopy(stored))
            if accepted:
                self._condition.notify_all()
            return session.metadata(), accepted

    def snapshot(self, trace_id: str, *, after: int = 0) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if after < 0:
            raise TraceStoreError("invalid_cursor", "after must be >= 0.")
        with self._condition:
            session = self._session_locked(trace_id)
            events = copy.deepcopy(session.events[after:])
            return session.metadata(), events

    def wait_for_events(
        self,
        trace_id: str,
        *,
        after: int,
        timeout_seconds: float,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if after < 0:
            raise TraceStoreError("invalid_cursor", "after must be >= 0.")
        deadline = time.monotonic() + max(0, timeout_seconds)
        with self._condition:
            while True:
                session = self._session_locked(trace_id)
                events = session.events[after:]
                if events or session.status != "open":
                    return session.metadata(), copy.deepcopy(events)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return session.metadata(), []
                self._condition.wait(remaining)

    def _session_locked(self, trace_id: str) -> _TraceSession:
        self._cleanup_locked()
        session = self._sessions.get(trace_id)
        if session is None:
            raise TraceStoreError("trace_not_found", "Trace session was not found or expired.", status=404)
        return session

    def _cleanup_locked(self) -> None:
        threshold = self._clock() - self._ttl_seconds
        expired = [
            trace_id
            for trace_id, session in self._sessions.items()
            if session.updated_epoch < threshold
        ]
        for trace_id in expired:
            del self._sessions[trace_id]

    def _evict_closed_for_session_capacity_locked(self) -> None:
        while len(self._sessions) >= self._max_sessions:
            closed = [session for session in self._sessions.values() if session.status != "open"]
            if not closed:
                return
            oldest = min(closed, key=lambda session: session.updated_epoch)
            del self._sessions[oldest.id]

    def _evict_closed_for_bytes_locked(
        self,
        incoming_bytes: int,
        *,
        exclude_trace_id: str,
    ) -> None:
        while self._total_event_bytes_locked() + incoming_bytes > self._max_total_bytes:
            closed = [
                session
                for session in self._sessions.values()
                if session.status != "open" and session.id != exclude_trace_id
            ]
            if not closed:
                return
            oldest = min(closed, key=lambda session: session.updated_epoch)
            del self._sessions[oldest.id]

    def _total_event_bytes_locked(self) -> int:
        return sum(session.event_bytes for session in self._sessions.values())
