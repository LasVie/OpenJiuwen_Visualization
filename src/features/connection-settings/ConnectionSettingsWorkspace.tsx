import {
  ArrowRight,
  Cable,
  FolderGit2,
  GitFork,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import type { RepositoryConnectionSlot } from "../../adapters/local-settings";
import { OpenRouterCredentialPanel } from "./OpenRouterCredentialPanel";
import { RepositoryConnectionEditor } from "./RepositoryConnectionEditor";
import { secretStorageLabel } from "./model";
import { useConnectionSettings } from "./use-connection-settings";

type ConnectionPanel = "openrouter" | RepositoryConnectionSlot;

interface ConnectionSettingsWorkspaceProps {
  onSettingsChanged?: () => void | Promise<void>;
}

export function ConnectionSettingsWorkspace({
  onSettingsChanged,
}: ConnectionSettingsWorkspaceProps) {
  const controller = useConnectionSettings(onSettingsChanged);
  const [selected, setSelected] = useState<ConnectionPanel>("openrouter");
  const credential = controller.snapshot?.settings.openRouter ?? null;
  const repositories = controller.snapshot?.settings.repositories ?? null;
  const environments = controller.environments;
  const core = repositories?.slots.agentCore;
  const swarm = repositories?.slots.jiuwenSwarm;
  const coreEnvironment = environments?.environments.coreEnv;
  const swarmEnvironment = environments?.environments.swarmCoreEnv;

  return (
    <section className="connection-settings-workspace">
      <header className="connection-settings-toolbar">
        <div>
          <span aria-hidden="true"><Cable size={20} strokeWidth={2} /></span>
          <div><small>LOCAL CONNECTION CONTROL PLANE</small><h1>连接设置</h1></div>
        </div>
        <p>在网页中统一配置模型凭据、代码来源与两套隔离运行环境。</p>
        <button type="button" onClick={() => void controller.refresh()} disabled={controller.phase === "loading" || controller.mutation !== null}>
          <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
          重新检查
        </button>
      </header>

      {controller.phase === "offline" ? (
        <div className="connection-settings-offline" role="alert">
          <WifiOff size={22} strokeWidth={1.8} aria-hidden="true" />
          <div><strong>本地 Companion 未连接</strong><p>{controller.error}</p></div>
          <button type="button" onClick={() => void controller.refresh()}>重试连接</button>
        </div>
      ) : controller.phase === "loading" && (!credential || !repositories || !environments) ? (
        <div className="connection-settings-loading" role="status">
          <LoaderCircle size={22} strokeWidth={1.8} aria-hidden="true" />
          <span><strong>正在读取本机设置</strong><small>连接仅使用 loopback 地址</small></span>
        </div>
      ) : credential && repositories && environments && core && swarm && coreEnvironment && swarmEnvironment ? (
        <>
          <section className="credential-route" aria-label="连接设置生效路径">
            <article>
              <span><KeyRound size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <div><small>01 · BROWSER</small><strong>网页配置</strong><p>输入只在当前表单停留</p></div>
            </article>
            <ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" />
            <article>
              <span><ServerCog size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <div><small>02 · LOOPBACK</small><strong>本地 Companion</strong><p>验证来源并热更新运行链路</p></div>
            </article>
            <ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" />
            <article className="credential-route__ready">
              <span>{selected === "openrouter" ? <LockKeyhole size={16} strokeWidth={1.8} aria-hidden="true" /> : <FolderGit2 size={16} strokeWidth={1.8} aria-hidden="true" />}</span>
              <div>
                <small>03 · LOCAL AUTHORITY</small>
                <strong>{selected === "openrouter" ? secretStorageLabel(credential) : "uv 受管环境"}</strong>
                <p>{selected === "openrouter" ? "只返回是否已配置" : "锁文件校验后原子切换"}</p>
              </div>
            </article>
          </section>

          <div className="connection-settings-layout">
            <aside className="connection-catalog">
              <header><span>CONNECTIONS</span><em>3</em></header>
              <button type="button" className={`connection-catalog-card connection-catalog-card--provider ${selected === "openrouter" ? "connection-catalog-card--active" : ""}`} aria-current={selected === "openrouter" ? "page" : undefined} onClick={() => setSelected("openrouter")}>
                <span><Network size={18} strokeWidth={2} aria-hidden="true" /></span>
                <div><small>MODEL PROVIDER</small><strong>OpenRouter</strong><p>API key · streaming</p></div>
                <i className={credential.configured ? "connection-state--ready" : "connection-state--missing"} aria-hidden="true" />
              </button>
              <button type="button" className={`connection-catalog-card connection-catalog-card--core ${selected === "agent-core" ? "connection-catalog-card--active" : ""}`} aria-current={selected === "agent-core" ? "page" : undefined} onClick={() => setSelected("agent-core")}>
                <span><FolderGit2 size={18} strokeWidth={2} aria-hidden="true" /></span>
                <div><small>CORE SOURCE</small><strong>Agent Core</strong><p>{coreEnvironment.state === "ready" ? "core-env · 已验证" : `${core.mode === "github" ? core.github?.repository : "本地 Git 仓库"} · ${coreEnvironment.state === "drifted" ? "需更新" : "待创建"}`}</p></div>
                <i className={core.configured && coreEnvironment.state === "ready" ? "connection-state--ready" : "connection-state--missing"} aria-hidden="true" />
              </button>
              <button type="button" className={`connection-catalog-card connection-catalog-card--swarm ${selected === "jiuwenswarm" ? "connection-catalog-card--active" : ""}`} aria-current={selected === "jiuwenswarm" ? "page" : undefined} onClick={() => setSelected("jiuwenswarm")}>
                <span><GitFork size={18} strokeWidth={2} aria-hidden="true" /></span>
                <div><small>SWARM SOURCE</small><strong>JiuwenSwarm</strong><p>{swarmEnvironment.state === "ready" ? "swarm-core-env · 已验证" : `${swarm.mode === "github" ? swarm.github?.repository : "本地 Git 仓库"} · ${swarmEnvironment.state === "drifted" ? "需更新" : "待创建"}`}</p></div>
                <i className={swarm.configured && swarmEnvironment.state === "ready" ? "connection-state--ready" : "connection-state--missing"} aria-hidden="true" />
              </button>
              <section className="connection-catalog-policy">
                <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
                <p><strong>本机控制边界</strong>密钥不回读；源码仓只读；环境只写入本机受管目录。</p>
              </section>
            </aside>

            {selected === "openrouter" ? (
              <OpenRouterCredentialPanel controller={controller} />
            ) : (
              <RepositoryConnectionEditor
                controller={controller}
                connection={selected === "agent-core" ? core : swarm}
              />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
