import {
  Check,
  CloudDownload,
  FolderGit2,
  GitFork,
  GitPullRequestArrow,
  LoaderCircle,
  MapPin,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type {
  RepositoryConnectionMode,
  RepositoryConnectionStatus,
} from "../../adapters/local-settings";
import type { ConnectionSettingsController } from "./use-connection-settings";
import { SwarmCoreDependencyPanel } from "./SwarmCoreDependencyPanel";

interface RepositoryConnectionEditorProps {
  connection: RepositoryConnectionStatus;
  controller: ConnectionSettingsController;
}

function revisionLabel(connection: RepositoryConnectionStatus) {
  return connection.repository?.revision.slice(0, 12) ?? "等待校验";
}

export function RepositoryConnectionEditor({
  connection,
  controller,
}: RepositoryConnectionEditorProps) {
  const [mode, setMode] = useState<RepositoryConnectionMode>(connection.mode);
  const [localPath, setLocalPath] = useState(connection.path);
  const [githubUrl, setGitHubUrl] = useState(connection.github?.url ?? "");
  const [githubRef, setGitHubRef] = useState(connection.github?.ref ?? "");
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    setMode(connection.mode);
    setLocalPath(connection.path);
    setGitHubUrl(connection.github?.url ?? "");
    setGitHubRef(connection.github?.ref ?? "");
    setConfirmReset(false);
  }, [connection.github?.ref, connection.github?.url, connection.mode, connection.path, connection.updatedAt]);

  const binding = controller.mutation === `${connection.slot}-binding`;
  const syncing = controller.mutation === `${connection.slot}-syncing`;
  const inspecting = controller.mutation === "jiuwenswarm-inspecting";
  const busy = controller.mutation !== null;
  const accentClass = connection.slot === "agent-core" ? "repository-detail--core" : "repository-detail--swarm";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "local") {
      await controller.setLocalRepository(connection.slot, localPath);
    } else {
      await controller.setGitHubRepository(connection.slot, githubUrl, githubRef);
    }
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    if (await controller.resetRepository(connection.slot)) setConfirmReset(false);
  }

  return (
    <main className={`connection-detail repository-detail ${accentClass}`}>
      <header>
        <div className="connection-detail__identity">
          <span><FolderGit2 size={22} strokeWidth={2} aria-hidden="true" /></span>
          <div>
            <small>FRAMEWORK SOURCE · {connection.slot.toUpperCase()}</small>
            <h2>{connection.label}</h2>
          </div>
        </div>
        <span className={`credential-status credential-status--${connection.configured ? "ready" : "missing"}`}>
          {connection.configured ? <Check size={13} strokeWidth={2.2} aria-hidden="true" /> : <MapPin size={13} strokeWidth={2} aria-hidden="true" />}
          {connection.configured ? "可用" : "不可用"}
        </span>
      </header>

      <section className="credential-current-state repository-current-state">
        <div><span>当前方式</span><strong>{connection.mode === "github" ? "GitHub 托管检出" : "本地目录"}</strong></div>
        <div><span>绑定来源</span><strong>{connection.origin === "default" ? "Companion 默认" : "网页配置"}</strong></div>
        <div><span>Revision</span><strong><code>{revisionLabel(connection)}</code></strong></div>
        <p className={connection.configured ? "" : "repository-validation--error"}>{connection.validation.message}</p>
      </section>

      <form className="repository-form" onSubmit={submit}>
        <div className="repository-mode-switch" role="group" aria-label={`${connection.label} 来源类型`}>
          <button type="button" className={mode === "local" ? "repository-mode--active" : ""} aria-pressed={mode === "local"} onClick={() => setMode("local")} disabled={busy}>
            <MapPin size={15} strokeWidth={2} aria-hidden="true" />
            <span><strong>本地目录</strong><small>LOCAL PATH</small></span>
          </button>
          <button type="button" className={mode === "github" ? "repository-mode--active" : ""} aria-pressed={mode === "github"} onClick={() => setMode("github")} disabled={busy}>
            <GitFork size={15} strokeWidth={2} aria-hidden="true" />
            <span><strong>GitHub 仓库</strong><small>PUBLIC HTTPS</small></span>
          </button>
        </div>

        {mode === "local" ? (
          <label className="repository-field" htmlFor={`${connection.slot}-local-path`}>
            <span>仓库绝对路径 <small>ALLOW-ROOT ONLY</small></span>
            <div>
              <MapPin size={16} strokeWidth={1.8} aria-hidden="true" />
              <input
                id={`${connection.slot}-local-path`}
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder={connection.slot === "agent-core" ? "C:\\workspace\\agent-core" : "C:\\workspace\\jiuwenswarm"}
                autoComplete="off"
                spellCheck={false}
                maxLength={2_048}
                disabled={busy}
              />
            </div>
          </label>
        ) : (
          <div className="repository-github-fields">
            <label className="repository-field" htmlFor={`${connection.slot}-github-url`}>
              <span>GitHub 仓库 URL <small>PUBLIC ONLY</small></span>
              <div>
                <GitFork size={16} strokeWidth={1.8} aria-hidden="true" />
                <input
                  id={`${connection.slot}-github-url`}
                  type="url"
                  value={githubUrl}
                  onChange={(event) => setGitHubUrl(event.target.value)}
                  placeholder={connection.slot === "agent-core" ? "https://github.com/LasVie/agent-core" : "https://github.com/LasVie/jiuwenswarm"}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  disabled={busy}
                />
              </div>
            </label>
            <label className="repository-field repository-field--ref" htmlFor={`${connection.slot}-github-ref`}>
              <span>Branch / Tag <small>OPTIONAL</small></span>
              <div>
                <GitPullRequestArrow size={16} strokeWidth={1.8} aria-hidden="true" />
                <input
                  id={`${connection.slot}-github-ref`}
                  value={githubRef}
                  onChange={(event) => setGitHubRef(event.target.value)}
                  placeholder="默认分支"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={255}
                  disabled={busy}
                />
              </div>
            </label>
          </div>
        )}

        <div className="repository-location">
          <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
          <p>{mode === "local"
            ? <>只接受 Companion 启动时授权根目录内的真实 Git 仓库；目标仓库不会被页面修改。</>
            : <>仅匿名访问公开 GitHub 仓库。代码检出到本机受管目录，首次绑定或手动同步时才访问网络。</>}</p>
        </div>

        <section className="repository-evidence" aria-label="当前代码来源证据">
          <div><span>PATH</span><code title={connection.path}>{connection.path}</code></div>
          {connection.github ? <div><span>REMOTE</span><code>{connection.github.repository}{connection.github.ref ? ` · ${connection.github.ref}` : " · default"}</code></div> : null}
          <div><span>BRANCH</span><code>{connection.repository?.branch ?? "unavailable"}{connection.repository?.dirty ? " · dirty" : ""}</code></div>
        </section>

        {connection.slot === "jiuwenswarm" ? (
          <SwarmCoreDependencyPanel
            inspection={connection.coreDependency}
            inspecting={inspecting}
            disabled={busy}
            onInspect={() => void controller.inspectSwarmCoreDependency()}
          />
        ) : null}

        {controller.feedbackTarget === connection.slot && controller.error ? <p className="credential-message credential-message--error" role="alert">{controller.error}</p> : null}
        {controller.feedbackTarget === connection.slot && controller.notice ? <p className="credential-message credential-message--success" role="status">{controller.notice}</p> : null}

        <footer className="repository-form-actions">
          <span>{mode === "github" ? "私有仓库认证暂未开启；URL 中的 token 会被拒绝。" : `允许根：${controller.snapshot?.settings.repositories.policy.allowedRoots.join(" · ")}`}</span>
          <div>
            {connection.canSync ? (
              <button type="button" className={`repository-secondary-button ${syncing ? "repository-action--loading" : ""}`} onClick={() => void controller.syncRepository(connection.slot)} disabled={busy}>
                {syncing ? <LoaderCircle size={15} strokeWidth={2} aria-hidden="true" /> : <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />}
                {syncing ? "同步中" : "同步"}
              </button>
            ) : null}
            {connection.canReset ? (
              confirmReset ? (
                <span className="repository-reset-confirm">
                  <button type="button" onClick={() => setConfirmReset(false)} disabled={busy}>取消</button>
                  <button type="button" className="repository-reset-button" onClick={() => void reset()} disabled={busy}>
                    <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />确认恢复默认
                  </button>
                </span>
              ) : (
                <button type="button" className="repository-reset-button" onClick={() => void reset()} disabled={busy}>
                  <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />恢复默认
                </button>
              )
            ) : null}
            <button
              type="submit"
              className={`repository-bind-button ${binding ? "repository-action--loading" : ""}`}
              disabled={busy || (mode === "local" ? !localPath.trim() : !githubUrl.trim())}
            >
              {binding ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" /> : <CloudDownload size={16} strokeWidth={2} aria-hidden="true" />}
              {binding ? (mode === "github" ? "正在检出" : "正在校验") : (mode === "github" ? "检出并绑定" : "校验并绑定")}
            </button>
          </div>
        </footer>
      </form>
    </main>
  );
}
