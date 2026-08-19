import {
  AlertTriangle,
  Archive,
  Database,
  Download,
  GitCompareArrows,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TraceArchiveClient,
  type ArchivedSessionDetail,
  type ArchivedTraceSession,
  type ArchiveStorageDescriptor,
} from "../../adapters/trace-archive";
import { ArchiveRunComparison } from "./ArchiveRunComparison";
import { ArchiveSessionDetail } from "./ArchiveSessionDetail";
import { ArchiveSessionList } from "./ArchiveSessionList";
import {
  archiveOwnerLabel,
  archiveStatusLabel,
  formatArchiveBytes,
  formatArchiveDate,
  formatMetric,
} from "./format";

type ConnectionState = "loading" | "ready" | "offline";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "无法连接本机 Trace 档案服务。";
}

export function TraceArchiveWorkspace() {
  const client = useMemo(() => new TraceArchiveClient(), []);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [connectionError, setConnectionError] = useState("");
  const [storage, setStorage] = useState<ArchiveStorageDescriptor | null>(null);
  const [sessions, setSessions] = useState<ArchivedTraceSession[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ArchivedSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const [mode, setMode] = useState<"session" | "compare">("session");
  const [action, setAction] = useState<"idle" | "exporting" | "deleting">("idle");
  const [actionError, setActionError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const loadFirstPage = useCallback(async () => {
    setConnection("loading");
    setConnectionError("");
    try {
      const result = await client.listSessions({ limit: 100, offset: 0 });
      setStorage(result.storage);
      setSessions(result.sessions);
      setTotal(result.pagination.total);
      setHasMore(result.pagination.hasMore);
      setSelectedId((current) =>
        result.sessions.some((session) => session.id === current)
          ? current
          : result.sessions[0]?.id ?? "");
      setConnection("ready");
      setDetailRevision((current) => current + 1);
    } catch (error: unknown) {
      setConnection("offline");
      setConnectionError(errorMessage(error));
    }
  }, [client]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    if (!selectedId || connection !== "ready") {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    setDeleteConfirm(false);
    setActionError("");
    void client.getSession(selectedId, controller.signal).then((result) => {
      if (active) setDetail(result);
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      setDetail(null);
      setDetailError(errorMessage(error));
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, connection, detailRevision, selectedId]);

  const selected = sessions.find((session) => session.id === selectedId);

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await client.listSessions({ limit: 100, offset: sessions.length });
      setStorage(result.storage);
      setSessions((current) => [
        ...current,
        ...result.sessions.filter((session) =>
          !current.some((candidate) => candidate.id === session.id)),
      ]);
      setTotal(result.pagination.total);
      setHasMore(result.pagination.hasMore);
    } catch (error: unknown) {
      setActionError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportSelected() {
    if (!selected || action !== "idle") return;
    setAction("exporting");
    setActionError("");
    try {
      const exported = await client.exportSession(selected.id);
      const blob = new Blob([JSON.stringify(exported, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selected.id}-full-trace.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: unknown) {
      setActionError(errorMessage(error));
    } finally {
      setAction("idle");
    }
  }

  async function deleteSelected() {
    if (!selected || selected.status === "open" || action !== "idle") return;
    setAction("deleting");
    setActionError("");
    try {
      await client.deleteSession(selected.id);
      setDeleteConfirm(false);
      setDetail(null);
      await loadFirstPage();
    } catch (error: unknown) {
      setActionError(errorMessage(error));
    } finally {
      setAction("idle");
    }
  }

  if (connection === "offline") {
    return (
      <section className="archive-workspace archive-workspace--offline">
        <div className="archive-offline-card">
          <AlertTriangle size={28} aria-hidden="true" />
          <small>LOCAL ARCHIVE OFFLINE</small>
          <h1>无法读取本机运行档案</h1>
          <p>{connectionError}</p>
          <button type="button" onClick={() => void loadFirstPage()}>
            <RefreshCw size={14} aria-hidden="true" />重新连接
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="archive-workspace">
      <header className="archive-toolbar">
        <div className="archive-toolbar__identity">
          <span><Database size={19} strokeWidth={1.8} aria-hidden="true" /></span>
          <div><small>LOCAL TRACE ARCHIVE</small><h1>Session 档案</h1></div>
        </div>
        {storage ? (
          <div className="archive-storage-metrics">
            <span><b>{formatMetric(storage.sessionCount)}</b><small>SESSIONS</small></span>
            <span><b>{formatArchiveBytes(storage.storedBytes)}</b><small>RAW / {formatArchiveBytes(storage.maxBytes)}</small></span>
            <span><b>{storage.retentionDays} 天</b><small>RETENTION</small></span>
          </div>
        ) : null}
        <div className="archive-storage-assurance">
          <ShieldCheck size={15} aria-hidden="true" />
          <span><strong>SQLite · WAL · 本机</strong><small>原文按需读取，不进入 Git 或日志</small></span>
        </div>
        <button
          type="button"
          className="archive-refresh"
          onClick={() => void loadFirstPage()}
          disabled={connection === "loading"}
          aria-label="刷新 Session 档案"
        >
          <RefreshCw className={connection === "loading" ? "archive-spin" : ""} size={15} aria-hidden="true" />
          刷新
        </button>
      </header>

      <div className="archive-layout">
        <ArchiveSessionList
          sessions={sessions}
          total={total}
          hasMore={hasMore}
          loadingMore={loadingMore}
          selectedId={selectedId}
          onSelect={(traceId) => {
            setSelectedId(traceId);
            setMode("session");
          }}
          onLoadMore={() => void loadMore()}
        />

        <main className="archive-main">
          <div className="archive-main-toolbar">
            <div className="archive-main-modes" role="group" aria-label="档案工作模式">
              <button
                type="button"
                className={mode === "session" ? "archive-main-mode--active" : ""}
                onClick={() => setMode("session")}
                aria-pressed={mode === "session"}
              >
                <Archive size={14} aria-hidden="true" />Session 详情
              </button>
              <button
                type="button"
                className={mode === "compare" ? "archive-main-mode--active" : ""}
                onClick={() => setMode("compare")}
                aria-pressed={mode === "compare"}
              >
                <GitCompareArrows size={14} aria-hidden="true" />运行对比
              </button>
            </div>

            {mode === "session" && selected ? (
              <div className="archive-session-actions">
                <span className={`archive-active-owner archive-active-owner--${selected.owner}`}>
                  {archiveOwnerLabel(selected.owner)}
                </span>
                <span className={`archive-status archive-status--${selected.status}`}>
                  {archiveStatusLabel(selected.status)}
                </span>
                <button
                  type="button"
                  onClick={() => void exportSelected()}
                  disabled={action !== "idle"}
                  title="用户显式导出；文件包含完整原文"
                >
                  {action === "exporting" ? <LoaderCircle className="archive-spin" size={14} /> : <Download size={14} />}
                  导出完整 JSON
                </button>
                <button
                  type="button"
                  className="archive-delete-button"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={selected.status === "open" || action !== "idle"}
                  title={selected.status === "open" ? "运行结束后才可删除" : "删除摘要、原文、Token 与全部事件"}
                >
                  <Trash2 size={14} />删除 Session
                </button>
              </div>
            ) : null}
          </div>

          {actionError ? (
            <div className="archive-inline-error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />{actionError}
            </div>
          ) : null}

          {deleteConfirm && selected ? (
            <div className="archive-delete-confirm" role="alertdialog" aria-label="确认删除 Session">
              <Trash2 size={16} aria-hidden="true" />
              <span>
                <strong>永久删除 {selected.label}？</strong>
                <small>原文、脱敏摘要、Token 指标与全部事件将从本机数据库一起删除。</small>
              </span>
              <button type="button" onClick={() => setDeleteConfirm(false)}>
                <X size={13} />取消
              </button>
              <button type="button" className="archive-delete-confirm__danger" onClick={() => void deleteSelected()}>
                {action === "deleting" ? <LoaderCircle className="archive-spin" size={13} /> : <Trash2 size={13} />}
                确认删除
              </button>
            </div>
          ) : null}

          {mode === "compare" ? (
            <ArchiveRunComparison
              sessions={sessions}
              client={client}
              preferredTraceId={selectedId}
            />
          ) : detailLoading ? (
            <div className="archive-loading-state archive-loading-state--page">
              <LoaderCircle className="archive-spin" size={22} aria-hidden="true" />
              正在读取脱敏事件索引…
            </div>
          ) : detailError ? (
            <div className="archive-offline-card archive-offline-card--inline">
              <AlertTriangle size={22} aria-hidden="true" />
              <strong>Session 详情读取失败</strong>
              <p>{detailError}</p>
              <button type="button" onClick={() => setDetailRevision((current) => current + 1)}>
                <RefreshCw size={13} />重试
              </button>
            </div>
          ) : detail ? (
            <ArchiveSessionDetail key={detail.session.id} detail={detail} client={client} />
          ) : (
            <div className="archive-empty-state">
              <HardDrive size={28} aria-hidden="true" />
              <strong>{connection === "loading" ? "正在读取本机数据库" : "还没有运行记录"}</strong>
              <p>{connection === "loading"
                ? "Session 索引加载完成后会显示在左侧。"
                : "从 Runtime 工作台完成一次 Core 或 Swarm 运行后，记录会增量写入此处。"}</p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
