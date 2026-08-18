import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Rows3,
} from "lucide-react";
import { contextMessageText, displayTokens } from "../features/context-window";
import { materializeText, visibleContextMessages } from "../state/trace-utils";
import type { ContextRole, TraceScenario, TraceStep } from "../types/trace";

interface ContextPanelProps {
  scenario: TraceScenario;
  step: TraceStep;
  stepIndex: number;
  runInput: string;
  open: boolean;
  onToggle: () => void;
  scopeLabel?: string;
}

const roleLabels: Record<ContextRole, string> = {
  system: "SYSTEM",
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  summary: "SUMMARY",
};

const numberFormat = new Intl.NumberFormat("zh-CN");

type ContextView = "blocks" | "full";

export function ContextPanel({
  scenario,
  step,
  stepIndex,
  runInput,
  open,
  onToggle,
  scopeLabel,
}: ContextPanelProps) {
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    new Set(),
  );
  const [contextView, setContextView] = useState<ContextView>("blocks");
  const fullDocumentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpandedMessages(new Set());
    setContextView("blocks");
  }, [scenario.id]);

  const messages = useMemo(
    () => visibleContextMessages(scenario.messages, stepIndex),
    [scenario.messages, stepIndex],
  );
  const fullContextRevision = useMemo(
    () => `${messages.map((message) => message.id).join("|")}:${runInput}`,
    [messages, runInput],
  );

  useEffect(() => {
    if (!open || contextView !== "full") return;

    const animationFrame = window.requestAnimationFrame(() => {
      const documentElement = fullDocumentRef.current;
      if (!documentElement) return;
      documentElement.scrollTop = documentElement.scrollHeight;
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [contextView, fullContextRevision, open]);
  const usagePercent = Math.min(
    100,
    Math.max(0, (step.tokenUsed / scenario.maxTokens) * 100),
  );

  if (!open) {
    return (
      <aside className="context-panel context-panel--collapsed">
        <button
          type="button"
          className="icon-button context-panel__open"
          onClick={onToggle}
          aria-label="展开 Context Window"
          data-tooltip="展开 Context Window"
        >
          <PanelRightOpen size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <span className="context-panel__vertical-label">CONTEXT WINDOW</span>
        <span className="context-panel__collapsed-usage">
          {Math.round(usagePercent)}%
        </span>
      </aside>
    );
  }

  function toggleMessage(id: string) {
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="context-panel">
      <header className="context-panel__header">
        <div>
          <span className="section-kicker">LIVE SNAPSHOT</span>
          <h2>Context Window</h2>
          {scopeLabel ? (
            <span className="context-panel__scope">OWNER · {scopeLabel}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label="向右收起 Context Window"
          data-tooltip="向右收起"
        >
          <PanelRightClose size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <section className="context-budget" aria-label="Context token 使用量">
        <div className="context-budget__row">
          <span>Token budget</span>
          <strong>
            {numberFormat.format(step.tokenUsed)}
            <em>/ {numberFormat.format(scenario.maxTokens)}</em>
          </strong>
        </div>
        <div
          className="context-budget__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={scenario.maxTokens}
          aria-valuenow={step.tokenUsed}
        >
          <span style={{ width: usagePercent + "%" }} />
        </div>
        <div className="context-budget__meta">
          <span>{messages.length} messages</span>
          <span className={step.tokenDelta < 0 ? "token-delta--saved" : ""}>
            {step.tokenDelta > 0 ? "+" : ""}
            {numberFormat.format(step.tokenDelta)} this step
          </span>
        </div>
      </section>

      {step.compression ? (
        <section
          className={
            "compression-card compression-card--" + step.compression.state
          }
          aria-label="Context 压缩事件"
        >
          <div className="compression-card__heading">
            <Braces size={16} strokeWidth={1.8} aria-hidden="true" />
            <strong>compression_state · {step.compression.state}</strong>
          </div>
          <p>
            {numberFormat.format(step.compression.beforeTokens)} →{" "}
            {numberFormat.format(step.compression.afterTokens)} tokens
          </p>
          <span>
            {step.compression.processor} · saved{" "}
            {numberFormat.format(step.compression.savedTokens)} ·{" "}
            {step.compression.durationMs}ms
          </span>
        </section>
      ) : null}

      <div className="context-panel__privacy">
        <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
        消息分段默认脱敏 · 可逐条展开原文
      </div>

      <div className="context-view-switch" role="tablist" aria-label="Context 展示方式">
        <button
          type="button"
          role="tab"
          className={
            contextView === "blocks"
              ? "context-view-button context-view-button--active"
              : "context-view-button"
          }
          aria-selected={contextView === "blocks"}
          onClick={() => setContextView("blocks")}
        >
          <Rows3 size={14} strokeWidth={1.8} aria-hidden="true" />
          消息分段
        </button>
        <button
          type="button"
          role="tab"
          className={
            contextView === "full"
              ? "context-view-button context-view-button--active"
              : "context-view-button"
          }
          aria-selected={contextView === "full"}
          onClick={() => setContextView("full")}
        >
          <FileText size={14} strokeWidth={1.8} aria-hidden="true" />
          连续原文
        </button>
      </div>

      {contextView === "full" ? (
        <div className="full-context" role="tabpanel" aria-label="连续 Context 原文">
          <header className="full-context__header">
            <span>
              <FileText size={15} strokeWidth={1.8} aria-hidden="true" />
              FULL CONTEXT · UNTRUNCATED
            </span>
            <strong>{numberFormat.format(step.tokenUsed)} trace tokens</strong>
          </header>
          <p className="full-context__note">
            按实际消息顺序连续展示；每次追加之间保留一个空行。Token 边界采用演示切分。
          </p>
          <div
            ref={fullDocumentRef}
            className="full-context__document"
            data-auto-follow="new-messages"
          >
            {messages.map((message) => {
              const raw = materializeText(message.raw, runInput);
              return (
                <section className="full-context__entry" key={message.id}>
                  <div className="full-context__meta">
                    <span>{roleLabels[message.role]}</span>
                    <span>{message.label}</span>
                    <span>{numberFormat.format(message.tokens)} tok</span>
                    <span>{message.source}</span>
                  </div>
                  <div className="full-context__text">
                    {displayTokens(raw).map((token, fragmentIndex) =>
                      token.index === null ? (
                        <span key={message.id + "-space-" + fragmentIndex}>
                          {token.text}
                        </span>
                      ) : (
                        <span
                          className="full-context__token"
                          data-token-index={token.index}
                          title={
                            message.label +
                            " · display token " +
                            token.index
                          }
                          key={message.id + "-token-" + fragmentIndex}
                        >
                          {token.text}
                        </span>
                      ),
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="context-messages" role="tabpanel" aria-label="分段 Context">
          {messages.map((message) => {
            const expanded = expandedMessages.has(message.id);
            const visibleText = contextMessageText(
              message,
              runInput,
              expanded,
            );

            return (
              <article
                className={[
                  "context-message",
                  "context-message--" + message.role,
                  message.addedAt === stepIndex
                    ? "context-message--new"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={message.id}
              >
                <header>
                  <span className="context-message__role">
                    {roleLabels[message.role]}
                  </span>
                  <span className="context-message__tokens">
                    {numberFormat.format(message.tokens)} tok
                  </span>
                </header>
                <strong>{message.label}</strong>
                <p className={expanded ? "context-message__raw" : ""}>
                  {visibleText}
                </p>
                <footer>
                  <span>
                    {message.source} · {expanded ? "完整原文" : "脱敏摘要"}
                  </span>
                  <button
                    type="button"
                    className="text-button context-message__reveal"
                    onClick={() => toggleMessage(message.id)}
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />
                    ) : (
                      <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    {expanded ? "收起原文" : "展开原文"}
                    {expanded ? (
                      <ChevronDown
                        size={13}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        size={13}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}
