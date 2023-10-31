import {
  Activity,
  Bot,
  CircleStop,
  KeyRound,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AgentCoreExecutionController,
  AgentCoreExecutionPhase,
} from "./use-agent-core-execution";
import { RuntimeEnvironmentIdentity } from "../runtime-environment";

interface AgentCoreRuntimeLauncherProps {
  controller: AgentCoreExecutionController;
}

const phaseLabel: Record<AgentCoreExecutionPhase, string> = {
  idle: "待运行",
  starting: "启动中",
  running: "Agent 运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
};

export function AgentCoreRuntimeLauncher({
  controller,
}: AgentCoreRuntimeLauncherProps) {
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
    if (!input.trim() || !modelId) return;
    await controller.start({
      modelId,
      input,
      ...(systemPrompt.trim() ? { systemPrompt } : {}),
      maxOutputTokens,
    });
  }

  const runtimeReady = Boolean(controller.runtime?.configured);
  const triggerStatus = controller.active
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
        className={`openrouter-launcher__trigger ${controller.active ? "openrouter-launcher__trigger--active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={`Agent Core · ${triggerStatus}`}
      >
        <Bot size={14} strokeWidth={2} aria-hidden="true" />
        Agent Core
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
            aria-labelledby="agent-core-dialog-title"
          >
            <header className="openrouter-dialog__header">
              <div>
                <span className="openrouter-dialog__mark" aria-hidden="true">
                  <Bot size={19} strokeWidth={2} />
                </span>
                <span>
                  <small>REAL DEEPAGENT · OPENROUTER</small>
                  <h2 id="agent-core-dialog-title">独立 Agent Core 运行</h2>
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
                aria-label="关闭 Agent Core 运行面板"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            {controller.runtimeLoading ? (
              <div className="openrouter-dialog__state" role="status">
                <Activity size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>正在探测 Agent Core 运行环境</strong><p>会验证 DeepAgent 导入与依赖，不会执行 Agent 或访问模型。</p></div>
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
                  <strong>Agent Core 运行环境尚未就绪</strong>
                  <p>{controller.runtime?.diagnostic.message ?? "无法读取运行时诊断。"}</p>
                  <p>请在“连接”中绑定 Agent Core 仓库并创建 <code>core-env</code>；运行前会自动检查仓库、锁文件与环境变化。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重新探测
                </button>
              </div>
            ) : (
              <form className="openrouter-form" onSubmit={submit}>
                <div className="openrouter-form__notice">
                  <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
                  <p><strong>这次会执行真实 DeepAgent，而不是伪造链路。</strong>隔离进程内运行 ReAct；只注册只读 <code>inspect_input</code> 工具。输入会发送到 OpenRouter 及其路由的模型。</p>
                </div>
                <RuntimeEnvironmentIdentity environment={controller.runtime!.managedEnvironment} />

                <label className="openrouter-form__field">
                  <span>OpenRouter 模型 <small>SERVER ALLOWLIST</small></span>
                  <select
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={controller.active}
                  >
                    {controller.runtime!.models.map((model) => (
                      <option value={model.id} key={model.id}>{model.label}</option>
                    ))}
                  </select>
                </label>

                <label className="openrouter-form__field openrouter-form__field--prompt">
                  <span>Agent 输入 <small>{input.length} / {controller.runtime!.limits.maxInputCharacters}</small></span>
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入任务；运行后可逐步查看 DeepAgent、ReAct、Rail、Tool、模型流与完整 Context Window。"
                    maxLength={controller.runtime!.limits.maxInputCharacters}
                    disabled={controller.active}
                  />
                </label>

                <details className="openrouter-form__advanced">
                  <summary>高级参数</summary>
                  <div>
                    <label className="openrouter-form__field openrouter-form__field--system">
                      <span>附加 System prompt <small>OPTIONAL</small></span>
                      <textarea
                        value={systemPrompt}
                        onChange={(event) => setSystemPrompt(event.target.value)}
                        placeholder="可选；工具调用约束由运行桥接自动追加。"
                        maxLength={controller.runtime!.limits.maxSystemCharacters}
                        disabled={controller.active}
                      />
                    </label>
                    <label className="openrouter-form__field openrouter-form__field--tokens">
                      <span>最大输出 Token</span>
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
                        disabled={controller.active}
                      />
                    </label>
                  </div>
                </details>

                <div className="openrouter-form__invocation">
                  <span><Wrench size={12} aria-hidden="true" /> inspect_input</span>
                  <code>ReAct ≤ {controller.runtime!.limits.maxIterations}</code>
                  <strong>{phaseLabel[controller.phase]}</strong>
                </div>

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
                  <span>Rail 审查、实际 ContextWindow、工具结果、流和取消会自动进入 Trace。</span>
                  {controller.active ? (
                    <button
                      type="button"
                      className="openrouter-form__cancel"
                      onClick={() => void controller.cancel()}
                      disabled={controller.phase === "starting" || controller.phase === "cancelling"}
                    >
                      <CircleStop size={16} strokeWidth={2} aria-hidden="true" />
                      {controller.phase === "cancelling" ? "正在取消" : "取消 Agent"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="openrouter-form__run"
                      disabled={!input.trim() || !modelId}
                    >
                      <Play size={16} strokeWidth={2} aria-hidden="true" />运行 DeepAgent
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
