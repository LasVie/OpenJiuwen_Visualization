import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OpenRouterProviderClient,
  type OpenRouterInvocation,
  type OpenRouterProviderStatus,
} from "../../adapters/openrouter-provider";
import { RuntimeTraceClient } from "../../adapters/runtime-trace";
import { SourceReaderClient } from "../../adapters/source-reader";
import type { RuntimeTraceSession } from "../../kernel";
import {
  applyDevelopmentEnhancementEvent,
  buildDevelopmentEnhancementPreview,
  developmentEnhancementInvocationRequest,
  developmentEnhancementSourceChoices,
  developmentEnhancementSourceRequest,
  MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_LINES,
  MAX_DEVELOPMENT_ENHANCEMENT_SOURCES,
  parseDevelopmentEnhancementOutput,
  projectDevelopmentEnhancementExcerpt,
  type DevelopmentEnhancementOutboundPreview,
  type DevelopmentEnhancementPhase,
  type DevelopmentEnhancementResult,
} from "./enhancement";
import type { DevelopmentAnalysisProjection } from "./model";

interface UseDevelopmentEnhancementOptions {
  projection: DevelopmentAnalysisProjection | null;
  enabled: boolean;
  providerClient?: OpenRouterProviderClient;
  sourceClient?: SourceReaderClient;
  traceClient?: RuntimeTraceClient;
}

