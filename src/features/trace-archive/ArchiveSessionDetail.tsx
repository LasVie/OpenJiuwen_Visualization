import {
  AlertTriangle,
  Eye,
  EyeOff,
  FileText,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  TraceArchiveClient,
  type ArchivedEventPreview,
  type ArchivedRawEvent,
  type ArchivedSessionDetail,
  type RawContextResponse,
} from "../../adapters/trace-archive";
import { formatArchiveDate } from "./format";

interface ArchiveSessionDetailProps {
  detail: ArchivedSessionDetail;
  client: TraceArchiveClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function eventContextPreviews(event: ArchivedEventPreview) {
  if (!isRecord(event.context) || !Array.isArray(event.context.messages)) return [];
  return event.context.messages.flatMap((message) =>
    isRecord(message) && typeof message.preview === "string"
      ? [{
          id: typeof message.id === "string" ? message.id : message.preview,
          role: typeof message.role === "string" ? message.role : "message",
          preview: message.preview,
          tokens: typeof message.tokens === "number" ? message.tokens : 0,
        }]
      : []);
}

function eventEvidence(event: ArchivedEventPreview) {
  const evidence: Array<{ label: string; value: string }> = [];
  if (isRecord(event.subject)) {
    const value = [event.subject.kind, event.subject.label ?? event.subject.id]
      .filter((item) => typeof item === "string").join(" · ");
    if (value) evidence.push({ label: "SUBJECT", value });
  }
  if (isRecord(event.definition)) {
    const value = [event.definition.path, event.definition.symbol]
      .filter((item) => typeof item === "string").join(" · ");
    if (value) evidence.push({ label: "SOURCE", value });
  }
  if (isRecord(event.hook)) {
    const value = [event.hook.rail, event.hook.callback]
      .filter((item) => typeof item === "string").join(" · ");
    if (value) evidence.push({ label: "RAIL", value });
  }
  if (isRecord(event.model)) {
    const value = [event.model.providerId, event.model.modelId]
      .filter((item) => typeof item === "string").join(" · ");
    if (value) evidence.push({ label: "MODEL", value });
  }
  if (isRecord(event.environment)) {
    const fingerprint = typeof event.environment.fingerprint === "string"
      ? event.environment.fingerprint.slice(0, 12)
      : null;
    const value = [
      event.environment.id,
      fingerprint,
      typeof event.environment.pythonVersion === "string"
        ? `Python ${event.environment.pythonVersion}`
        : null,
    ].filter((item) => typeof item === "string").join(" · ");
    if (value) evidence.push({ label: "ENV", value });
  }
  if (isRecord(event.payload) && Array.isArray(event.payload.keys)) {
    evidence.push({ label: "PAYLOAD", value: event.payload.keys.join(", ") });
  }
  return evidence;
}

function rawErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "本机原文读取失败。";
}

