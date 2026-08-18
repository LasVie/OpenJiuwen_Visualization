import {
  AlertTriangle,
  FileCode2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  SourceReaderClient,
  SourceReaderClientError,
  type SourceExcerptResult,
  type SourceReadReference,
} from "../../adapters/source-reader";
import "./styles.css";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: SourceExcerptResult };

function sourceErrorMessage(error: unknown) {
  if (error instanceof SourceReaderClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "源码证据读取失败。";
}

function sourceLabel(source: SourceReadReference) {
  return source.symbol || source.path.split("/").at(-1) || source.path;
}

export function SourceViewer({
  repositoryPath,
  source,
  buttonLabel = "查看源码",
}: {
  repositoryPath: string;
  source: SourceReadReference;
  buttonLabel?: string;
}) {
  const client = useMemo(() => new SourceReaderClient(), []);
  const [open, setOpen] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const canRead = Boolean(
    repositoryPath.trim() &&
    source.path.trim() &&
    !source.path.endsWith("/") &&
    source.startLine &&
    source.startLine > 0,
  );

  useEffect(() => {
    if (!open || !canRead) return;
    const controller = new AbortController();
    let active = true;
    setLoadState({ status: "loading" });
    void client.read(
      repositoryPath,
      source,
      { contextLines: 6, maxLines: 240, maxFileBytes: 2_000_000 },
      controller.signal,
    ).then((result) => {
      if (active) setLoadState({ status: "ready", result });
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) {
        setLoadState({ status: "error", message: sourceErrorMessage(error) });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [canRead, client, loadRevision, open, repositoryPath, source]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
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
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  if (!canRead) return null;

  const dialog = open ? (
    <div
      className="source-viewer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="source-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${sourceLabel(source)} 源码证据`}
      >
        <header className="source-viewer-header">
          <span className="source-viewer-header__icon"><FileCode2 size={19} /></span>
          <span className="source-viewer-header__identity">
            <small>READ-ONLY SOURCE EVIDENCE</small>
            <strong>{sourceLabel(source)}</strong>
            <code>{source.path}</code>
          </span>
          <span className="source-viewer-header__range">
            {source.startLine ? `L${source.startLine}${source.endLine ? `–${source.endLine}` : ""}` : "FILE"}
          </span>
          <button ref={closeRef} type="button" onClick={close} aria-label="关闭源码窗口">
            <X size={17} />
          </button>
        </header>

        <div className="source-viewer-body">
          {loadState.status === "loading" || loadState.status === "idle" ? (
            <div className="source-viewer-state" role="status">
              <LoaderCircle size={24} className="spin" />
              <strong>正在读取当前工作树</strong>
              <p>只读取所选源码文件的有界行范围。</p>
            </div>
          ) : loadState.status === "error" ? (
            <div className="source-viewer-state source-viewer-state--error" role="alert">
              <AlertTriangle size={24} />
              <strong>无法打开源码证据</strong>
              <p>{loadState.message}</p>
              <button type="button" onClick={() => setLoadRevision((value) => value + 1)}>
                <RefreshCw size={13} />重试
              </button>
            </div>
          ) : (
            <SourceExcerpt result={loadState.result} />
          )}
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="source-viewer-trigger"
        onClick={() => setOpen(true)}
        aria-label={`${buttonLabel}：${sourceLabel(source)}`}
      >
        <FileCode2 size={13} />{buttonLabel}
      </button>
      {dialog && typeof document !== "undefined"
        ? createPortal(dialog, document.body)
        : null}
    </>
  );
}

function SourceExcerpt({ result }: { result: SourceExcerptResult }) {
  const alignmentWarning = result.source.revisionMatches === false;
  const dirtyWarning = result.repository.dirty;
  return (
    <>
      <div className="source-viewer-meta">
        <span><LockKeyhole size={12} />当前工作树 · 只读</span>
        <span>{result.source.language.toUpperCase()} · {result.source.encoding}</span>
        <span>{result.range.startLine || 0}–{result.range.endLine || 0} / {result.range.totalLines} lines</span>
        {result.range.truncated ? <em>BOUNDED EXCERPT</em> : <em>FULL FILE</em>}
      </div>

      {alignmentWarning || dirtyWarning ? (
        <div className="source-viewer-warning">
          <AlertTriangle size={14} />
          <p>
            {alignmentWarning
              ? "源码引用 revision 与当前检出不一致；窗口展示的是当前工作树内容。"
              : "当前仓库含未提交修改；窗口展示的是工作树内容，不等同于纯 HEAD。"}
          </p>
        </div>
      ) : null}

      <div className="source-viewer-code" role="region" aria-label="源码行">
        {result.lines.length ? result.lines.map((line) => (
          <div
            className={line.focus ? "source-viewer-line source-viewer-line--focus" : "source-viewer-line"}
            key={line.number}
          >
            <span>{line.number}</span>
            <code>{line.text || " "}</code>
          </div>
        )) : (
          <p className="source-viewer-code__empty">文件为空。</p>
        )}
      </div>

      <footer className="source-viewer-footer">
        <span>SHA-256 <code>{result.source.contentSha256.slice(0, 16)}</code></span>
        <span>HEAD <code>{result.source.currentRevision.slice(0, 12)}</code></span>
        {result.range.focusTruncated ? <em>聚焦范围超过 240 行，已按上限截取</em> : null}
      </footer>
    </>
  );
}