export interface DevelopmentEnhancementController {
  provider: OpenRouterProviderStatus | null;
  providerLoading: boolean;
  providerError: string | null;
  phase: DevelopmentEnhancementPhase;
  preview: DevelopmentEnhancementOutboundPreview | null;
  result: DevelopmentEnhancementResult | null;
  error: string | null;
  active: boolean;
  refreshProvider: () => Promise<void>;
  prepare: (
    sourceIds: readonly string[],
    modelId: string,
    maxOutputTokens: number,
  ) => Promise<DevelopmentEnhancementOutboundPreview | null>;
  invalidatePreview: () => void;
  invoke: (confirmedPayloadSha256: string) => Promise<OpenRouterInvocation | null>;
  cancel: () => Promise<void>;
  clearResult: () => void;
  clearError: () => void;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useDevelopmentEnhancement({
  projection,
  enabled,
  providerClient: providedProviderClient,
  sourceClient: providedSourceClient,
  traceClient: providedTraceClient,
}: UseDevelopmentEnhancementOptions): DevelopmentEnhancementController {
  const defaultProviderClient = useMemo(() => new OpenRouterProviderClient(), []);
  const defaultSourceClient = useMemo(() => new SourceReaderClient(), []);
  const defaultTraceClient = useMemo(() => new RuntimeTraceClient(), []);
  const providerClient = providedProviderClient ?? defaultProviderClient;
  const sourceClient = providedSourceClient ?? defaultSourceClient;
  const traceClient = providedTraceClient ?? defaultTraceClient;
  const [provider, setProvider] = useState<OpenRouterProviderStatus | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [phase, setPhase] = useState<DevelopmentEnhancementPhase>("idle");
  const [preview, setPreview] = useState<DevelopmentEnhancementOutboundPreview | null>(null);
  const [result, setResult] = useState<DevelopmentEnhancementResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerAbortRef = useRef<AbortController | null>(null);
  const prepareAbortRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const seenSequencesRef = useRef(new Set<number>());
  const authorityRef = useRef<{
    traceId: string;
    writeToken: string;
    invocationId: string;
  } | null>(null);
  const previousProjection = useRef(projection);

  const refreshProvider = useCallback(async () => {
    providerAbortRef.current?.abort();
    if (!enabled) {
      setProvider(null);
      setProviderError(null);
      setProviderLoading(false);
      return;
    }
    const controller = new AbortController();
    providerAbortRef.current = controller;
    setProviderLoading(true);
    setProviderError(null);
    try {
      const next = await providerClient.getStatus(controller.signal);
      if (!controller.signal.aborted) setProvider(next);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setProvider(null);
      setProviderError(errorMessage(caught, "无法读取 OpenRouter Provider 状态。"));
    } finally {
      if (!controller.signal.aborted) setProviderLoading(false);
    }
  }, [enabled, providerClient]);

  useEffect(() => {
    void refreshProvider();
    return () => providerAbortRef.current?.abort();
  }, [refreshProvider]);

  useEffect(() => {
    if (previousProjection.current === projection) return;
    previousProjection.current = projection;
    prepareAbortRef.current?.abort();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    seenSequencesRef.current.clear();
    const authority = authorityRef.current;
    authorityRef.current = null;
    if (authority) {
      void providerClient.cancelInvocation(authority.invocationId, authority.writeToken).catch(() => undefined);
    }
    setPreview(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }, [projection, providerClient]);

  useEffect(() => {
    if (enabled) return;
    prepareAbortRef.current?.abort();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    seenSequencesRef.current.clear();
    const authority = authorityRef.current;
    authorityRef.current = null;
    if (authority) {
      void providerClient.cancelInvocation(authority.invocationId, authority.writeToken).catch(() => undefined);
    }
    setPreview(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }, [enabled, providerClient]);

  useEffect(() => () => {
    providerAbortRef.current?.abort();
    prepareAbortRef.current?.abort();
    unsubscribeRef.current?.();
    const authority = authorityRef.current;
    authorityRef.current = null;
    if (authority) {
      void providerClient.cancelInvocation(authority.invocationId, authority.writeToken).catch(() => undefined);
    }
  }, [providerClient]);

  const prepare = useCallback(async (
    sourceIds: readonly string[],
    modelId: string,
    maxOutputTokens: number,
  ) => {
    if (!projection) {
      setError("请先生成确定性 Development 分析链路。");
      return null;
    }
    if (provider?.status !== "ready") {
      setError("OpenRouter Provider 当前不可调用。");
      return null;
    }
    const uniqueIds = [...new Set(sourceIds)];
    if (
      uniqueIds.length < 1 ||
      uniqueIds.length > MAX_DEVELOPMENT_ENHANCEMENT_SOURCES
    ) {
      setError(`请显式选择 1–${MAX_DEVELOPMENT_ENHANCEMENT_SOURCES} 个源码片段。`);
      return null;
    }
    const choices = developmentEnhancementSourceChoices(projection);
    const selected = uniqueIds.map((id) => choices.find((choice) => choice.id === id));
    if (selected.some((choice) => !choice)) {
      setError("所选源码证据已失效，请重新选择。");
      return null;
    }
    prepareAbortRef.current?.abort();
    const controller = new AbortController();
    prepareAbortRef.current = controller;
    setPhase("preparing");
    setPreview(null);
    setResult(null);
    setError(null);
    try {
      const excerpts = await Promise.all(selected.map(async (choice) => {
        const request = developmentEnhancementSourceRequest(choice!.source);
        const source = await sourceClient.read(
          projection.repository.path,
          request,
          {
            contextLines: 0,
            maxLines: MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_LINES,
            maxFileBytes: 2_000_000,
          },
          controller.signal,
        );
        return projectDevelopmentEnhancementExcerpt(choice!, source);
      }));
      if (controller.signal.aborted) return null;
      const next = await buildDevelopmentEnhancementPreview(
        projection,
        modelId,
        maxOutputTokens,
        excerpts,
      );
      if (controller.signal.aborted) return null;
      setPreview(next);
      setPhase("preview");
      return next;
    } catch (caught) {
      if (controller.signal.aborted) return null;
      setPhase("failed");
      setError(errorMessage(caught, "无法生成 OpenRouter 外发预览。"));
      return null;
    } finally {
      if (prepareAbortRef.current === controller) prepareAbortRef.current = null;
    }
  }, [projection, provider?.status, sourceClient]);

  const invalidatePreview = useCallback(() => {
    if (["starting", "running", "cancelling"].includes(phase)) return;
    prepareAbortRef.current?.abort();
    setPreview(null);
    setError(null);
    setPhase("idle");
  }, [phase]);

  const finishFromTrace = useCallback((trace: RuntimeTraceSession) => {
    authorityRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setResult((current) => {
      if (!current) return current;
      const failed = trace.status === "failed" || current.phase === "failed";
      return {
        ...current,
        phase: failed ? "failed" : "completed",
        structured: parseDevelopmentEnhancementOutput(current.output),
        ...(failed && !current.error ? { error: "OpenRouter enhancement trace failed." } : {}),
      };
    });
    setPhase(trace.status === "failed" ? "failed" : "completed");
  }, []);

  const invoke = useCallback(async (confirmedPayloadSha256: string) => {
    if (!preview || preview.payloadSha256 !== confirmedPayloadSha256) {
      setError("外发预览已变化，请重新检查并确认。");
      return null;
    }
    if (provider?.status !== "ready") {
      setError("OpenRouter Provider 当前不可调用。");
      return null;
    }
    setPhase("starting");
    setError(null);
    const baseResult: DevelopmentEnhancementResult = {
      id: "development-enhancement:openrouter",
      phase: "starting",
      providerId: "openrouter",
      modelId: preview.modelId,
      sourceCount: preview.sourceCount,
      payloadSha256: preview.payloadSha256,
      output: "",
    };
    setResult(baseResult);
    let created: Awaited<ReturnType<RuntimeTraceClient["createTrace"]>> | null = null;
    try {
      const estimatedInputTokens = Math.ceil(
        (preview.systemPrompt.length + preview.input.length) / 4,
      );
      created = await traceClient.createTrace({
        owner: "agent-core",
        label: `Development enhancement · ${projection?.repository.name ?? "repository"}`,
        maxTokens: Math.max(8_192, estimatedInputTokens + preview.maxOutputTokens),
      });
      const accepted = await providerClient.startInvocation({
        traceId: created.trace.id,
        writeToken: created.writeToken,
        ...developmentEnhancementInvocationRequest(preview),
      });
      authorityRef.current = {
        traceId: created.trace.id,
        writeToken: created.writeToken,
        invocationId: accepted.id,
      };
      setResult((current) => current ? {
        ...current,
        phase: "running",
        traceId: created!.trace.id,
        invocationId: accepted.id,
      } : current);
      setPhase("running");
      unsubscribeRef.current?.();
      seenSequencesRef.current.clear();
      unsubscribeRef.current = traceClient.subscribe(created.trace.id, 0, {
        onEvent: (event) => {
          if (seenSequencesRef.current.has(event.sequence)) return;
          seenSequencesRef.current.add(event.sequence);
          setResult((current) => current
            ? applyDevelopmentEnhancementEvent(current, event)
            : current);
        },
        onEnd: finishFromTrace,
        onProtocolError: (caught) => setError(caught.message),
      });
      return accepted;
    } catch (caught) {
      const message = errorMessage(caught, "无法启动 OpenRouter 只读增强。");
      if (created) {
        try {
          await traceClient.appendEvents(created.trace.id, created.writeToken, [{
            eventId: `development-enhancement-start-failed-${Date.now()}`,
            kind: "trace.status",
            phase: "error",
            timestampMs: 0,
            spanId: "development-enhancement",
            title: "Development enhancement rejected",
            summary: "OpenRouter adapter 未接受本次显式确认的外发预览。",
            details: [{ label: "error", value: message.slice(0, 1_000) }],
          }]);
        } catch {
          // Preserve the original provider error.
        }
      }
      authorityRef.current = null;
      setPhase("failed");
      setError(message);
      setResult((current) => current ? {
        ...current,
        phase: "failed",
        ...(created ? { traceId: created.trace.id } : {}),
        error: message,
      } : current);
      return null;
    }
  }, [finishFromTrace, preview, projection?.repository.name, provider?.status, providerClient, traceClient]);

  const cancel = useCallback(async () => {
    const authority = authorityRef.current;
    if (!authority) return;
    setPhase("cancelling");
    setResult((current) => current ? { ...current, phase: "cancelling" } : current);
    setError(null);
    try {
      await providerClient.cancelInvocation(authority.invocationId, authority.writeToken);
    } catch (caught) {
      setPhase("running");
      setResult((current) => current ? { ...current, phase: "running" } : current);
      setError(errorMessage(caught, "无法取消 OpenRouter 增强调用。"));
    }
  }, [providerClient]);

  const clearResult = useCallback(() => {
    if (["starting", "running", "cancelling"].includes(phase)) return;
    setResult(null);
    setPreview(null);
    setError(null);
    setPhase("idle");
  }, [phase]);

  return {
    provider,
    providerLoading,
    providerError,
    phase,
    preview,
    result,
    error,
    active: ["starting", "running", "cancelling"].includes(phase),
    refreshProvider,
    prepare,
    invalidatePreview,
    invoke,
    cancel,
    clearResult,
    clearError: () => setError(null),
  };
}