export function ArchiveSessionDetail({ detail, client }: ArchiveSessionDetailProps) {
  const [view, setView] = useState<"segments" | "continuous">("segments");
  const [rawEvents, setRawEvents] = useState<Record<number, ArchivedRawEvent>>({});
  const [rawLoading, setRawLoading] = useState<number | null>(null);
  const [rawError, setRawError] = useState("");
  const [context, setContext] = useState<RawContextResponse | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const continuousEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setView("segments");
    setRawEvents({});
    setRawLoading(null);
    setRawError("");
    setContext(null);
    setContextLoading(false);
  }, [detail.session.id]);

  const contextEntries = useMemo(() => context?.frames.flatMap((frame) =>
    frame.messages.map((message) => ({ frame, message }))) ?? [], [context]);

  useEffect(() => {
    if (view !== "continuous" || !contextEntries.length) return;
    continuousEnd.current?.scrollIntoView({ block: "end" });
  }, [contextEntries.length, view]);

  async function toggleRaw(event: ArchivedEventPreview) {
    if (rawEvents[event.sequence]) {
      setRawEvents((current) => {
        const next = { ...current };
        delete next[event.sequence];
        return next;
      });
      return;
    }
    setRawLoading(event.sequence);
    setRawError("");
    try {
      const response = await client.revealEvents(detail.session.id, [event.sequence]);
      const raw = response.events.find((candidate) => candidate.sequence === event.sequence);
      if (!raw) throw new Error("本机数据库没有返回所选事件原文。");
      setRawEvents((current) => ({ ...current, [event.sequence]: raw }));
    } catch (error: unknown) {
      setRawError(rawErrorMessage(error));
    } finally {
      setRawLoading(null);
    }
  }

  async function showContinuous() {
    setView("continuous");
    if (context || contextLoading) return;
    setContextLoading(true);
    setRawError("");
    try {
      setContext(await client.revealContext(detail.session.id));
    } catch (error: unknown) {
      setRawError(rawErrorMessage(error));
    } finally {
      setContextLoading(false);
    }
  }

  return (
    <section className="archive-detail">
      <header className="archive-detail__header">
        <div>
          <small>TRACE CONTENT</small>
          <h2>{detail.session.label}</h2>
          <code>{detail.session.id}</code>
        </div>
        <div className="archive-detail-view" role="group" aria-label="Context 原文显示模式">
          <button
            type="button"
            className={view === "segments" ? "archive-detail-view--active" : ""}
            onClick={() => setView("segments")}
            aria-pressed={view === "segments"}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            消息分段
          </button>
          <button
            type="button"
            className={view === "continuous" ? "archive-detail-view--active" : ""}
            onClick={() => void showContinuous()}
            aria-pressed={view === "continuous"}
          >
            <FileText size={14} aria-hidden="true" />
            连续原文
          </button>
        </div>
      </header>

      {rawError ? (
        <div className="archive-inline-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {rawError}
        </div>
      ) : null}

      {view === "segments" ? (
        <div className="archive-event-list">
          <div className="archive-privacy-note">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>
              <strong>当前仅呈现脱敏摘要</strong>
              <small>每个“展开原文”动作只读取该事件；收起后从页面状态移除。</small>
            </span>
          </div>
          {detail.events.map((event) => {
            const raw = rawEvents[event.sequence];
            const previews = eventContextPreviews(event);
            const evidence = eventEvidence(event);
            return (
              <article className="archive-event-card" key={event.eventId}>
                <header>
                  <span className="archive-event-sequence">{String(event.sequence).padStart(3, "0")}</span>
                  <span>
                    <strong>{event.title ?? event.kind}</strong>
                    <small>{event.kind} · {event.phase}</small>
                  </span>
                  <time dateTime={event.receivedAt}>{formatArchiveDate(event.receivedAt)}</time>
                </header>
                <p>{event.summary ?? "结构化事件已归档；完整内容仅在本机按需读取。"}</p>
                {previews.length ? (
                  <div className="archive-context-previews">
                    {previews.map((message) => (
                      <span key={message.id}>
                        <b>{message.role}</b>
                        <em>{message.preview}</em>
                        <small>{message.tokens} tokens</small>
                      </span>
                    ))}
                  </div>
                ) : null}
                {evidence.length ? (
                  <dl className="archive-event-evidence">
                    {evidence.map((item) => (
                      <div key={`${item.label}-${item.value}`}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <footer>
                  <button
                    type="button"
                    className={raw ? "archive-raw-toggle archive-raw-toggle--open" : "archive-raw-toggle"}
                    onClick={() => void toggleRaw(event)}
                    disabled={rawLoading === event.sequence}
                  >
                    {rawLoading === event.sequence ? (
                      <LoaderCircle className="archive-spin" size={14} aria-hidden="true" />
                    ) : raw ? (
                      <EyeOff size={14} aria-hidden="true" />
                    ) : (
                      <Eye size={14} aria-hidden="true" />
                    )}
                    {raw ? "收起原文" : "展开原文"}
                  </button>
                  <span>RAW · LOCAL DATABASE ONLY</span>
                </footer>
                {raw ? (
                  <pre className="archive-event-raw">{JSON.stringify(raw, null, 2)}</pre>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="archive-continuous-context">
          <div className="archive-privacy-note archive-privacy-note--raw">
            <Eye size={15} aria-hidden="true" />
            <span>
              <strong>连续原文已从本机数据库读取</strong>
              <small>按事件顺序展示每个被处理的 Context 消息，消息之间保留清晰分隔。</small>
            </span>
          </div>
          {contextLoading ? (
            <div className="archive-loading-state">
              <LoaderCircle className="archive-spin" size={20} aria-hidden="true" />
              正在读取本机 Context 原文…
            </div>
          ) : contextEntries.length ? contextEntries.map(({ frame, message }, index) => (
            <article className="archive-context-entry" key={`${frame.sequence}-${message.id}-${index}`}>
              <header>
                <span>{message.role}</span>
                <strong>{message.label}</strong>
                <em>#{frame.sequence} · {frame.operation}</em>
              </header>
              <pre>{message.raw}</pre>
              <footer>{message.tokens} tokens · {message.source}{frame.ownerId ? ` · ${frame.ownerId}` : ""}</footer>
            </article>
          )) : (
            <div className="archive-loading-state">该 Session 没有 Context 原文帧。</div>
          )}
          <div ref={continuousEnd} />
        </div>
      )}
    </section>
  );
}
