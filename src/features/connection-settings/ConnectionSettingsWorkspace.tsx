import {
  ArrowRight,
  Cable,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  credentialSourceLabel,
  credentialStatusCopy,
  secretStorageLabel,
} from "./model";
import { useConnectionSettings } from "./use-connection-settings";

interface ConnectionSettingsWorkspaceProps {
  onCredentialChanged?: () => void | Promise<void>;
}

export function ConnectionSettingsWorkspace({
  onCredentialChanged,
}: ConnectionSettingsWorkspaceProps) {
  const controller = useConnectionSettings(onCredentialChanged);
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const credential = controller.snapshot?.settings.openRouter ?? null;

  useEffect(() => {
    setConfirmDelete(false);
  }, [credential?.canDelete, credential?.source]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey.trim() || !credential?.writable) return;
    const saved = await controller.saveOpenRouterCredential(apiKey);
    if (saved) {
      setApiKey("");
      setRevealed(false);
    }
  }

  async function removeCredential() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const deleted = await controller.deleteOpenRouterCredential();
    if (deleted) setConfirmDelete(false);
  }

  return (
    <section className="connection-settings-workspace">
      <header className="connection-settings-toolbar">
        <div>
          <span aria-hidden="true"><Cable size={20} strokeWidth={2} /></span>
          <div>
            <small>LOCAL CONNECTION CONTROL PLANE</small>
            <h1>连接设置</h1>
          </div>
        </div>
        <p>集中配置模型凭据与代码来源。敏感值只做一次性写入，不从本机服务回读。</p>
        <button
          type="button"
          onClick={() => void controller.refresh()}
          disabled={controller.phase === "loading" || controller.mutation !== null}
        >
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
      ) : controller.phase === "loading" && !credential ? (
        <div className="connection-settings-loading" role="status">
          <LoaderCircle size={22} strokeWidth={1.8} aria-hidden="true" />
          <span><strong>正在读取本机设置</strong><small>连接仅使用 loopback 地址</small></span>
        </div>
      ) : credential ? (
        <>
          <section className="credential-route" aria-label="API key 保存路径">
            <article>
              <span><KeyRound size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <div><small>01 · BROWSER</small><strong>临时输入</strong><p>提交后清空，不写 localStorage</p></div>
            </article>
            <ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" />
            <article>
              <span><ServerCog size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <div><small>02 · LOOPBACK</small><strong>本地 Companion</strong><p>只接受允许的本机网页来源</p></div>
            </article>
            <ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" />
            <article className={credential.storage.available ? "credential-route__ready" : "credential-route__blocked"}>
              <span><LockKeyhole size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <div><small>03 · OS VAULT</small><strong>{secretStorageLabel(credential)}</strong><p>只返回是否已配置</p></div>
            </article>
          </section>

          <div className="connection-settings-layout">
            <aside className="connection-catalog">
              <header><span>CONNECTIONS</span><em>1</em></header>
              <button type="button" className="connection-catalog-card connection-catalog-card--active" aria-current="page">
                <span><Network size={18} strokeWidth={2} aria-hidden="true" /></span>
                <div><small>MODEL PROVIDER</small><strong>OpenRouter</strong><p>Chat Completions · streaming</p></div>
                <i className={credential.configured ? "connection-state--ready" : "connection-state--missing"} aria-hidden="true" />
              </button>
              <section className="connection-catalog-policy">
                <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
                <p><strong>本机控制边界</strong>配置状态可以被页面读取，凭据原文不能被任何 GET 接口取回。</p>
              </section>
            </aside>

            <main className="connection-detail">
              <header>
                <div className="connection-detail__identity">
                  <span><Network size={22} strokeWidth={2} aria-hidden="true" /></span>
                  <div><small>PROVIDER · OPENROUTER</small><h2>API key</h2></div>
                </div>
                <span className={`credential-status credential-status--${credential.configured ? "ready" : "missing"}`}>
                  {credential.configured ? <Check size={13} strokeWidth={2.2} aria-hidden="true" /> : <KeyRound size={13} strokeWidth={2} aria-hidden="true" />}
                  {credential.configured ? "已配置" : "待配置"}
                </span>
              </header>

              <section className="credential-current-state">
                <div>
                  <span>当前来源</span>
                  <strong>{credentialSourceLabel(credential.source)}</strong>
                </div>
                <div>
                  <span>保存位置</span>
                  <strong>{secretStorageLabel(credential)}</strong>
                </div>
                <div>
                  <span>暴露策略</span>
                  <strong>只写，不回读</strong>
                </div>
                <p>{credentialStatusCopy(credential)}</p>
              </section>

              <form className="credential-form" onSubmit={save} autoComplete="off">
                <label htmlFor="openrouter-api-key">
                  <span>OpenRouter API key <small>WRITE ONLY</small></span>
                  <div className="credential-input-shell">
                    <KeyRound size={16} strokeWidth={1.8} aria-hidden="true" />
                    <input
                      ref={keyInputRef}
                      id="openrouter-api-key"
                      type={revealed ? "text" : "password"}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={credential.configured ? "输入新 key 以替换当前凭据" : "输入 OpenRouter API key"}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={1_280}
                      disabled={!credential.writable || controller.mutation !== null}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setRevealed((current) => !current);
                        window.requestAnimationFrame(() => keyInputRef.current?.focus());
                      }}
                      aria-label={revealed ? "隐藏 API key" : "显示 API key"}
                      aria-pressed={revealed}
                      disabled={!apiKey || controller.mutation !== null}
                    >
                      {revealed ? <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.8} aria-hidden="true" />}
                    </button>
                  </div>
                </label>

                <div className="credential-form__notice">
                  <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
                  <p>保存请求只发往 <code>127.0.0.1</code>。页面提交后会清空输入；key 不进入项目 SQLite、Git、Trace、Context 或 Host 审计。</p>
                </div>

                {controller.error ? <p className="credential-message credential-message--error" role="alert">{controller.error}</p> : null}
                {controller.notice ? <p className="credential-message credential-message--success" role="status">{controller.notice}</p> : null}

                <footer>
                  <span>{credential.writable
                    ? "保存后无需重启，本次服务立即使用新凭据。"
                    : "当前启动方式只允许读取既有配置。"}</span>
                  <div>
                    {credential.canDelete ? (
                      confirmDelete ? (
                        <span className="credential-delete-confirm">
                          <button type="button" onClick={() => setConfirmDelete(false)} disabled={controller.mutation !== null}>取消</button>
                          <button type="button" className="credential-delete-button" onClick={() => void removeCredential()} disabled={controller.mutation !== null}>
                            <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                            确认删除
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="credential-delete-button" onClick={() => void removeCredential()} disabled={controller.mutation !== null}>
                          <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                          删除凭据
                        </button>
                      )
                    ) : null}
                    <button
                      type="submit"
                      className={`credential-save-button ${controller.mutation === "saving" ? "credential-save-button--loading" : ""}`}
                      disabled={!apiKey.trim() || !credential.writable || controller.mutation !== null}
                    >
                      {controller.mutation === "saving" ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" /> : <LockKeyhole size={16} strokeWidth={2} aria-hidden="true" />}
                      {credential.configured ? "保存并替换" : "保存 API key"}
                    </button>
                  </div>
                </footer>
              </form>
            </main>
          </div>
        </>
      ) : null}
    </section>
  );
}
