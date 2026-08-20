import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DevelopmentExecutionClient,
  DevelopmentExecutionClientError,
  type DevelopmentCommitPreview,
  type DevelopmentExecution,
  type DevelopmentTestProfile,
} from "../../adapters/development-execution";
import type { DevelopmentAnalysisProjection } from "../development-assistant/model";

export type DevelopmentExecutionConnection =
  | "disabled"
  | "loading"
  | "ready"
  | "offline";

export type DevelopmentExecutionPhase =
  | "idle"
  | "previewing"
  | "loading"
  | "applying"
  | "testing"
  | "commit-previewing"
  | "committing"
  | "rolling-back";

export interface DevelopmentExecutionController {
  connection: DevelopmentExecutionConnection;
  phase: DevelopmentExecutionPhase;
  executions: readonly DevelopmentExecution[];
  total: number;
  execution: DevelopmentExecution | null;
  commitPreview: DevelopmentCommitPreview | null;
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  preview: (unifiedDiff: string) => Promise<DevelopmentExecution | null>;
  load: (executionId: string) => Promise<DevelopmentExecution | null>;
  apply: (approvalSha256: string) => Promise<DevelopmentExecution | null>;
  runTest: (
    profile: DevelopmentTestProfile,
    approvalSha256: string,
  ) => Promise<DevelopmentExecution | null>;
  previewCommit: (message: string) => Promise<DevelopmentCommitPreview | null>;
  commit: (approvalSha256: string) => Promise<DevelopmentExecution | null>;
  rollback: (approvalSha256: string) => Promise<DevelopmentExecution | null>;
  reset: () => void;
  clearCommitPreview: () => void;
  clearError: () => void;
}

function message(error: unknown) {
  if (error instanceof DevelopmentExecutionClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "受控开发执行失败。";
}

function exactDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new TypeError(`${label} 已变化，请重新检查完整预览。`);
  }
}

