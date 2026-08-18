import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Cpu,
  Eye,
  EyeOff,
  ReceiptText,
} from "lucide-react";
import { maskSensitiveText } from "../../state/trace-utils";
import type {
  ModelInvocationStatus,
  ModelRuntimeProjection,
} from "./model";

interface ModelRuntimePanelProps {
  projection: ModelRuntimeProjection;
}

const numberFormat = new Intl.NumberFormat("zh-CN");

const statusLabel: Record<ModelInvocationStatus, string> = {
  pending: "等待",
  streaming: "流式输出",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

function compact(value: string, limit = 260) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized;
}

function formatCost(micros: number, currency?: string) {
  return `${currency ?? "USD"} ${(micros / 1_000_000).toFixed(6)}`;
}

export function ModelRuntimePanel({ projection }: ModelRuntimePanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rawOutputOpen, setRawOutputOpen] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setSelectedId(projection.activeInvocationId);
  }, [projection.activeInvocationId]);

  const selected = useMemo(
    () => projection.invocations.find((item) => item.id === selectedId)
      ?? projection.invocations.at(-1),
    [projection.invocations, selectedId],
  );

  useEffect(() => {
    setRawOutputOpen(false);
  }, [selected?.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!outputRef.current) return;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected?.output, rawOutputOpen]);

  if (!selected) return null;

  const tokenUsed = selected.usage?.totalTokens ?? 0;
  const tokenBudget = selected.budget?.maxTotalTokens;
  const tokenPercent = tokenBudget
    ? Math.min(100, (tokenUsed / tokenBudget) * 100)
    : 0;
  const costUsed = selected.usage?.costMicros;
  const costBudget = selected.budget?.maxCostMicros;
  const costPercent = costUsed !== undefined && costBudget
    ? Math.min(100, (costUsed / costBudget) * 100)
    : 0;
  const maskedOutput = compact(maskSensitiveText(selected.output));
  const visibleOutput = rawOutputOpen
    ? selected.output
    : maskedOutput || "等待 Provider 输出…";

  return (
    <section
      className={`model-runtime model-runtime--${selected.status} ${
        detailsOpen ? "model-runtime--open" : ""
      }`}
      aria-label="Model Provider 运行详情"
    >
      <header className="model-runtime__header">
        <div className="model-runtime__title">
          <Cpu size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>
            <small>MODEL PROVIDER · {selected.source === "recording" ? "REPLAY" : "LIVE"}</small>
            <strong>{selected.providerId} / {selected.modelId}</strong>
          </span>
        </div>
        <span className={`model-runtime__status model-runtime__status--${selected.status}`}>
          {selected.status === "cancelled"
            ? <CircleStop size={12} aria-hidden="true" />
            : <Activity size={12} aria-hidden="true" />}
          {statusLabel[selected.status]}
        </span>
        {projection.invocations.length > 1 ? (
          <div className="model-runtime__invocations" role="tablist" aria-label="模型调用">
            {projection.invocations.map((invocation, index) => (
              <button
                key={invocation.id}
                type="button"
                role="tab"
                aria-selected={invocation.id === selected.id}
                className={invocation.id === selected.id ? "model-runtime__tab--active" : ""}
                onClick={() => setSelectedId(invocation.id)}
              >
                Call {index + 1}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="model-runtime__toggle"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          {detailsOpen ? "收起" : "详情"}
        </button>
      </header>

      <div className="model-runtime__summary">
        <div className="model-runtime__output">
          <span>OUTPUT</span>
          <pre ref={outputRef} data-auto-follow="model-stream">{visibleOutput}</pre>
          <button
            type="button"
            onClick={() => setRawOutputOpen((open) => !open)}
            aria-expanded={rawOutputOpen}
            disabled={!selected.output}
          >
            {rawOutputOpen ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
            {rawOutputOpen ? "脱敏预览" : "完整输出"}
          </button>
        </div>

        <div className="model-runtime__meter">
          <div><span>TOKENS</span><strong>{numberFormat.format(tokenUsed)}{tokenBudget ? ` / ${numberFormat.format(tokenBudget)}` : ""}</strong></div>
          {tokenBudget ? (
            <div className="model-runtime__track" role="progressbar" aria-label="模型 Token 预算" aria-valuemin={0} aria-valuemax={tokenBudget} aria-valuenow={tokenUsed}>
              <span style={{ width: `${tokenPercent}%` }} />
            </div>
          ) : null}
          <small>
            {selected.usage
              ? `${numberFormat.format(selected.usage.inputTokens)} in · ${numberFormat.format(selected.usage.outputTokens)} out`
              : "等待 usage"}
          </small>
        </div>

        <div className="model-runtime__meter">
          <div><span>COST</span><strong>{costUsed === undefined ? "—" : formatCost(costUsed, selected.usage?.currency)}</strong></div>
          {costUsed !== undefined && costBudget ? (
            <div className="model-runtime__track model-runtime__track--cost" role="progressbar" aria-label="模型费用预算" aria-valuemin={0} aria-valuemax={costBudget} aria-valuenow={costUsed}>
              <span style={{ width: `${costPercent}%` }} />
            </div>
          ) : null}
          <small>{costBudget ? `budget ${formatCost(costBudget, selected.budget?.currency)}` : "未声明费用预算"}</small>
        </div>
      </div>

      {detailsOpen ? (
        <div className="model-runtime__details">
          <dl>
            <div><dt>invocation</dt><dd>{selected.id}</dd></div>
            <div><dt>span</dt><dd>{selected.spanId}</dd></div>
            <div><dt>subject</dt><dd>{selected.subject ? `${selected.subject.kind}:${selected.subject.label}` : "agent-core"}</dd></div>
            <div><dt>duration</dt><dd>{numberFormat.format(selected.durationMs)} ms</dd></div>
            <div><dt>finish</dt><dd>{selected.cancelReason ?? selected.finishReason ?? "—"}</dd></div>
            <div><dt>recording</dt><dd>{selected.recordingId ?? "live"}</dd></div>
          </dl>
          <div className="model-runtime__frames" aria-label="模型事件帧">
            <span><ReceiptText size={12} aria-hidden="true" />事件帧</span>
            <div>
              {selected.frames.map((frame) => (
                <span className={`model-runtime__frame model-runtime__frame--${frame.kind.replace(".", "-")}`} key={frame.eventId} title={`${frame.kind} · ${frame.phase}`}>
                  <em>{frame.sequence}</em>{frame.title}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
