import {
  AlertTriangle,
  GitCompareArrows,
  LoaderCircle,
  Waypoints,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  TraceArchiveClient,
  type ArchivedTraceSession,
} from "../../adapters/trace-archive";
import { compareArchivedRuns, type RunComparison } from "./model";
import {
  archiveOwnerLabel,
  formatArchiveBytes,
  formatMetric,
  formatMetricDelta,
} from "./format";

interface ArchiveRunComparisonProps {
  sessions: readonly ArchivedTraceSession[];
  client: TraceArchiveClient;
  preferredTraceId: string;
}

const statusLabel = {
  added: "新增",
  removed: "移除",
  changed: "变化",
  unchanged: "一致",
} as const;

export function ArchiveRunComparison({
  sessions,
  client,
  preferredTraceId,
}: ArchiveRunComparisonProps) {
  const [leftId, setLeftId] = useState(preferredTraceId || sessions[0]?.id || "");
  const [rightId, setRightId] = useState(
    sessions.find((session) => session.id !== preferredTraceId)?.id ?? "",
  );
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<RunComparison | null>(null);

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    setLeftId((current) => ids.has(current)
      ? current
      : ids.has(preferredTraceId) ? preferredTraceId : sessions[0]?.id ?? "");
    setRightId((current) => ids.has(current)
      ? current
      : sessions.find((session) => session.id !== preferredTraceId)?.id ?? "");
  }, [preferredTraceId, sessions]);

  const selectableRight = useMemo(
    () => sessions.filter((session) => session.id !== leftId),
    [leftId, sessions],
  );

  useEffect(() => {
    if (rightId !== leftId) return;
    setRightId(selectableRight[0]?.id ?? "");
  }, [leftId, rightId, selectableRight]);

  async function runComparison() {
    if (!leftId || !rightId || leftId === rightId) return;
    setStatus("loading");
    setError("");
    try {
      const [left, right] = await Promise.all([
        client.getSession(leftId),
        client.getSession(rightId),
      ]);
      setComparison(compareArchivedRuns(left, right));
      setStatus("ready");
    } catch (caught: unknown) {
      setComparison(null);
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "运行对比失败。");
    }
  }

  const metrics = comparison ? [
    ["EVENTS", comparison.metrics.events, (value: number) => formatMetric(value)],
    ["TOTAL TOKENS", comparison.metrics.totalTokens, (value: number) => formatMetric(value)],
    ["INPUT", comparison.metrics.inputTokens, (value: number) => formatMetric(value)],
    ["OUTPUT", comparison.metrics.outputTokens, (value: number) => formatMetric(value)],
    ["CONTEXT", comparison.metrics.contextMessages, (value: number) => formatMetric(value)],
    ["COST µUSD", comparison.metrics.costMicros, (value: number) => formatMetric(value)],
    ["RAW SIZE", comparison.metrics.storedRawBytes, formatArchiveBytes],
  ] as const : [];

  return (
    <section className="archive-comparison">
      <header className="archive-comparison__header">
        <span><GitCompareArrows size={18} aria-hidden="true" /></span>
        <div>
          <small>RUN COMPARISON</small>
          <h2>双运行结构对比</h2>
          <p>仅使用脱敏事件与源码身份，不读取任何 Context 或模型原文。</p>
        </div>
      </header>

      <div className="archive-compare-picker">
        <label>
          <span>BASELINE · A</span>
          <select value={leftId} onChange={(event) => setLeftId(event.target.value)}>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {archiveOwnerLabel(session.owner)} · {session.label}
              </option>
            ))}
          </select>
        </label>
        <GitCompareArrows size={19} aria-hidden="true" />
        <label>
          <span>CANDIDATE · B</span>
          <select value={rightId} onChange={(event) => setRightId(event.target.value)}>
            {selectableRight.map((session) => (
              <option key={session.id} value={session.id}>
                {archiveOwnerLabel(session.owner)} · {session.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void runComparison()}
          disabled={!leftId || !rightId || leftId === rightId || status === "loading"}
        >
          {status === "loading" ? (
            <LoaderCircle className="archive-spin" size={15} aria-hidden="true" />
          ) : (
            <Waypoints size={15} aria-hidden="true" />
          )}
          开始对比
        </button>
      </div>

      {sessions.length < 2 ? (
        <div className="archive-comparison-empty">
          <GitCompareArrows size={24} aria-hidden="true" />
          <strong>至少需要两个 Session</strong>
          <p>完成另一条 Core 或 Swarm 运行后刷新档案，即可比较结构与指标。</p>
        </div>
      ) : status === "error" ? (
        <div className="archive-inline-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </div>
      ) : comparison ? (
        <div className="archive-comparison-result">
          <div className="archive-compare-metrics">
            {metrics.map(([label, value, formatter]) => (
              <article key={label}>
                <small>{label}</small>
                <span><b>{formatter(value.left)}</b><i>→</i><b>{formatter(value.right)}</b></span>
                <em className={value.delta > 0 ? "archive-delta--up" : value.delta < 0 ? "archive-delta--down" : ""}>
                  {label === "RAW SIZE" ? `${value.delta > 0 ? "+" : ""}${formatArchiveBytes(value.delta)}` : formatMetricDelta(value.delta)}
                </em>
              </article>
            ))}
          </div>

          <div className="archive-compare-summary">
            {(Object.keys(statusLabel) as Array<keyof typeof statusLabel>).map((key) => (
              <span className={`archive-compare-status archive-compare-status--${key}`} key={key}>
                <b>{comparison.summary[key]}</b>{statusLabel[key]}
              </span>
            ))}
            <small>源码身份优先 · Runtime kind / subject 回退</small>
          </div>

          <div className="archive-compare-table" role="table" aria-label="运行结构差异">
            <div className="archive-compare-table__head" role="row">
              <span>节点 / 事件身份</span><span>A</span><span>B</span><span>结果</span>
            </div>
            {comparison.rows.map((row) => (
              <div className={`archive-compare-row archive-compare-row--${row.status}`} role="row" key={row.identity}>
                <span>
                  <strong>{row.label}</strong>
                  <code>{row.kind}{row.sourceBacked ? " · SOURCE" : " · RUNTIME"}</code>
                </span>
                <span>{row.left ? `${row.left.count} · ${row.left.lastPhase}` : "—"}</span>
                <span>{row.right ? `${row.right.count} · ${row.right.lastPhase}` : "—"}</span>
                <em>{statusLabel[row.status]}</em>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="archive-comparison-empty">
          <Waypoints size={24} aria-hidden="true" />
          <strong>选择两次运行开始对比</strong>
          <p>对比事件数量、Token、成本、原文占用与源码/运行身份变化。</p>
        </div>
      )}
    </section>
  );
}
