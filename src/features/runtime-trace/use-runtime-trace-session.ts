import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RuntimeTraceClient } from "../../adapters/runtime-trace";
import type {
  CreatedRuntimeTrace,
  RuntimeOwner,
  RuntimeTraceEvent,
  RuntimeTraceSession,
} from "../../kernel";

export type RuntimeTraceConnectionState =
  | "idle"
  | "creating"
  | "connected"
  | "reconnecting"
  | "completed"
  | "failed";

interface RuntimeTraceSessionOptions {
  owner: RuntimeOwner;
  maxTokens: number;
  client?: RuntimeTraceClient;
}

function mergeEvents(
  current: readonly RuntimeTraceEvent[],
  additions: readonly RuntimeTraceEvent[],
) {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  additions.forEach((event) => bySequence.set(event.sequence, event));
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function mergeTraceSession(
  current: RuntimeTraceSession | null,
  incoming: RuntimeTraceSession,
) {
  if (!current || current.id !== incoming.id) return incoming;
  const incomingIsNewer = incoming.lastSequence >= current.lastSequence;
  return {
    ...(incomingIsNewer ? incoming : current),
    eventCount: Math.max(current.eventCount, incoming.eventCount),
    lastSequence: Math.max(current.lastSequence, incoming.lastSequence),
    byteCount: Math.max(current.byteCount, incoming.byteCount),
    status: incoming.status === "open" ? current.status : incoming.status,
  };
}

export function useRuntimeTraceSession({
  owner,
  maxTokens,
  client: providedClient,
}: RuntimeTraceSessionOptions) {
  const defaultClient = useMemo(() => new RuntimeTraceClient(), []);
  const client = providedClient ?? defaultClient;
  const [created, setCreated] = useState<CreatedRuntimeTrace | null>(null);
  const [trace, setTrace] = useState<RuntimeTraceSession | null>(null);
  const [events, setEvents] = useState<RuntimeTraceEvent[]>([]);
  const [connection, setConnection] =
    useState<RuntimeTraceConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);

  const closeStream = useCallback(() => {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      createAbortRef.current?.abort();
      closeStream();
    },
    [closeStream],
  );

  const startSession = useCallback(
    async (label: string) => {
      createAbortRef.current?.abort();
      closeStream();
      const abort = new AbortController();
      createAbortRef.current = abort;
      setConnection("creating");
      setError(null);
      setCreated(null);
      setTrace(null);
      setEvents([]);

      try {
        const nextCreated = await client.createTrace(
          { owner, label, maxTokens },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (nextCreated.trace.owner !== owner) {
          throw new TypeError(
            `Runtime trace owner mismatch: expected ${owner}, received ${nextCreated.trace.owner}.`,
          );
        }
        setCreated(nextCreated);
        setTrace(nextCreated.trace);

        const close = client.subscribe(nextCreated.trace.id, 0, {
          onOpen: () => {
            setConnection("connected");
            setError(null);
          },
          onReconnect: () => setConnection((state) =>
            state === "completed" || state === "failed" ? state : "reconnecting"),
          onEvent: (event) => {
            setEvents((current) => mergeEvents(current, [event]));
            setTrace((current) => current
              ? {
                  ...current,
                  updatedAt: event.receivedAt,
                  eventCount: Math.max(current.eventCount, event.sequence),
                  lastSequence: Math.max(current.lastSequence, event.sequence),
                  status:
                    event.kind === "trace.status" && event.phase === "end"
                      ? "completed"
                      : event.kind === "trace.status" && event.phase === "error"
                        ? "failed"
                        : current.status,
                }
              : current);
          },
          onEnd: (endedTrace) => {
            setTrace(endedTrace);
            setConnection(endedTrace.status === "failed" ? "failed" : "completed");
          },
          onProtocolError: (protocolError) => {
            closeStream();
            setError(protocolError.message);
            setConnection("failed");
          },
        });
        closeStreamRef.current = close;

        const initial = await client.getSnapshot(nextCreated.trace.id, 0, abort.signal);
        if (!abort.signal.aborted) {
          setTrace((current) => mergeTraceSession(current, initial.trace));
          setEvents((current) => mergeEvents(current, initial.events));
        }
      } catch (caught) {
        if (abort.signal.aborted) return;
        closeStream();
        setConnection("failed");
        setError(caught instanceof Error ? caught.message : "无法创建本地 Trace 会话。");
      }
    },
    [client, closeStream, maxTokens, owner],
  );

  return {
    client,
    created,
    trace,
    events,
    connection,
    error,
    startSession,
  };
}
