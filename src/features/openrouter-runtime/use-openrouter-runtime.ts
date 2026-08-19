import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OpenRouterProviderClient,
  type OpenRouterInvocation,
  type OpenRouterProviderStatus,
} from "../../adapters/openrouter-provider";
import type {
  CreatedRuntimeTrace,
  RuntimeTraceSession,
} from "../../kernel";
import type { RuntimeTraceClient } from "../../adapters/runtime-trace";

export type OpenRouterRuntimePhase =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed";

export interface OpenRouterRunRequest {
  modelId: string;
  input: string;
  systemPrompt?: string;
  maxOutputTokens: number;
}

interface UseOpenRouterRuntimeOptions {
  enabled: boolean;
  createTrace: (label: string) => Promise<CreatedRuntimeTrace | null>;
  trace: RuntimeTraceSession | null;
  traceClient: RuntimeTraceClient;
  client?: OpenRouterProviderClient;
}

export interface OpenRouterRuntimeController {
  provider: OpenRouterProviderStatus | null;
  providerLoading: boolean;
  providerError: string | null;
  invocation: OpenRouterInvocation | null;
  phase: OpenRouterRuntimePhase;
  actionError: string | null;
  active: boolean;
  refresh: () => Promise<void>;
  start: (request: OpenRouterRunRequest) => Promise<OpenRouterInvocation | null>;
  cancel: () => Promise<void>;
}

export function useOpenRouterRuntime({
  enabled,
  createTrace,
  trace,
  traceClient,
  client: providedClient,
}: UseOpenRouterRuntimeOptions): OpenRouterRuntimeController {
  const defaultClient = useMemo(() => new OpenRouterProviderClient(), []);
  const client = providedClient ?? defaultClient;
  const [provider, setProvider] = useState<OpenRouterProviderStatus | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [invocation, setInvocation] = useState<OpenRouterInvocation | null>(null);
  const [phase, setPhase] = useState<OpenRouterRuntimePhase>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const registryAbortRef = useRef<AbortController | null>(null);
  const authorityRef = useRef<{
    traceId: string;
    writeToken: string;
    invocationId: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    registryAbortRef.current?.abort();
    if (!enabled) {
      setProvider(null);
      setProviderError(null);
      setProviderLoading(false);
      return;
    }
    const abort = new AbortController();
    registryAbortRef.current = abort;
    setProviderLoading(true);
    setProviderError(null);
    try {
      const status = await client.getStatus(abort.signal);
      if (!abort.signal.aborted) setProvider(status);
    } catch (caught) {
      if (abort.signal.aborted) return;
      setProvider(null);
      setProviderError(
        caught instanceof Error ? caught.message : "无法读取 OpenRouter Provider 状态。",
      );
    } finally {
      if (!abort.signal.aborted) setProviderLoading(false);
    }
  }, [client, enabled]);

  useEffect(() => {
    void refresh();
    return () => registryAbortRef.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (!invocation || trace?.id !== invocation.traceId || trace.status === "open") return;
    authorityRef.current = null;
    setPhase(trace.status === "failed" ? "failed" : "completed");
  }, [invocation, trace]);

  const start = useCallback(async (request: OpenRouterRunRequest) => {
    if (!provider?.configured) {
      setActionError("OpenRouter 尚未在本地服务中配置。");
      return null;
    }
    setPhase("starting");
    setActionError(null);
    setInvocation(null);
    authorityRef.current = null;
    const created = await createTrace(`OpenRouter · ${request.modelId}`);
    if (!created) {
      setPhase("failed");
      setActionError("无法创建 OpenRouter Runtime Trace。");
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
      const message = caught instanceof Error ? caught.message : "无法启动 OpenRouter 调用。";
      try {
        await traceClient.appendEvents(
          created.trace.id,
          created.writeToken,
          [{
            eventId: `openrouter-start-failed-${Date.now()}`,
            kind: "trace.status",
            phase: "error",
            timestampMs: 0,
            spanId: "openrouter-start",
            title: "OpenRouter invocation rejected",
            summary: "本地 Provider adapter 未能接受调用；未向浏览器暴露任何凭据。",
            details: [{ label: "error", value: message.slice(0, 1_000) }],
          }],
        );
      } catch {
        // The original provider error remains the actionable result.
      }
      setPhase("failed");
      setActionError(message);
      return null;
    }
  }, [client, createTrace, provider?.configured, traceClient]);

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
        caught instanceof Error ? caught.message : "无法取消 OpenRouter 调用。",
      );
    }
  }, [client]);

  return {
    provider,
    providerLoading,
    providerError,
    invocation,
    phase,
    actionError,
    active: ["starting", "running", "cancelling"].includes(phase),
    refresh,
    start,
    cancel,
  };
}
