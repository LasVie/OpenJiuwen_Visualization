import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ArchivedTraceOwner,
  ArchivedTraceSession,
} from "../../adapters/trace-archive";
import {
  archiveOwnerLabel,
  archiveStatusLabel,
  formatArchiveBytes,
  formatArchiveDate,
} from "./format";

interface ArchiveSessionListProps {
  sessions: readonly ArchivedTraceSession[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  selectedId: string;
  onSelect: (traceId: string) => void;
  onLoadMore: () => void;
}

type OwnerFilter = "all" | ArchivedTraceOwner;

export function ArchiveSessionList({
  sessions,
  total,
  hasMore,
  loadingMore,
  selectedId,
  onSelect,
  onLoadMore,
}: ArchiveSessionListProps) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<OwnerFilter>("all");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sessions.filter((session) =>
      (owner === "all" || session.owner === owner) &&
      (!needle || `${session.label} ${session.id}`.toLocaleLowerCase().includes(needle)));
  }, [owner, query, sessions]);

  return (
    <aside className="archive-session-sidebar">
      <header className="archive-session-sidebar__header">
        <div>
          <small>SESSION MANAGER</small>
          <strong>本机运行记录</strong>
        </div>
        <em>{sessions.length}/{total}</em>
      </header>

      <div className="archive-session-filters">
        <label>
          <Search size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">搜索 Session</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 Trace ID"
          />
        </label>
        <div role="group" aria-label="按运行来源筛选">
          {([
            ["all", "全部"],
            ["agent-core", "Core"],
            ["jiuwenswarm", "Swarm"],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={owner === value ? "archive-filter--active" : ""}
              onClick={() => setOwner(value)}
              aria-pressed={owner === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="archive-session-list">
        {filtered.length ? filtered.map((session) => (
          <button
            type="button"
            key={session.id}
            className={[
              "archive-session-card",
              `archive-session-card--${session.owner}`,
              selectedId === session.id ? "archive-session-card--selected" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => onSelect(session.id)}
            aria-pressed={selectedId === session.id}
          >
            <span className="archive-session-card__topline">
              <b>{archiveOwnerLabel(session.owner)}</b>
              <em className={`archive-status archive-status--${session.status}`}>
                {archiveStatusLabel(session.status)}
              </em>
              <time dateTime={session.updatedAt}>{formatArchiveDate(session.updatedAt)}</time>
            </span>
            <strong>{session.label}</strong>
            <code>{session.id}</code>
            <span className="archive-session-card__metrics">
              <span>{session.eventCount} events</span>
              <span>{session.totalTokens} tokens</span>
              <span>{formatArchiveBytes(session.storedRawBytes)}</span>
            </span>
          </button>
        )) : (
          <div className="archive-session-empty">
            <strong>没有匹配的 Session</strong>
            <p>调整来源筛选或搜索关键词。</p>
          </div>
        )}
        {hasMore ? (
          <button
            type="button"
            className="archive-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "正在载入…" : `加载更早的 Session（剩余 ${total - sessions.length}）`}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
