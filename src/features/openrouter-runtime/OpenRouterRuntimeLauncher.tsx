import {
  Activity,
  CircleStop,
  KeyRound,
  Network,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  OpenRouterRuntimeController,
  OpenRouterRuntimePhase,
} from "./use-openrouter-runtime";

interface OpenRouterRuntimeLauncherProps {
  controller: OpenRouterRuntimeController;
}

const phaseLabel: Record<OpenRouterRuntimePhase, string> = {
  idle: "待运行",
  starting: "启动中",
  running: "流式运行",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
};

export function OpenRouterRuntimeLauncher({
  controller,
}: OpenRouterRuntimeLauncherProps) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState(512);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const provider = controller.provider;
    if (!provider) return;
    if (!provider.models.some((model) => model.id === modelId)) {
      setModelId(provider.defaultModelId);
    }
    setMaxOutputTokens((current) =>
      Math.min(provider.limits.maxOutputTokens, Math.max(
        provider.limits.minOutputTokens,
        current || provider.limits.defaultOutputTokens,
      )));
  }, [controller.provider, modelId]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => promptRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.trim() || !modelId) return;
    await controller.start({
      modelId,
      input,
      ...(systemPrompt.trim() ? { systemPrompt } : {}),
      maxOutputTokens,
    });
  }

  const providerReady = Boolean(controller.provider?.configured);
  const hostStatus = controller.provider?.host?.status;
  const triggerStatus = controller.active
    ? phaseLabel[controller.phase]
    : controller.providerLoading
      ? "检查中"
      : controller.providerError
        ? "服务不可达"
        : hostStatus === "disabled"
          ? "Host 已关闭"
          : hostStatus === "blocked"
            ? "授权阻塞"
            : providerReady
          ? "已就绪"
          : "待配置";

  return (
    <>
      <button
        type="button"
        className={`openrouter-launcher__trigger ${controller.active ? "openrouter-launcher__trigger--active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={`OpenRouter · ${triggerStatus}`}
      >
        <Network size={14} strokeWidth={2} aria-hidden="true" />
        OpenRouter
        <span aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="openrouter-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <section
            className="openrouter-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="openrouter-dialog-title"
          >
            <header className="openrouter-dialog__header">
              <div>
                <span className="openrouter-dialog__mark" aria-hidden="true">
                  <Network size={19} strokeWidth={2} />
                </span>
                <span>
                  <small>LIVE MODEL PROVIDER · LOCAL ADAPTER</small>
                  <h2 id="openrouter-dialog-title">OpenRouter 调用</h2>
                </span>
              </div>
              <span className={`openrouter-dialog__phase openrouter-dialog__phase--${controller.phase}`}>
                {controller.active ? <Activity size={13} strokeWidth={2} aria-hidden="true" /> : <Server size={13} strokeWidth={2} aria-hidden="true" />}
                {phaseLabel[controller.phase]}
              </span>
              <button
                type="button"
                className="openrouter-dialog__close"
                onClick={() => setOpen(false)}
                aria-label="关闭 OpenRouter 调用面板"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            {controller.providerLoading ? (
              <div className="openrouter-dialog__state" role="status">
                <Activity size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>正在读取本地 Provider 注册表</strong><p>浏览器不会读取 OpenRouter API key。</p></div>
              </div>
            ) : controller.providerError ? (
              <div className="openrouter-dialog__state openrouter-dialog__state--error" role="alert">
                <Server size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>本地服务不可达</strong><p>{controller.providerError}</p></div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重试
                </button>
              </div>
            ) : hostStatus === "disabled" || hostStatus === "blocked" ? (
              <div className="openrouter-dialog__state openrouter-dialog__state--configure" role="status">
                <ShieldAlert size={20} strokeWidth={2} aria-hidden="true" />
                <div>
                  <strong>
                    {hostStatus === "disabled"
                      ? "OpenRouter Host 生命周期已关闭"
                      : "OpenRouter Host 正在等待授权"}
                  </strong>
                  <p>{controller.provider?.host?.diagnostic.message}</p>
                  <p>请在“模块 → Local Plugin Host”中恢复生命周期或所需权限。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重试
                </button>
              </div>
            ) : !providerReady ? (
              <div className="openrouter-dialog__state openrouter-dialog__state--configure" role="status">
                <KeyRound size={20} strokeWidth={2} aria-hidden="true" />
                <div>
                  <strong>在本地服务配置密钥后即可运行</strong>
                  <p>设置 <code>OPENJIUWEN_OPENROUTER_API_KEY</code>（也兼容 <code>OPENROUTER_API_KEY</code>），重启服务后点击重试。</p>
                  <p>模型白名单由 <code>OPENJIUWEN_OPENROUTER_MODELS</code> 注册；未设置时只开放 <code>openrouter/free</code>。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重试
                </button>
              </div>
            ) : (
              <form className="openrouter-form" onSubmit={submit}>
                <div className="openrouter-form__notice">
                  <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
                  <p><strong>密钥仅在本地服务进程中。</strong>完整输入、Context 增量与流式输出会写入本机 Trace 档案，UI 默认显示脱敏摘要；请求正文也会发送到 OpenRouter 及其路由的上游模型，非免费模型可能产生费用。</p>
                </div>

                <label className="openrouter-form__field">
                  <span>注册模型 <small>SERVER ALLOWLIST</small></span>
                  <select
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={controller.active}
                  >
                    {controller.provider!.models.map((model) => (
                      <option value={model.id} key={model.id}>{model.label}</option>
                    ))}
                  </select>
                </label>

                <label className="openrouter-form__field openrouter-form__field--prompt">
                  <span>模拟输入 <small>{input.length} / {controller.provider!.limits.maxInputCharacters}</small></span>
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入要发送给模型的文字；运行后可在链路、时间轴与 Context Window 中逐步查看。"
                    maxLength={controller.provider!.limits.maxInputCharacters}
                    disabled={controller.active}
                  />
                </label>

                <details className="openrouter-form__advanced">
                  <summary>高级参数</summary>
                  <div>
                    <label className="openrouter-form__field openrouter-form__field--system">
                      <span>System prompt <small>OPTIONAL</small></span>
                      <textarea
                        value={systemPrompt}
                        onChange={(event) => setSystemPrompt(event.target.value)}
                        placeholder="可选；会作为独立 Context 消息展示。"
                        maxLength={controller.provider!.limits.maxSystemCharacters}
                        disabled={controller.active}
                      />
                    </label>
                    <label className="openrouter-form__field openrouter-form__field--tokens">
                      <span>最大输出 Token</span>
                      <input
                        type="number"
                        value={maxOutputTokens}
                        min={controller.provider!.limits.minOutputTokens}
                        max={controller.provider!.limits.maxOutputTokens}
                        step={16}
                        onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(value)) setMaxOutputTokens(value);
                        }}
                        disabled={controller.active}
                      />
                    </label>
                  </div>
                </details>

                {controller.invocation ? (
                  <div className="openrouter-form__invocation">
                    <span>{controller.invocation.modelId}</span>
                    <code>{controller.invocation.id}</code>
                    <strong>{phaseLabel[controller.phase]}</strong>
                  </div>
                ) : null}

                {controller.actionError ? (
                  <p className="openrouter-form__error" role="alert">{controller.actionError}</p>
                ) : null}

                <footer className="openrouter-form__actions">
                  <span>输出、用量与取消状态会自动进入当前 Trace。</span>
                  {controller.active ? (
                    <button
                      type="button"
                      className="openrouter-form__cancel"
                      onClick={() => void controller.cancel()}
                      disabled={controller.phase === "starting" || controller.phase === "cancelling"}
                    >
                      <CircleStop size={16} strokeWidth={2} aria-hidden="true" />
                      {controller.phase === "cancelling" ? "正在取消" : "取消调用"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="openrouter-form__run"
                      disabled={!input.trim() || !modelId}
                    >
                      <Play size={16} strokeWidth={2} aria-hidden="true" />运行并追踪
                    </button>
                  )}
                </footer>
              </form>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
