import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DevelopmentSessionClient,
  type DevelopmentSessionStorageDescriptor,
  type DevelopmentSessionSummary,
} from "../../adapters/development-session";
import type { DevelopmentAnalysisProjection } from "./model";
import {
  restoreDevelopmentAnalysis,
  serializeDevelopmentAnalysis,
} from "./session";

export type DevelopmentSessionConnection = "loading" | "ready" | "offline";
export type DevelopmentSessionAction =
  | { kind: "restoring" | "exporting" | "deleting"; id: string }
  | null;

function message(error: unknown) {
  return error instanceof Error ? error.message : "本机 Development Session 操作失败。";
}

function localLabel(projection: DevelopmentAnalysisProjection) {
  const origin = projection.entry?.navigation.origin.plane;
  const route = origin ? `FROM ${origin.toUpperCase()}` : "手动分析";
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return `${projection.repository.name} · ${route} · ${timestamp}`;
}

export function useDevelopmentSessions() {
  const client = useMemo(() => new DevelopmentSessionClient(), []);
  const mounted = useRef(true);
  const [connection, setConnection] = useState<DevelopmentSessionConnection>("loading");
  const [storage, setStorage] = useState<DevelopmentSessionStorageDescriptor | null>(null);
  const [sessions, setSessions] = useState<DevelopmentSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<DevelopmentSessionAction>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setConnection("loading");
    try {
      const result = await client.listSessions({ limit: 100, offset: 0 });
      if (!mounted.current) return;
      setStorage(result.storage);
      setSessions(result.sessions);
      setTotal(result.pagination.total);
      setConnection("ready");
      setError("");
    } catch (caught: unknown) {
      if (!mounted.current) return;
      setConnection("offline");
      setError(message(caught));
    }
  }, [client]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const save = useCallback(async (projection: DevelopmentAnalysisProjection) => {
    setSaving(true);
    try {
      const created = await client.createSession(
        serializeDevelopmentAnalysis(projection),
        { label: localLabel(projection) },
      );
      if (!mounted.current) return null;
      setActiveSessionId(created.id);
      setSessions((current) => [
        created,
        ...current.filter((session) => session.id !== created.id),
      ].slice(0, 100));
      setTotal((current) => current + 1);
      setConnection("ready");
      setError("");
      void refresh(false);
      return created;
    } catch (caught: unknown) {
      if (!mounted.current) return null;
      setError(message(caught));
      return null;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [client, refresh]);

  const restore = useCallback(async (sessionId: string) => {
    setAction({ kind: "restoring", id: sessionId });
    setError("");
    try {
      const detail = await client.getSession(sessionId);
      const projection = restoreDevelopmentAnalysis(detail.analysis);
      if (mounted.current) setActiveSessionId(sessionId);
      return projection;
    } catch (caught: unknown) {
      if (mounted.current) setError(message(caught));
      return null;
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [client]);

  const exportSession = useCallback(async (sessionId: string) => {
    setAction({ kind: "exporting", id: sessionId });
    setError("");
    try {
      const exported = await client.exportSession(sessionId);
      const blob = new Blob([JSON.stringify(exported, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sessionId}-development-session.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (caught: unknown) {
      if (mounted.current) setError(message(caught));
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [client]);

  const deleteSession = useCallback(async (sessionId: string) => {
    setAction({ kind: "deleting", id: sessionId });
    setError("");
    try {
      await client.deleteSession(sessionId);
      if (!mounted.current) return false;
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setTotal((current) => Math.max(0, current - 1));
      setActiveSessionId((current) => current === sessionId ? "" : current);
      void refresh(false);
      return true;
    } catch (caught: unknown) {
      if (mounted.current) setError(message(caught));
      return false;
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [client, refresh]);

  const refreshSessions = useCallback(() => refresh(true), [refresh]);
  const clearError = useCallback(() => setError(""), []);
  const clearActiveSession = useCallback(() => setActiveSessionId(""), []);

  return {
    connection,
    storage,
    sessions,
    total,
    activeSessionId,
    saving,
    action,
    error,
    refresh: refreshSessions,
    save,
    restore,
    exportSession,
    deleteSession,
    clearError,
    clearActiveSession,
  };
}
