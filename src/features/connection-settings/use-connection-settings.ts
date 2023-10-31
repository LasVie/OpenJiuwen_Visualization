import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ManagedEnvironmentClient,
  ManagedEnvironmentClientError,
  type ManagedEnvironmentId,
  type ManagedEnvironmentsSnapshot,
} from "../../adapters/local-environments";
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
  | `${ManagedEnvironmentId}-reconciling`
  | null;

export interface ConnectionSettingsController {
  phase: ConnectionSettingsPhase;
  snapshot: LocalSettingsSnapshot | null;
  environments: ManagedEnvironmentsSnapshot | null;
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
  reconcileEnvironment: (environmentId: ManagedEnvironmentId) => Promise<boolean>;
}

export function useConnectionSettings(
  onSettingsChanged?: () => void | Promise<void>,
  providedClient?: LocalSettingsClient,
  providedEnvironmentClient?: ManagedEnvironmentClient,
): ConnectionSettingsController {
  const defaultClient = useMemo(() => new LocalSettingsClient(), []);
  const defaultEnvironmentClient = useMemo(() => new ManagedEnvironmentClient(), []);
  const client = providedClient ?? defaultClient;
  const environmentClient = providedEnvironmentClient ?? defaultEnvironmentClient;
  const [phase, setPhase] = useState<ConnectionSettingsPhase>("loading");
  const [snapshot, setSnapshot] = useState<LocalSettingsSnapshot | null>(null);
  const [environments, setEnvironments] = useState<ManagedEnvironmentsSnapshot | null>(null);
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
      const [next, nextEnvironments] = await Promise.all([
        client.getSettings(abort.signal),
        environmentClient.getEnvironments(abort.signal),
      ]);
      if (abort.signal.aborted) return;
      setSnapshot(next);
      setEnvironments(nextEnvironments);
      setPhase("ready");
    } catch (caught) {
      if (abort.signal.aborted) return;
      setPhase("offline");
      setError(caught instanceof Error ? caught.message : "无法读取本地连接设置。");
    }
  }, [client, environmentClient]);

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

  const reloadEnvironments = useCallback(async () => {
    try {
      setEnvironments(await environmentClient.getEnvironments());
    } catch {
      // Repository mutations already committed; the next explicit refresh will retry status.
    }
  }, [environmentClient]);

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
      await reloadEnvironments();
      setNotice(`${slot === "agent-core" ? "Agent Core" : "JiuwenSwarm"} 本地仓库已绑定。`);
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法绑定本地仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged, reloadEnvironments]);

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
      await reloadEnvironments();
      setNotice(`${slot === "agent-core" ? "Agent Core" : "JiuwenSwarm"} GitHub 仓库已检出并绑定。`);
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法绑定 GitHub 仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged, reloadEnvironments]);

  const syncRepository = useCallback(async (slot: RepositoryConnectionSlot) => {
    setMutation(`${slot}-syncing`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.syncRepository(slot));
      await reloadEnvironments();
      setNotice("托管仓库已同步到远端目标 ref 的最新 revision。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法同步托管仓库。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged, reloadEnvironments]);

  const resetRepository = useCallback(async (slot: RepositoryConnectionSlot) => {
    setMutation(`${slot}-resetting`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(slot);
    try {
      applyRepository(await client.resetRepository(slot));
      await reloadEnvironments();
      setNotice("自定义绑定已移除，当前恢复 Companion 默认本地来源。");
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法重置代码来源。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applyRepository, client, notifySettingsChanged, reloadEnvironments]);

  const inspectSwarmCoreDependency = useCallback(async () => {
    setMutation("jiuwenswarm-inspecting");
    setError(null);
    setNotice(null);
    setFeedbackTarget("jiuwenswarm");
    try {
      applySwarmCoreDependency(await client.inspectSwarmCoreDependency());
      await reloadEnvironments();
      setNotice("Swarm Config 已重新检查；Core 依赖证据已刷新。");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法检查 Swarm Core 依赖。");
      return false;
    } finally {
      setMutation(null);
    }
  }, [applySwarmCoreDependency, client, reloadEnvironments]);

  const reconcileEnvironment = useCallback(async (
    environmentId: ManagedEnvironmentId,
  ) => {
    const target = environmentId === "core-env" ? "agent-core" : "jiuwenswarm";
    setMutation(`${environmentId}-reconciling`);
    setError(null);
    setNotice(null);
    setFeedbackTarget(target);
    try {
      const response = await environmentClient.reconcile(environmentId);
      setEnvironments(response.environments);
      setNotice(response.result.outcome === "reused"
        ? "受管环境已重新校验，无需重建。"
        : "受管环境已完成构建、验证并原子切换。"
      );
      await notifySettingsChanged();
      return true;
    } catch (caught) {
      setError(
        caught instanceof ManagedEnvironmentClientError && caught.code === "system_clock_invalid"
          ? "Windows 系统日期或时间不正确，无法安全校验 Python 下载证书。请校准系统时间后重试。"
          : caught instanceof Error
            ? caught.message
            : "无法检查并修复受管环境。",
      );
      return false;
    } finally {
      setMutation(null);
    }
  }, [environmentClient, notifySettingsChanged]);

  return {
    phase,
    snapshot,
    environments,
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
    reconcileEnvironment,
  };
}