export function useDevelopmentExecution(options: {
  projection: DevelopmentAnalysisProjection | null;
  enabled: boolean;
  client?: DevelopmentExecutionClient;
}): DevelopmentExecutionController {
  const defaultClient = useMemo(() => new DevelopmentExecutionClient(), []);
  const client = options.client ?? defaultClient;
  const [connection, setConnection] = useState<DevelopmentExecutionConnection>(
    options.enabled ? "loading" : "disabled",
  );
  const [phase, setPhase] = useState<DevelopmentExecutionPhase>("idle");
  const [executions, setExecutions] = useState<readonly DevelopmentExecution[]>([]);
  const [total, setTotal] = useState(0);
  const [execution, setExecution] = useState<DevelopmentExecution | null>(null);
  const [commitPreview, setCommitPreview] = useState<DevelopmentCommitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const projectionRef = useRef(options.projection);
  projectionRef.current = options.projection;
  const scopeRef = useRef({
    enabled: options.enabled,
    projection: options.projection,
    version: 0,
  });
  if (
    scopeRef.current.enabled !== options.enabled ||
    scopeRef.current.projection !== options.projection
  ) {
    scopeRef.current = {
      enabled: options.enabled,
      projection: options.projection,
      version: scopeRef.current.version + 1,
    };
  }

  const scopeIsCurrent = useCallback((version: number) => (
    scopeRef.current.enabled && scopeRef.current.version === version
  ), []);

  const mergeExecution = useCallback((next: DevelopmentExecution, created = false) => {
    setExecution(next);
    setExecutions((current) => [
      next,
      ...current.filter((item) => item.id !== next.id),
    ]);
    setTotal((current) => created ? current + 1 : Math.max(current, 1));
    setCommitPreview(null);
    setConnection("ready");
    return next;
  }, []);

  const refresh = useCallback(async () => {
    if (!options.enabled) {
      setConnection("disabled");
      return;
    }
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    const scopeVersion = scopeRef.current.version;
    loadAbortRef.current = abort;
    setConnection("loading");
    setError(null);
    try {
      const page = await client.list(50, 0, abort.signal);
      if (abort.signal.aborted || !scopeIsCurrent(scopeVersion)) return;
      setExecutions(page.executions);
      setTotal(page.total);
      setConnection("ready");
    } catch (caught) {
      if (abort.signal.aborted || !scopeIsCurrent(scopeVersion)) return;
      setConnection("offline");
      setError(message(caught));
    }
  }, [client, options.enabled, scopeIsCurrent]);

  useEffect(() => {
    if (!options.enabled) {
      loadAbortRef.current?.abort();
      setConnection("disabled");
      setExecutions([]);
      setTotal(0);
      setExecution(null);
      setCommitPreview(null);
      setError(null);
      setPhase("idle");
      return;
    }
    void refresh();
    return () => loadAbortRef.current?.abort();
  }, [options.enabled, refresh]);

  useEffect(() => {
    setExecution(null);
    setCommitPreview(null);
    setError(null);
    setPhase("idle");
  }, [options.projection]);

  const preview = useCallback(async (unifiedDiff: string) => {
    const projection = projectionRef.current;
    if (!projection) {
      setError("请先生成 Development 证据链。");
      return null;
    }
    const scopeVersion = scopeRef.current.version;
    setPhase("previewing");
    setError(null);
    try {
      const next = await client.preview({
        repositoryPath: projection.repository.path,
        baseRevision: projection.repository.revision,
        intent: projection.intent,
        unifiedDiff,
      });
      if (!scopeIsCurrent(scopeVersion)) return null;
      return mergeExecution(next, true);
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, mergeExecution, scopeIsCurrent]);

  const load = useCallback(async (executionId: string) => {
    const scopeVersion = scopeRef.current.version;
    setPhase("loading");
    setError(null);
    try {
      const next = await client.get(executionId);
      return scopeIsCurrent(scopeVersion) ? mergeExecution(next) : null;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, mergeExecution, scopeIsCurrent]);

  const apply = useCallback(async (approvalSha256: string) => {
    if (!execution) return null;
    const scopeVersion = scopeRef.current.version;
    setPhase("applying");
    setError(null);
    try {
      exactDigest(approvalSha256, execution.approvals.applySha256, "Apply 审批摘要");
      const next = await client.apply(execution, true);
      return scopeIsCurrent(scopeVersion) ? mergeExecution(next) : null;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, execution, mergeExecution, scopeIsCurrent]);

  const runTest = useCallback(async (
    profile: DevelopmentTestProfile,
    approvalSha256: string,
  ) => {
    if (!execution) return null;
    const scopeVersion = scopeRef.current.version;
    setPhase("testing");
    setError(null);
    try {
      exactDigest(approvalSha256, profile.planSha256, "Test 审批摘要");
      const next = await client.runTest(execution, profile, true);
      return scopeIsCurrent(scopeVersion) ? mergeExecution(next) : null;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, execution, mergeExecution, scopeIsCurrent]);

  const prepareCommit = useCallback(async (commitMessage: string) => {
    if (!execution) return null;
    const scopeVersion = scopeRef.current.version;
    setPhase("commit-previewing");
    setError(null);
    try {
      const next = await client.previewCommit(execution, commitMessage);
      if (!scopeIsCurrent(scopeVersion)) return null;
      setCommitPreview(next);
      return next;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) {
        setCommitPreview(null);
        setError(message(caught));
      }
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, execution, scopeIsCurrent]);

  const commit = useCallback(async (approvalSha256: string) => {
    if (!execution || !commitPreview) return null;
    const scopeVersion = scopeRef.current.version;
    setPhase("committing");
    setError(null);
    try {
      exactDigest(approvalSha256, commitPreview.approvalSha256, "Commit 审批摘要");
      const next = await client.commit(execution, commitPreview, true);
      return scopeIsCurrent(scopeVersion) ? mergeExecution(next) : null;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, commitPreview, execution, mergeExecution, scopeIsCurrent]);

  const rollback = useCallback(async (approvalSha256: string) => {
    if (!execution) return null;
    const scopeVersion = scopeRef.current.version;
    setPhase("rolling-back");
    setError(null);
    try {
      exactDigest(approvalSha256, execution.approvals.rollbackSha256, "Rollback 审批摘要");
      const next = await client.rollback(execution, true);
      return scopeIsCurrent(scopeVersion) ? mergeExecution(next) : null;
    } catch (caught) {
      if (scopeIsCurrent(scopeVersion)) setError(message(caught));
      return null;
    } finally {
      if (scopeIsCurrent(scopeVersion)) setPhase("idle");
    }
  }, [client, execution, mergeExecution, scopeIsCurrent]);

  const reset = useCallback(() => {
    setExecution(null);
    setCommitPreview(null);
    setError(null);
    setPhase("idle");
  }, []);

  return {
    connection,
    phase,
    executions,
    total,
    execution,
    commitPreview,
    error,
    busy: phase !== "idle",
    refresh,
    preview,
    load,
    apply,
    runTest,
    previewCommit: prepareCommit,
    commit,
    rollback,
    reset,
    clearCommitPreview: () => setCommitPreview(null),
    clearError: () => setError(null),
  };
}
