import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LocalSettingsClient,
  type LocalSettingsSnapshot,
  type OpenRouterCredentialStatus,
  type RepositoryConnectionSlot,
  type RepositoryConnectionStatus,
  type SwarmCoreDependencyInspection,
} from "../../adapters/local-settings";

export type ConnectionSettingsPhase = "loading" | "ready" | "offline";
export type ConnectionSettingsMutation =
  | "openrouter-saving"
  | "openrouter-deleting"
  | `${RepositoryConnectionSlot}-binding`
  | `${RepositoryConnectionSlot}-syncing`
  | `${RepositoryConnectionSlot}-resetting`
  | "jiuwenswarm-inspecting"
  | null;

export interface ConnectionSettingsController {
  phase: ConnectionSettingsPhase;
  snapshot: LocalSettingsSnapshot | null;
  mutation: ConnectionSettingsMutation;
  error: string | null;
  notice: string | null;
  feedbackTarget: "openrouter" | RepositoryConnectionSlot | null;
  refresh: () => Promise<void>;
  saveOpenRouterCredential: (apiKey: string) => Promise<boolean>;
  deleteOpenRouterCredential: () => Promise<boolean>;
  setLocalRepository: (slot: RepositoryConnectionSlot, path: string) => Promise<boolean>;
  setGitHubRepository: (slot: RepositoryConnectionSlot, url: string, ref?: string) => Promise<boolean>;
  syncRepository: (slot: RepositoryConnectionSlot) => Promise<boolean>;
  resetRepository: (slot: RepositoryConnectionSlot) => Promise<boolean>;
  inspectSwarmCoreDependency: () => Promise<boolean>;
}

export function useConnectionSettings(
  onSettingsChanged?: () => void | Promise<void>,
  providedClient?: LocalSettingsClient,
): ConnectionSettingsController {
  const defaultClient = useMemo(() => new LocalSettingsClient(), []);
  const client = providedClient ?? defaultClient;
  const [phase, setPhase] = useState<ConnectionSettingsPhase>("loading");
  const [snapshot, setSnapshot] = useState<LocalSettingsSnapshot | null>(null);
  const [mutation, setMutation] = useState<ConnectionSettingsMutation>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<
    "openrouter" | RepositoryConnectionSlot | null
  >(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    loadAbortRef.current = abort;
    setPhase("loading");
    setError(null);
    setNotice(null);
    setFeedbackTarget(null);
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

  const applyRepository = useCallback((repository: RepositoryConnectionStatus) => {
    setSnapshot((current) => {
      if (!current) return current;
      const slot = repository.slot === "agent-core" ? "agentCore" : "jiuwenSwarm";
      return {
        ...current,
        settings: {
          ...current.settings,
          repositories: {
            ...current.settings.repositories,
            slots: {
              ...current.settings.repositories.slots,
              [slot]: repository,
            },
          },
        },
      };
    });
    setPhase("ready");
  }, []);

  const applySwarmCoreDependency = useCallback((
    inspection: SwarmCoreDependencyInspection,
  ) => {
    setSnapshot((current) => current ? {
      ...current,
      settings: {
        ...current.settings,
        repositories: {
          ...current.settings.repositories,
          slots: {
            ...current.settings.repositories.slots,
            jiuwenSwarm: {
              ...current.settings.repositories.slots.jiuwenSwarm,
              coreDependency: inspection,
            },
          },
        },
      },
    } : current);
    setPhase("ready");
  }, []);

  const notifySettingsChanged = useCallback(async () => {
    try {
      await onSettingsChanged?.();
    } catch {
      // The setting already committed locally; consumer refresh remains best-effort.
    }
  }, [onSettingsChanged]);

  const saveOpenRouterCredential = useCallback(async (apiKey: string) => {
    setMutation("openrouter-saving");
    setError(null);
    setNotice(null);
    setFeedbackTarget("openrouter");
    try {
      const credential = await client.setOpenRouterCredential(apiKey);
      applyCredential(credential);
      setNotice("OpenRouter API key 已保存并立即生效。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法保存 OpenRouter API key。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyCredential, client, notifySettingsChanged]);

  const deleteOpenRouterCredential = useCallback(async () => {
    setMutation("openrouter-deleting");
    setError(null);
    setNotice(null);
    setFeedbackTarget("openrouter");
    try {
      const credential = await client.deleteOpenRouterCredential();
      applyCredential(credential);
      setNotice(credential.configured
        ? "系统凭据已删除，当前已恢复服务环境中的 key。"
        : "OpenRouter API key 已从本机凭据存储中删除。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法删除 OpenRouter API key。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyCredential, client, notifySettingsChanged]);

  const setLocalRepository = useCallback(async (
    slot: RepositoryConnectionSlot,
    path: string,
  ) => {
    setMutation(`${slot}-binding`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.setLocalRepository(slot, path));
      setNotice(`${slot === "agent-core" ? "Agent Core" : "JiuwenSwarm"} 本地仓库已绑定。`);
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法绑定本地仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged]);

  const setGitHubRepository = useCallback(async (
    slot: RepositoryConnectionSlot,
    url: string,
    ref?: string,
  ) => {
    setMutation(`${slot}-binding`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.setGitHubRepository(slot, url, ref));
      setNotice(`${slot === "agent-core" ? "Agent Core" : "JiuwenSwarm"} GitHub 仓库已检出并绑定。`);
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法绑定 GitHub 仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged]);

  const syncRepository = useCallback(async (slot: RepositoryConnectionSlot) => {
    setMutation(`${slot}-syncing`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.syncRepository(slot));
      setNotice("托管仓库已同步到远端目标 ref 的最新 revision。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法同步托管仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged]);

  const resetRepository = useCallback(async (slot: RepositoryConnectionSlot) => {
    setMutation(`${slot}-resetting`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.resetRepository(slot));
      setNotice("自定义绑定已移除，当前恢复 Companion 默认本地来源。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法重置代码来源。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged]);

  const inspectSwarmCoreDependency = useCallback(async () => {
    setMutation("jiuwenswarm-inspecting");
    setError(null);
    setNotice(null);
    setFeedbackTarget("jiuwenswarm");
    try {
      applySwarmCoreDependency(await client.inspectSwarmCoreDependency());
      setNotice("Swarm Config 已重新检查；Core 依赖证据已刷新。");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法检查 Swarm Core 依赖。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applySwarmCoreDependency, client]);

  return {
    phase,
    snapshot,
    mutation,
    error,
    notice,
    feedbackTarget,
    refresh,
    saveOpenRouterCredential,
    deleteOpenRouterCredential,
    setLocalRepository,
    setGitHubRepository,
    syncRepository,
    resetRepository,
    inspectSwarmCoreDependency,
  };
}
