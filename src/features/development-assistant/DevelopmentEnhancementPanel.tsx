import {
  AlertTriangle,
  Check,
  Code2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  developmentEnhancementSourceChoices,
  MAX_DEVELOPMENT_ENHANCEMENT_SOURCES,
} from "./enhancement";
import type { DevelopmentAnalysisProjection } from "./model";
import type { DevelopmentEnhancementController } from "./use-development-enhancement";

interface DevelopmentEnhancementPanelProps {
  open: boolean;
  projection: DevelopmentAnalysisProjection;
  controller: DevelopmentEnhancementController;
  onClose: () => void;
}

function formatCharacters(value: number) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k chars` : `${value} chars`;
}

function providerMessage(controller: DevelopmentEnhancementController) {
  if (controller.providerLoading) return "正在读取本机 Provider 注册表";
  if (controller.providerError) return controller.providerError;
  if (!controller.provider) return "OpenRouter Provider 未连接";
  if (controller.provider.status === "unconfigured") {
    return "在本地服务设置 OPENJIUWEN_OPENROUTER_API_KEY 后重启服务。";
  }
  if (controller.provider.status === "blocked" || controller.provider.status === "disabled") {
    return controller.provider.host?.diagnostic.message ?? "OpenRouter 已被 Plugin Host 阻止。";
  }
  return "凭据仅由本地服务持有；浏览器不会读取 API key。";
}

export function DevelopmentEnhancementPanel({
  open,
  projection,
  controller,
  onClose,
}: DevelopmentEnhancementPanelProps) {
  const choices = useMemo(
    () => developmentEnhancementSourceChoices(projection),
    [projection],
  );
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [modelId, setModelId] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState(1_024);
  const [confirmed, setConfirmed] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const models = controller.provider?.models ?? [];
    if (!models.length) return;
    if (models.some((model) => model.id === modelId)) return;
    setModelId(controller.provider?.defaultModelId ?? models[0].id);
  }, [controller.provider, modelId]);

  useEffect(() => {
    setSelectedIds([]);
    setConfirmed(false);
    controller.invalidatePreview();
  }, [projection]);

  useEffect(() => {
    setConfirmed(false);
  }, [controller.preview?.payloadSha256]);

  useEffect(() => {
    if (controller.phase === "starting") setConfirmed(false);
  }, [controller.phase]);

  useEffect(() => {
    if (
      controller.result &&
      ["completed", "failed"].includes(controller.result.phase)
    ) setSelectedIds([]);
  }, [controller.result?.phase]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setConfirmed(false);
    closeRef.current?.focus();
    void controller.refreshProvider();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
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
  }, [controller.refreshProvider, open]);

  if (!open) return null;

  const providerReady = controller.provider?.status === "ready";
  const preparing = controller.phase === "preparing";
  const running = controller.active;
  const previewConsumed = Boolean(
    controller.preview &&
    controller.result?.payloadSha256 === controller.preview.payloadSha256,
  );

  function toggleSource(id: string) {
    if (running) return;
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_DEVELOPMENT_ENHANCEMENT_SOURCES) return current;
      return [...current, id];
    });
    controller.invalidatePreview();
  }

  return (
    <div
      className="development-enhancement-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="development-enhancement-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="development-enhancement-title"
      >
        <header className="development-enhancement-panel__header">
          <span className="development-enhancement-panel__icon"><Sparkles size={18} /></span>
          <span>
            <small>OPTIONAL · READ-ONLY · OPENROUTER</small>
            <strong id="development-enhancement-title">模型增强外发审查</strong>
          </span>
          <button
            type="button"
            onClick={() => void controller.refreshProvider()}
            aria-label="刷新 OpenRouter Provider"
          >
            <RefreshCw size={16} className={controller.providerLoading ? "spin" : ""} />
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭 OpenRouter 增强">
            <X size={17} />
          </button>
        </header>

        <div className="development-enhancement-panel__scroll">
          <section className={`development-enhancement-provider development-enhancement-provider--${controller.provider?.status ?? "offline"}`}>
            <span>{providerReady ? <Check size={15} /> : <AlertTriangle size={15} />}</span>
            <div>
              <strong>{controller.provider?.label ?? "OpenRouter"}</strong>
              <small>{providerMessage(controller)}</small>
            </div>
            <em>{controller.provider?.status ?? "offline"}</em>
          </section>

          <section className="development-enhancement-policy">
            <header><ShieldCheck size={14} /><strong>本次外发边界</strong></header>
            <div>
              <span>开发意图</span>
              <span>结构化 Runtime / Change 摘要</span>
              <span>仅显式选中的源码</span>
            </div>
            <p>不会带入完整 Context、Tool 参数/结果、Rail 输入/输出或既有模型原文；不会请求仓库写权限。</p>
          </section>

          <section className="development-enhancement-section">
            <header>
              <span><Code2 size={13} />选择源码片段</span>
              <em>{selectedIds.length} / {MAX_DEVELOPMENT_ENHANCEMENT_SOURCES}</em>
            </header>
            <p className="development-enhancement-section__hint">默认不选择。每次调用都要重新确认；单片段最多 64 行。</p>
            <div className="development-enhancement-sources">
              {choices.map((choice) => {
                const checked = selectedIds.includes(choice.id);
                const disabled = running || (!checked && selectedIds.length >= MAX_DEVELOPMENT_ENHANCEMENT_SOURCES);
                return (
                  <label key={choice.id} className={checked ? "development-enhancement-source development-enhancement-source--selected" : "development-enhancement-source"}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleSource(choice.id)}
                    />
                    <span className="development-enhancement-source__check">{checked ? <Check size={12} /> : null}</span>
                    <span>
                      <strong>{choice.label}</strong>
                      <code>{choice.source.path}{choice.source.symbol ? `:${choice.source.symbol}` : ""}</code>
                    </span>
                    <em>{choice.confidence}</em>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="development-enhancement-settings">
            <label>
              <span>MODEL</span>
              <select
                value={modelId}
                disabled={!providerReady || running}
                onChange={(event) => {
                  setModelId(event.target.value);
                  controller.invalidatePreview();
                }}
              >
                {(controller.provider?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>MAX OUTPUT</span>
              <select
                value={maxOutputTokens}
                disabled={!providerReady || running}
                onChange={(event) => {
                  setMaxOutputTokens(Number(event.target.value));
                  controller.invalidatePreview();
                }}
              >
                {[512, 1024, 2048, 4096].map((value) => <option key={value} value={value}>{value} tokens</option>)}
              </select>
            </label>
            <button
              type="button"
              disabled={!providerReady || !modelId || !selectedIds.length || running || preparing}
              onClick={() => void controller.prepare(selectedIds, modelId, maxOutputTokens)}
            >
              {preparing ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />}
              {preparing ? "正在读取所选源码" : "生成外发预览"}
            </button>
          </section>

          {controller.preview ? (
            <section className="development-enhancement-preview">
              <header>
                <span><ExternalLink size={13} />精确外发内容</span>
                <em>{formatCharacters(controller.preview.payloadCharacters)}</em>
              </header>
              <dl>
                <div><dt>DESTINATION</dt><dd>{controller.preview.destination}</dd></div>
                <div><dt>SHA-256</dt><dd>{controller.preview.payloadSha256}</dd></div>
                <div><dt>SOURCES</dt><dd>{controller.preview.sourceCount} selected</dd></div>
                <div><dt>WRITE</dt><dd>false</dd></div>
              </dl>
              <pre aria-label="OpenRouter 精确外发 JSON">{JSON.stringify(controller.preview.body, null, 2)}</pre>
              <label className="development-enhancement-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={running || previewConsumed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span className="development-enhancement-confirm__box">{confirmed ? <Check size={12} /> : null}</span>
                <span>{previewConsumed
                  ? "本次预览已经发送；如需再次调用，请重新生成并检查外发预览。"
                  : "我已检查上述完整 JSON，并确认仅将本次预览发送到 OpenRouter。"}</span>
              </label>
              <button
                type="button"
                className="development-enhancement-send"
                disabled={!confirmed || running || previewConsumed}
                onClick={() => void controller.invoke(controller.preview!.payloadSha256)}
              >
                {running ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                {running ? "OpenRouter 正在运行" : "确认并发送本次预览"}
              </button>
            </section>
          ) : null}

          {controller.error || controller.providerError ? (
            <section className="development-enhancement-error" role="alert">
              <AlertTriangle size={14} />
              <span>{controller.error ?? controller.providerError}</span>
              {controller.error ? <button type="button" onClick={controller.clearError}><X size={13} /></button> : null}
            </section>
          ) : null}

          {controller.result ? (
            <section className={`development-enhancement-result development-enhancement-result--${controller.result.phase}`}>
              <header>
                <span><Sparkles size={13} />OpenRouter 只读分支</span>
                <em>{controller.result.phase}</em>
              </header>
              <dl>
                <div><dt>MODEL</dt><dd>{controller.result.modelId}</dd></div>
                <div><dt>TRACE</dt><dd>{controller.result.traceId ?? "creating"}</dd></div>
                <div><dt>TOKENS</dt><dd>{controller.result.usage?.totalTokens ?? "—"}</dd></div>
              </dl>
              <pre aria-live="polite">{controller.result.output || "等待首个流式输出…"}</pre>
              {controller.result.structured ? (
                <div className="development-enhancement-structured">
                  <strong>结构化结果已验证</strong>
                  <p>{controller.result.structured.diagnosis}</p>
                  <span>{controller.result.structured.changeSuggestions.length} changes</span>
                  <span>{controller.result.structured.testSuggestions.length} tests</span>
                  <span>{controller.result.structured.caveats.length} caveats</span>
                </div>
              ) : null}
              <footer>
                {running ? (
                  <button type="button" onClick={() => void controller.cancel()}>
                    <Square size={12} />停止本次调用
                  </button>
                ) : (
                  <button type="button" onClick={controller.clearResult}>清除模型分支</button>
                )}
              </footer>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
