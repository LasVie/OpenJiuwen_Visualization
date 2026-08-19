import type { GraphSourceReference } from "../../kernel";
import { sourceLocationKey } from "../../kernel";
import type {
  ArchivedEventPreview,
  ArchivedSessionDetail,
  ArchivedTraceSession,
} from "../../adapters/trace-archive";

export type RunComparisonStatus = "added" | "removed" | "changed" | "unchanged";

export interface RunComparisonSide {
  count: number;
  lastPhase: string;
  firstSequence: number;
  lastSequence: number;
}

export interface RunComparisonRow {
  identity: string;
  label: string;
  kind: string;
  status: RunComparisonStatus;
  sourceBacked: boolean;
  left?: RunComparisonSide;
  right?: RunComparisonSide;
}

export interface RunMetricDelta {
  left: number;
  right: number;
  delta: number;
}

export interface RunComparison {
  left: ArchivedTraceSession;
  right: ArchivedTraceSession;
  metrics: {
    events: RunMetricDelta;
    totalTokens: RunMetricDelta;
    inputTokens: RunMetricDelta;
    outputTokens: RunMetricDelta;
    contextMessages: RunMetricDelta;
    costMicros: RunMetricDelta;
    storedRawBytes: RunMetricDelta;
  };
  rows: RunComparisonRow[];
  summary: Record<RunComparisonStatus, number>;
}

interface EventIdentity {
  key: string;
  label: string;
  sourceBacked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceReference(value: unknown): value is GraphSourceReference {
  return (
    isRecord(value) &&
    typeof value.repository === "string" &&
    typeof value.path === "string" &&
    (value.revision === undefined || typeof value.revision === "string") &&
    (value.symbol === undefined || typeof value.symbol === "string")
  );
}

function eventIdentity(event: ArchivedEventPreview): EventIdentity {
  if (sourceReference(event.definition)) {
    return {
      key: `source:${sourceLocationKey(event.definition)}`,
      label: event.definition.symbol ?? event.definition.path,
      sourceBacked: true,
    };
  }
  const subject = event.subject;
  if (isRecord(subject) && typeof subject.id === "string") {
    return {
      key: `runtime:${event.kind}:${subject.id}`,
      label: typeof subject.label === "string" ? subject.label : subject.id,
      sourceBacked: false,
    };
  }
  return {
    key: `runtime:${event.kind}:<trace>`,
    label: event.title ?? event.kind,
    sourceBacked: false,
  };
}

function aggregate(events: readonly ArchivedEventPreview[]) {
  const result = new Map<string, {
    identity: EventIdentity;
    kind: string;
    side: RunComparisonSide;
  }>();
  events.forEach((event) => {
    const identity = eventIdentity(event);
    const current = result.get(identity.key);
    if (current) {
      current.side.count += 1;
      current.side.lastPhase = event.phase;
      current.side.lastSequence = event.sequence;
      return;
    }
    result.set(identity.key, {
      identity,
      kind: event.kind,
      side: {
        count: 1,
        lastPhase: event.phase,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
      },
    });
  });
  return result;
}

function metric(left: number, right: number): RunMetricDelta {
  return { left, right, delta: right - left };
}

const statusOrder: Record<RunComparisonStatus, number> = {
  changed: 0,
  added: 1,
  removed: 2,
  unchanged: 3,
};

export function compareArchivedRuns(
  left: ArchivedSessionDetail,
  right: ArchivedSessionDetail,
): RunComparison {
  const leftEvents = aggregate(left.events);
  const rightEvents = aggregate(right.events);
  const identities = new Set([...leftEvents.keys(), ...rightEvents.keys()]);
  const rows = [...identities].map((identity): RunComparisonRow => {
    const leftEntry = leftEvents.get(identity);
    const rightEntry = rightEvents.get(identity);
    const common = leftEntry ?? rightEntry!;
    const status: RunComparisonStatus = !leftEntry
      ? "added"
      : !rightEntry
        ? "removed"
        : leftEntry.side.count !== rightEntry.side.count ||
            leftEntry.side.lastPhase !== rightEntry.side.lastPhase
          ? "changed"
          : "unchanged";
    return {
      identity,
      label: common.identity.label,
      kind: common.kind,
      status,
      sourceBacked: common.identity.sourceBacked,
      ...(leftEntry ? { left: leftEntry.side } : {}),
      ...(rightEntry ? { right: rightEntry.side } : {}),
    };
  }).sort((leftRow, rightRow) =>
    statusOrder[leftRow.status] - statusOrder[rightRow.status] ||
    leftRow.identity.localeCompare(rightRow.identity));

  const summary: Record<RunComparisonStatus, number> = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  };
  rows.forEach((row) => { summary[row.status] += 1; });

  return {
    left: left.session,
    right: right.session,
    metrics: {
      events: metric(left.session.eventCount, right.session.eventCount),
      totalTokens: metric(left.session.totalTokens, right.session.totalTokens),
      inputTokens: metric(left.session.inputTokens, right.session.inputTokens),
      outputTokens: metric(left.session.outputTokens, right.session.outputTokens),
      contextMessages: metric(
        left.session.contextMessageCount,
        right.session.contextMessageCount,
      ),
      costMicros: metric(left.session.costMicros, right.session.costMicros),
      storedRawBytes: metric(left.session.storedRawBytes, right.session.storedRawBytes),
    },
    rows,
    summary,
  };
}
