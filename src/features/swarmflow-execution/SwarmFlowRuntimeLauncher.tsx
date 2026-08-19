import {
  Activity,
  ArrowRight,
  CircleStop,
  GitBranch,
  KeyRound,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  SwarmFlowExecutionController,
  SwarmFlowExecutionPhase,
} from "./use-swarmflow-execution";

interface SwarmFlowRuntimeLauncherProps {
  controller: SwarmFlowExecutionController;
  disabled?: boolean;
}

const phaseLabel: Record<SwarmFlowExecutionPhase, string> = {
  idle: "待运行",
  starting: "启动中",
  running: "工作流运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
};

export function SwarmFlowRuntimeLauncher({
  controller,
  disabled = false,
}: SwarmFlowRuntimeLauncherProps) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState(512);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const runtime = controller.runtime;
    if (!runtime) return;
    if (!runtime.models.some((model) => model.id === modelId)) {
      setModelId(runtime.defaultModelId);
    }
    setMaxOutputTokens((current) =>
      Math.min(runtime.limits.maxOutputTokens, Math.max(
        runtime.limits.minOutputTokens,
        current || runtime.limits.defaultOutputTokens,
      )));
  }, [controller.runtime, modelId]);

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
    if (disabled || !input.trim() || !modelId) return;
    await controller.start({
      modelId,
      input,
      ...(systemPrompt.trim() ? { systemPrompt } : {}),
      maxOutputTokens,
    });
  }

  const runtimeReady = Boolean(controller.runtime?.configured);
  const triggerStatus = disabled
    ? "其他执行器运行中"
    : controller.active
      ? phaseLabel[controller.phase]
      : controller.runtimeLoading
        ? "检查中"
        : controller.runtimeError
          ? "服务不可达"
          : runtimeReady
            ? "已就绪"
            : "待配置";

  return (
    <>
      <button
        type="button"
        className={`openrouter-launcher__trigger swarmflow-launcher__trigger ${controller.active ? "openrouter-launcher__trigger--active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        disabled={disabled}
        title={`Agent Core SwarmFlow · ${triggerStatus}`}
      >
        <GitBranch size={14} strokeWidth={2} aria-hidden="true" />
        SwarmFlow
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
            className="openrouter-dialog swarmflow-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="swarmflow-dialog-title"
          >
            <header className="openrouter-dialog__header">
              <div>
                <span className="openrouter-dialog__mark swarmflow-dialog__mark" aria-hidden="true">
                  <GitBranch size={19} strokeWidth={2} />
                </span>
                <span>
                  <small>REAL SWARMFLOW · OPENROUTER</small>
                  <h2 id="swarmflow-dialog-title">两阶段工作流运行</h2>
                </span>
              </div>
              <span className={`openrouter-dialog__phase openrouter-dialog__phase--${controller.phase}`}>
                {controller.active
                  ? <Activity size={13} strokeWidth={2} aria-hidden="true" />
                  : <Server size={13} strokeWidth={2} aria-hidden="true" />}
                {phaseLabel[controller.phase]}
              </span>
              <button
                type="button"
                className="openrouter-dialog__close"
                onClick={() => setOpen(false)}
                aria-label="关闭 SwarmFlow 运行面板"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            {controller.runtimeLoading ? (
              <div className="openrouter-dialog__state" role="status">
                <Activity size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>正在探测工作流运行环境</strong><p>验证 Agent Core SwarmFlow 与 JiuwenSwarm Workflow monitor；不会启动 Worker 或访问模型。</p></div>
              </div>
            ) : controller.runtimeError ? (
              <div className="openrouter-dialog__state openrouter-dialog__state--error" role="alert">
                <Server size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>本地服务不可达</strong><p>{controller.runtimeError}</p></div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重试
                </button>
              </div>
            ) : !runtimeReady ? (
              <div className="openrouter-dialog__state openrouter-dialog__state--configure" role="status">
                <KeyRound size={20} strokeWidth={2} aria-hidden="true" />
                <div>
                  <strong>SwarmFlow 运行环境尚未就绪</strong>
                  <p>{controller.runtime?.diagnostic.message ?? "无法读取运行时诊断。"}</p>
                  <p>Python 入口可由 <code>OPENJIUWEN_SWARMFLOW_PYTHON</code> 指定；OpenRouter key、源码路径与固定 workflow 都只存在于本地服务。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重新探测
                </button>
              </div>
            ) : (
              <form className="openrouter-form" onSubmit={submit}>
                <div className="openrouter-form__notice swarmflow-form__notice">
                  <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
                  <p><strong>运行真实、固定形状的 SwarmFlow。</strong>两个阶段各创建一个临时 TeamHarness Worker；它们不属于 Agent Team roster，Context 相互隔离，最终 Rail 会移除全部工具 schema。</p>
                </div>

                <div className="swarmflow-form__route" aria-label="固定工作流阶段">
                  {controller.runtime!.phases.map((item, index) => (
                    <div key={item.id}>
                      <span><small>PHASE {index + 1}</small><strong>{item.label}</strong><em>{item.agent}</em></span>
                      {index < controller.runtime!.phases.length - 1
                        ? <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" />
                        : null}
                    </div>
                  ))}
                </div>

                <label className="openrouter-form__field">
                  <span>OpenRouter 模型 <small>SERVER ALLOWLIST</small></span>
                  <select
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={controller.active || disabled}
                  >
                    {controller.runtime!.models.map((model) => (
                      <option value={model.id} key={model.id}>{model.label}</option>
                    ))}
                  </select>
                </label>

                <label className="openrouter-form__field openrouter-form__field--prompt">
                  <span>工作流输入 <small>{input.length} / {controller.runtime!.limits.maxInputCharacters}</small></span>
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入文字；运行后可以逐步查看 Workflow、Phase、Worker ReAct、Rail 审查和两个独立 Context Window。"
                    maxLength={controller.runtime!.limits.maxInputCharacters}
                    disabled={controller.active || disabled}
                  />
                </label>

                <details className="openrouter-form__advanced">
                  <summary>高级参数</summary>
                  <div>
                    <label className="openrouter-form__field openrouter-form__field--system">
                      <span>附加回复指导 <small>OPTIONAL</small></span>
                      <textarea
                        value={systemPrompt}
                        onChange={(event) => setSystemPrompt(event.target.value)}
                        placeholder="可影响分析与回答风格；不能覆盖阶段、Worker、工具和隔离策略。"
                        maxLength={controller.runtime!.limits.maxSystemCharacters}
                        disabled={controller.active || disabled}
                      />
                    </label>
                    <label className="openrouter-form__field openrouter-form__field--tokens">
                      <span>每个 Worker 单次模型最大输出 Token</span>
                      <input
                        type="number"
                        value={maxOutputTokens}
                        min={controller.runtime!.limits.minOutputTokens}
                        max={controller.runtime!.limits.maxOutputTokens}
                        step={16}
                        onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(value)) setMaxOutputTokens(value);
                        }}
                        disabled={controller.active || disabled}
                      />
                    </label>
                  </div>
                </details>

                {controller.invocation ? (
                  <div className="openrouter-form__invocation swarmflow-form__invocation">
                    <span><Workflow size={12} aria-hidden="true" />{controller.invocation.runId}</span>
                    <code>{controller.invocation.id}</code>
                    <strong>{phaseLabel[controller.phase]}</strong>
                  </div>
                ) : null}

                {controller.actionError ? (
                  <p className="openrouter-form__error" role="alert">{controller.actionError}</p>
                ) : null}

                <footer className="openrouter-form__actions">
                  <span>进度只来自结构化 WorkflowProgressEvent；状态不会从日志文本推断。</span>
                  {controller.active ? (
                    <button
                      type="button"
                      className="openrouter-form__cancel"
                      onClick={() => void controller.cancel()}
                      disabled={controller.phase === "starting" || controller.phase === "cancelling"}
                    >
                      <CircleStop size={16} strokeWidth={2} aria-hidden="true" />
                      {controller.phase === "cancelling" ? "正在取消" : "取消工作流"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="openrouter-form__run swarmflow-form__run"
                      disabled={disabled || !input.trim() || !modelId}
                    >
                      <Play size={16} strokeWidth={2} aria-hidden="true" />运行 SwarmFlow
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
