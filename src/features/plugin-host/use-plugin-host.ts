import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PluginHostClient,
  type PluginHostAuditEvent,
  type PluginHostSnapshot,
} from "../../adapters/plugin-host";

export type PluginHostConnection = "loading" | "ready" | "offline";

export interface PluginHostController {
  connection: PluginHostConnection;
  snapshot: PluginHostSnapshot | null;
  auditEvents: PluginHostAuditEvent[];
  error: string | null;
  mutationKey: string | null;
  refresh: () => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    confirmed?: boolean,
  ) => Promise<boolean>;
  setPermission: (
    pluginId: string,
    permissionId: string,
    granted: boolean,
  ) => Promise<boolean>;
}

export function usePluginHost(
  providedClient?: PluginHostClient,
): PluginHostController {
  const defaultClient = useMemo(() => new PluginHostClient(), []);
  const client = providedClient ?? defaultClient;
  const [connection, setConnection] = useState<PluginHostConnection>("loading");
  const [snapshot, setSnapshot] = useState<PluginHostSnapshot | null>(null);
  const [auditEvents, setAuditEvents] = useState<PluginHostAuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    loadAbortRef.current = abort;
    setConnection("loading");
    setError(null);
    try {
      const [nextSnapshot, audit] = await Promise.all([
        client.getSnapshot(abort.signal),
        client.getAudit({ limit: 200 }, abort.signal),
      ]);
      if (abort.signal.aborted) return;
      setSnapshot(nextSnapshot);
      setAuditEvents(audit.events);
      setConnection("ready");
    } catch (caught) {
      if (abort.signal.aborted) return;
      setConnection("offline");
      setError(
        caught instanceof Error ? caught.message : "无法读取本地 Plugin Host。",
      );
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => loadAbortRef.current?.abort();
  }, [refresh]);

  const reloadAudit = useCallback(async () => {
    try {
      const page = await client.getAudit({ limit: 200 });
      setAuditEvents(page.events);
    } catch {
      // The successful mutation remains authoritative; a later refresh can recover audit.
    }
  }, [client]);

  const setEnabled = useCallback(async (
    pluginId: string,
    enabled: boolean,
    confirmed = false,
  ) => {
    const key = `${pluginId}:lifecycle`;
    setMutationKey(key);
    setError(null);
    try {
      const next = await client.setPluginEnabled(
        pluginId,
        enabled,
        { confirmed },
      );
      setSnapshot(next);
      setConnection("ready");
      await reloadAudit();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法更新插件生命周期。");
      return false;
    } finally {
      setMutationKey(null);
    }
  }, [client, reloadAudit]);

  const setPermission = useCallback(async (
    pluginId: string,
    permissionId: string,
    granted: boolean,
  ) => {
    const key = `${pluginId}:${permissionId}`;
    setMutationKey(key);
    setError(null);
    try {
      const next = await client.setPermission(pluginId, permissionId, granted);
      setSnapshot(next);
      setConnection("ready");
      await reloadAudit();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法更新插件权限。");
      return false;
    } finally {
      setMutationKey(null);
    }
  }, [client, reloadAudit]);

  return {
    connection,
    snapshot,
    auditEvents,
    error,
    mutationKey,
    refresh,
    setEnabled,
    setPermission,
  };
}
