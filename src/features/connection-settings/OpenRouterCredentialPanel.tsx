import {
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  credentialSourceLabel,
  credentialStatusCopy,
  secretStorageLabel,
} from "./model";
import type { ConnectionSettingsController } from "./use-connection-settings";

interface OpenRouterCredentialPanelProps {
  controller: ConnectionSettingsController;
}

export function OpenRouterCredentialPanel({
  controller,
}: OpenRouterCredentialPanelProps) {
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const credential = controller.snapshot?.settings.openRouter;

  useEffect(() => {
    setConfirmDelete(false);
  }, [credential?.canDelete, credential?.source]);

  if (!credential) return null;

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

  const busy = controller.mutation !== null;
  const saving = controller.mutation === "openrouter-saving";

  return (
    <main className="connection-detail connection-detail--openrouter">
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
        <div><span>当前来源</span><strong>{credentialSourceLabel(credential.source)}</strong></div>
        <div><span>保存位置</span><strong>{secretStorageLabel(credential)}</strong></div>
        <div><span>暴露策略</span><strong>只写，不回读</strong></div>
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
              disabled={!credential.writable || busy}
            />
            <button
              type="button"
              onClick={() => {
                setRevealed((current) => !current);
                window.requestAnimationFrame(() => keyInputRef.current?.focus());
              }}
              aria-label={revealed ? "隐藏 API key" : "显示 API key"}
              aria-pressed={revealed}
              disabled={!apiKey || busy}
            >
              {revealed ? <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.8} aria-hidden="true" />}
            </button>
          </div>
        </label>

        <div className="credential-form__notice">
          <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
          <p>保存请求只发往 <code>127.0.0.1</code>。页面提交后会清空输入；key 不进入项目 SQLite、Git、Trace、Context 或 Host 审计。</p>
        </div>

        {controller.feedbackTarget === "openrouter" && controller.error ? <p className="credential-message credential-message--error" role="alert">{controller.error}</p> : null}
        {controller.feedbackTarget === "openrouter" && controller.notice ? <p className="credential-message credential-message--success" role="status">{controller.notice}</p> : null}

        <footer>
          <span>{credential.writable
            ? "保存后无需重启，本次服务立即使用新凭据。"
            : "当前启动方式只允许读取既有配置。"}</span>
          <div>
            {credential.canDelete ? (
              confirmDelete ? (
                <span className="credential-delete-confirm">
                  <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>取消</button>
                  <button type="button" className="credential-delete-button" onClick={() => void removeCredential()} disabled={busy}>
                    <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                    确认删除
                  </button>
                </span>
              ) : (
                <button type="button" className="credential-delete-button" onClick={() => void removeCredential()} disabled={busy}>
                  <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                  删除凭据
                </button>
              )
            ) : null}
            <button
              type="submit"
              className={`credential-save-button ${saving ? "credential-save-button--loading" : ""}`}
              disabled={!apiKey.trim() || !credential.writable || busy}
            >
              {saving ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" /> : <LockKeyhole size={16} strokeWidth={2} aria-hidden="true" />}
              {credential.configured ? "保存并替换" : "保存 API key"}
            </button>
          </div>
        </footer>
      </form>
    </main>
  );
}
