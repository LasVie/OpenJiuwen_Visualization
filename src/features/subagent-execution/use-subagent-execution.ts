import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SubagentRuntimeClient,
  type SubagentInvocation,
  type SubagentRuntimeStatus,
} from "../../adapters/subagent-runtime";
import type { RuntimeTraceClient } from "../../adapters/runtime-trace";
import type { CreatedRuntimeTrace, RuntimeTraceSession } from "../../kernel";

export type SubagentExecutionPhase =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed";

export interface SubagentRunRequest {
  modelId: string;
  input: string;
  systemPrompt?: string;
  maxOutputTokens: number;
}

interface UseSubagentExecutionOptions {
  enabled: boolean;
  createTrace: (label: string) => Promise<CreatedRuntimeTrace | null>;
  trace: RuntimeTraceSession | null;
  traceClient: RuntimeTraceClient;
  client?: SubagentRuntimeClient;
}

export interface SubagentExecutionController {
  runtime: SubagentRuntimeStatus | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  invocation: SubagentInvocation | null;
  traceId: string | null;
  phase: SubagentExecutionPhase;
  actionError: string | null;
  active: boolean;
  lastInput: string;
  refresh: () => Promise<void>;
  start: (request: SubagentRunRequest) => Promise<SubagentInvocation | null>;
  cancel: () => Promise<void>;
}

export function useSubagentExecution({
  enabled,
  createTrace,
  trace,
  traceClient,
  client: providedClient,
}: UseSubagentExecutionOptions): SubagentExecutionController {
  const defaultClient = useMemo(() => new SubagentRuntimeClient(), []);
  const client = providedClient ?? defaultClient;
  const [runtime, setRuntime] = useState<SubagentRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [invocation, setInvocation] = useState<SubagentInvocation | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [phase, setPhase] = useState<SubagentExecutionPhase>("idle");
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
        caught instanceof Error ? caught.message : "无法读取 Subagent 运行时状态。",
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

  const start = useCallback(async (request: SubagentRunRequest) => {
    if (!runtime?.configured) {
      setActionError(runtime?.diagnostic.message ?? "Subagent 运行时尚未就绪。");
      return null;
    }
    setPhase("starting");
    setActionError(null);
    setInvocation(null);
    setTraceId(null);
    setLastInput(request.input);
    authorityRef.current = null;
    const created = await createTrace(`Agent Core Subagent · ${request.modelId}`);
    if (!created) {
      setPhase("failed");
      setActionError("无法创建 Subagent Runtime Trace。");
      return null;
    }
    setTraceId(created.trace.id);
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
      const message = caught instanceof Error ? caught.message : "无法启动真实 Subagent。";
      try {
        await traceClient.appendEvents(
          created.trace.id,
          created.writeToken,
          [{
            eventId: `subagent-start-failed-${Date.now()}`,
            kind: "trace.status",
            phase: "error",
            timestampMs: 0,
            spanId: "subagent-start",
            title: "Subagent invocation rejected",
            summary: "本地 Subagent bridge 未接受调用；凭据和输入不会进入错误元数据。",
            details: [{ label: "error", value: message.slice(0, 1_000) }],
          }],
        );
      } catch {
        // Preserve the bridge error as the actionable failure.
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
        caught instanceof Error ? caught.message : "无法取消 Subagent。",
      );
    }
  }, [client]);

  return {
    runtime,
    runtimeLoading,
    runtimeError,
    invocation,
    traceId,
    phase,
    actionError,
    active: ["starting", "running", "cancelling"].includes(phase),
    lastInput,
    refresh,
    start,
    cancel,
  };
}
