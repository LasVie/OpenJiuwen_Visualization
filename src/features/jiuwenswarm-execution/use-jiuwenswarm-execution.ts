import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  JiuwenSwarmRuntimeClient,
  type JiuwenSwarmInvocation,
  type JiuwenSwarmRuntimeStatus,
} from "../../adapters/jiuwenswarm-runtime";
import type { RuntimeTraceClient } from "../../adapters/runtime-trace";
import type { CreatedRuntimeTrace, RuntimeTraceSession } from "../../kernel";

export type JiuwenSwarmExecutionPhase =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed";

export interface JiuwenSwarmRunRequest {
  modelId: string;
  input: string;
  systemPrompt?: string;
  maxOutputTokens: number;
}

interface UseJiuwenSwarmExecutionOptions {
  enabled: boolean;
  createTrace: (label: string) => Promise<CreatedRuntimeTrace | null>;
  trace: RuntimeTraceSession | null;
  traceClient: RuntimeTraceClient;
  client?: JiuwenSwarmRuntimeClient;
}

export interface JiuwenSwarmExecutionController {
  runtime: JiuwenSwarmRuntimeStatus | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  invocation: JiuwenSwarmInvocation | null;
  phase: JiuwenSwarmExecutionPhase;
  actionError: string | null;
  active: boolean;
  lastInput: string;
  refresh: () => Promise<void>;
  start: (request: JiuwenSwarmRunRequest) => Promise<JiuwenSwarmInvocation | null>;
  cancel: () => Promise<void>;
}

export function useJiuwenSwarmExecution({
  enabled,
  createTrace,
  trace,
  traceClient,
  client: providedClient,
}: UseJiuwenSwarmExecutionOptions): JiuwenSwarmExecutionController {
  const defaultClient = useMemo(() => new JiuwenSwarmRuntimeClient(), []);
  const client = providedClient ?? defaultClient;
  const [runtime, setRuntime] = useState<JiuwenSwarmRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [invocation, setInvocation] = useState<JiuwenSwarmInvocation | null>(null);
  const [phase, setPhase] = useState<JiuwenSwarmExecutionPhase>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState("");
  const registryAbortRef = useRef<AbortController | null>(null);
  const authorityRef = useRef<{
    traceId: string;
    writeToken: string;
    invocationId: string;
  } | null>(null);

  const loadRuntime = useCallback(async (force: boolean) => {
    registryAbortRef.current?.abort();
    if (!enabled) {
      setRuntime(null);
      setRuntimeError(null);
      setRuntimeLoading(false);
      return;
    }
    const abort = new AbortController();
    registryAbortRef.current = abort;
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const status = await client.getStatus(abort.signal, force);
      if (!abort.signal.aborted) setRuntime(status);
    } catch (caught) {
      if (abort.signal.aborted) return;
      setRuntime(null);
      setRuntimeError(
        caught instanceof Error ? caught.message : "无法读取 JiuwenSwarm 运行时状态。",
      );
    } finally {
      if (!abort.signal.aborted) setRuntimeLoading(false);
    }
  }, [client, enabled]);

  const refresh = useCallback(() => loadRuntime(true), [loadRuntime]);

  useEffect(() => {
    void loadRuntime(false);
    return () => registryAbortRef.current?.abort();
  }, [loadRuntime]);

  useEffect(() => {
    if (!invocation || trace?.id !== invocation.traceId || trace.status === "open") return;
    authorityRef.current = null;
    setPhase(trace.status === "failed" ? "failed" : "completed");
  }, [invocation, trace]);

  const start = useCallback(async (request: JiuwenSwarmRunRequest) => {
    if (!runtime?.configured) {
      setActionError(runtime?.diagnostic.message ?? "JiuwenSwarm 运行时尚未就绪。");
      return null;
    }
    setPhase("starting");
    setActionError(null);
    setInvocation(null);
    setLastInput(request.input);
    authorityRef.current = null;
    const created = await createTrace(`JiuwenSwarm Agent Team · ${request.modelId}`);
    if (!created) {
      setPhase("failed");
      setActionError("无法创建 JiuwenSwarm Runtime Trace。");
      return null;
    }
    try {
      const accepted = await client.startInvocation({
        traceId: created.trace.id,
        writeToken: created.writeToken,
        ...request,
      });
      authorityRef.current = {
        traceId: created.trace.id,
        writeToken: created.writeToken,
        invocationId: accepted.id,
      };
      setInvocation(accepted);
      setPhase("running");
      return accepted;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法启动 JiuwenSwarm Agent Team。";
      try {
        await traceClient.appendEvents(
          created.trace.id,
          created.writeToken,
          [{
            eventId: `jiuwenswarm-start-failed-${Date.now()}`,
            kind: "trace.status",
            phase: "error",
            timestampMs: 0,
            spanId: "jiuwenswarm-start",
            title: "JiuwenSwarm invocation rejected",
            summary: "本地团队桥接未能接受调用；凭据和输入不会进入错误元数据。",
            details: [{ label: "error", value: message.slice(0, 1_000) }],
          }],
        );
      } catch {
        // Keep the original bridge error as the actionable result.
      }
      setPhase("failed");
      setActionError(message);
      return null;
    }
  }, [client, createTrace, runtime, traceClient]);

  const cancel = useCallback(async () => {
    const authority = authorityRef.current;
    if (!authority) return;
    setPhase("cancelling");
    setActionError(null);
    try {
      const cancelling = await client.cancelInvocation(
        authority.invocationId,
        authority.writeToken,
      );
      setInvocation(cancelling);
    } catch (caught) {
      setPhase("running");
      setActionError(
        caught instanceof Error ? caught.message : "无法取消 JiuwenSwarm Agent Team。",
      );
    }
  }, [client]);

  return {
    runtime,
    runtimeLoading,
    runtimeError,
    invocation,
    phase,
    actionError,
    active: ["starting", "running", "cancelling"].includes(phase),
    lastInput,
    refresh,
    start,
    cancel,
  };
}
