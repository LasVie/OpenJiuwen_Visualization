import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LocalSettingsClient,
  type LocalSettingsSnapshot,
  type OpenRouterCredentialStatus,
} from "../../adapters/local-settings";

export type ConnectionSettingsPhase = "loading" | "ready" | "offline";
export type ConnectionSettingsMutation = "saving" | "deleting" | null;

export interface ConnectionSettingsController {
  phase: ConnectionSettingsPhase;
  snapshot: LocalSettingsSnapshot | null;
  mutation: ConnectionSettingsMutation;
  error: string | null;
  notice: string | null;
  refresh: () => Promise<void>;
  saveOpenRouterCredential: (apiKey: string) => Promise<boolean>;
  deleteOpenRouterCredential: () => Promise<boolean>;
}

export function useConnectionSettings(
  onCredentialChanged?: () => void | Promise<void>,
  providedClient?: LocalSettingsClient,
): ConnectionSettingsController {
  const defaultClient = useMemo(() => new LocalSettingsClient(), []);
  const client = providedClient ?? defaultClient;
  const [phase, setPhase] = useState<ConnectionSettingsPhase>("loading");
  const [snapshot, setSnapshot] = useState<LocalSettingsSnapshot | null>(null);
  const [mutation, setMutation] = useState<ConnectionSettingsMutation>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    loadAbortRef.current = abort;
    setPhase("loading");
    setError(null);
    try {
      const next = await client.getSettings(abort.signal);
      if (abort.signal.aborted) return;
      setSnapshot(next);
      setPhase("ready");
    } catch (caught) {
      if (abort.signal.aborted) return;
      setPhase("offline");
      setError(caught instanceof Error ? caught.message : "无法读取本地连接设置。");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => loadAbortRef.current?.abort();
  }, [refresh]);

  const applyCredential = useCallback((credential: OpenRouterCredentialStatus) => {
    setSnapshot((current) => current ? {
      ...current,
      settings: { ...current.settings, openRouter: credential },
    } : current);
    setPhase("ready");
  }, []);

  const saveOpenRouterCredential = useCallback(async (apiKey: string) => {
    setMutation("saving");
    setError(null);
    setNotice(null);
    try {
      const credential = await client.setOpenRouterCredential(apiKey);
      applyCredential(credential);
      setNotice("OpenRouter API key 已保存并立即生效。");
      await onCredentialChanged?.();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法保存 OpenRouter API key。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyCredential, client, onCredentialChanged]);

  const deleteOpenRouterCredential = useCallback(async () => {
    setMutation("deleting");
    setError(null);
    setNotice(null);
    try {
      const credential = await client.deleteOpenRouterCredential();
      applyCredential(credential);
      setNotice(credential.configured
        ? "系统凭据已删除，当前已恢复服务环境中的 key。"
        : "OpenRouter API key 已从本机凭据存储中删除。");
      await onCredentialChanged?.();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法删除 OpenRouter API key。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyCredential, client, onCredentialChanged]);

  return {
    phase,
    snapshot,
    mutation,
    error,
    notice,
    refresh,
    saveOpenRouterCredential,
    deleteOpenRouterCredential,
  };
}
