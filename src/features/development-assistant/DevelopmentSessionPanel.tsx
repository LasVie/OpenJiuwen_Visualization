import {
  AlertTriangle,
  Database,
  Download,
  GitBranch,
  HardDrive,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DevelopmentSessionStorageDescriptor,
  DevelopmentSessionSummary,
} from "../../adapters/development-session";
import type {
  DevelopmentSessionAction,
  DevelopmentSessionConnection,
} from "./use-development-sessions";

interface DevelopmentSessionPanelProps {
  open: boolean;
  connection: DevelopmentSessionConnection;
  storage: DevelopmentSessionStorageDescriptor | null;
  sessions: readonly DevelopmentSessionSummary[];
  total: number;
  activeSessionId: string;
  action: DevelopmentSessionAction;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onRestore: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
  onDelete: (sessionId: string) => Promise<boolean>;
  onClearError: () => void;
}

function bytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

function date(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function ownerLabel(owner: string) {
  if (owner === "agent-core") return "CORE";
  if (owner === "jiuwenswarm") return "SWARM";
  return "LOCAL";
}

function actionMatches(
  action: DevelopmentSessionAction,
  sessionId: string,
  kind: NonNullable<DevelopmentSessionAction>["kind"],
) {
  return action?.id === sessionId && action.kind === kind;
}

export function DevelopmentSessionPanel({
  open,
  connection,
  storage,
  sessions,
  total,
  activeSessionId,
  action,
  error,
  onClose,
  onRefresh,
  onRestore,
  onExport,
  onDelete,
  onClearError,
}: DevelopmentSessionPanelProps) {
  const [deleteId, setDeleteId] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const deleteIdRef = useRef(deleteId);
  const onCloseRef = useRef(onClose);
  deleteIdRef.current = deleteId;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (deleteIdRef.current) setDeleteId("");
        else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) setDeleteId("");
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="development-session-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="development-session-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="development-session-title"
      >
        <header className="development-session-panel__header">
          <span className="development-session-panel__icon">
            <History size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <span>
            <small>LOCAL DEVELOPMENT HISTORY</small>
            <strong id="development-session-title">分析 Sessions</strong>
          </span>
          <button type="button" onClick={onRefresh} aria-label="刷新 Development Sessions">
            <RefreshCw
              size={16}
              strokeWidth={1.8}
              className={connection === "loading" ? "spin" : ""}
              aria-hidden="true"
            />
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭 Development Sessions">
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        {storage ? (
          <section className="development-session-storage" aria-label="本机 Session 存储状态">
            <span><Database size={14} strokeWidth={1.8} aria-hidden="true" /><b>{storage.sessionCount}</b><small>SESSIONS</small></span>
            <span><HardDrive size={14} strokeWidth={1.8} aria-hidden="true" /><b>{bytes(storage.storedBytes)}</b><small>LOCAL / {bytes(storage.maxBytes)}</small></span>
            <span><ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" /><b>{storage.retentionDays} 天</b><small>RETENTION</small></span>
          </section>
        ) : null}

        <div className="development-session-assurance">
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          <span><strong>SQLite · WAL · 仅本机</strong><small>列表不读取完整分析；恢复或导出才读取原始意图与全部结果。</small></span>
        </div>

        {error ? (
          <div className="development-session-error" role="alert">
            <AlertTriangle size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>{error}</span>
            <button type="button" onClick={onClearError} aria-label="关闭错误提示"><X size={14} /></button>
          </div>
        ) : null}

        <div className="development-session-list" aria-busy={connection === "loading"}>
          <div className="development-session-list__heading">
            <span>最近记录</span>
            <em>{sessions.length}{total > sessions.length ? ` / ${total}` : ""}</em>
          </div>

          {connection === "loading" && !sessions.length ? (
            <div className="development-session-state">
              <LoaderCircle className="spin" size={22} strokeWidth={1.8} aria-hidden="true" />
              <strong>读取本机 Session 索引</strong>
              <p>完整分析不会在列表阶段读取。</p>
            </div>
          ) : connection === "offline" && !sessions.length ? (
            <div className="development-session-state development-session-state--error">
              <AlertTriangle size={22} strokeWidth={1.8} aria-hidden="true" />
              <strong>Session 服务未连接</strong>
              <p>当前分析仍可使用，但不会被静默保存。</p>
              <button type="button" onClick={onRefresh}><RefreshCw size={14} />重新连接</button>
            </div>
          ) : !sessions.length ? (
            <div className="development-session-state">
              <History size={24} strokeWidth={1.6} aria-hidden="true" />
              <strong>还没有分析 Session</strong>
              <p>下一次成功生成分析链路后，会自动保存在本机数据库。</p>
            </div>
          ) : (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              const deleting = actionMatches(action, session.id, "deleting");
              const busy = action?.id === session.id;
              return (
                <article
                  key={session.id}
                  className={active
                    ? "development-session-card development-session-card--active"
                    : "development-session-card"}
                >
                  <header>
                    <span className={`development-session-owner development-session-owner--${session.repository.owner}`}>
                      {ownerLabel(session.repository.owner)}
                    </span>
                    <span>
                      <strong>{session.label}</strong>
                      <small>{date(session.updatedAt)} · {session.engine}</small>
                    </span>
                    {active ? <em>当前</em> : null}
                  </header>
                  <p>{session.intentPreview}</p>
                  <code>{session.repository.name}/{session.repository.branch}@{session.repository.revision.slice(0, 10)}</code>
                  <dl>
                    <div><dt>EVIDENCE</dt><dd>{session.counts.evidence}</dd></div>
                    <div><dt>IMPACT</dt><dd>{session.counts.impacts}</dd></div>
                    <div><dt>PLAN</dt><dd>{session.counts.changes}</dd></div>
                    <div><dt>TEST</dt><dd>{session.counts.tests}</dd></div>
                  </dl>
                  <footer>
                    <span><GitBranch size={11} aria-hidden="true" />{session.repository.dirty ? "dirty snapshot" : "clean snapshot"}</span>
                    {session.entryPlane ? <span>FROM {session.entryPlane.toUpperCase()}</span> : null}
                    <span>{bytes(session.byteCount)}</span>
                  </footer>

                  {deleteId === session.id ? (
                    <div className="development-session-delete" role="alertdialog" aria-label={`确认删除 ${session.label}`}>
                      <span><strong>永久删除此 Session？</strong><small>原始意图、结构化结果与索引会一起删除。</small></span>
                      <button type="button" onClick={() => setDeleteId("")} disabled={deleting}>取消</button>
                      <button
                        type="button"
                        className="development-session-delete__danger"
                        disabled={deleting}
                        onClick={() => void onDelete(session.id).then((deleted) => {
                          if (deleted) setDeleteId("");
                        })}
                      >
                        {deleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                        确认删除
                      </button>
                    </div>
                  ) : (
                    <div className="development-session-actions">
                      <button type="button" disabled={Boolean(action)} onClick={() => onRestore(session.id)}>
                        {actionMatches(action, session.id, "restoring")
                          ? <LoaderCircle className="spin" size={14} />
                          : <RotateCcw size={14} />}
                        {active ? "重新载入" : "恢复"}
                      </button>
                      <button type="button" disabled={Boolean(action)} onClick={() => onExport(session.id)} title="导出包含完整本机分析">
                        {actionMatches(action, session.id, "exporting")
                          ? <LoaderCircle className="spin" size={14} />
                          : <Download size={14} />}
                        导出
                      </button>
                      <button
                        type="button"
                        className="development-session-actions__delete"
                        disabled={Boolean(action)}
                        onClick={() => setDeleteId(session.id)}
                      >
                        <Trash2 size={14} />删除
                      </button>
                      {busy ? <span className="development-session-action-status" role="status">处理中</span> : null}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
