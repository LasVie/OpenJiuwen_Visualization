import {
  Activity,
  Bot,
  CircleStop,
  GitFork,
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
  SubagentExecutionController,
  SubagentExecutionPhase,
} from "./use-subagent-execution";

interface SubagentRuntimeLauncherProps {
  controller: SubagentExecutionController;
  disabled?: boolean;
}

const phaseLabel: Record<SubagentExecutionPhase, string> = {
  idle: "待运行",
  starting: "委派中",
  running: "子任务运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
};

export function SubagentRuntimeLauncher({
  controller,
  disabled = false,
}: SubagentRuntimeLauncherProps) {
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
        className={`openrouter-launcher__trigger subagent-launcher__trigger ${controller.active ? "openrouter-launcher__trigger--active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        disabled={disabled}
        title={`Agent Core TaskTool Subagent · ${triggerStatus}`}
      >
        <GitFork size={14} strokeWidth={2} aria-hidden="true" />
        Subagent
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
            className="openrouter-dialog subagent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="subagent-dialog-title"
          >
            <header className="openrouter-dialog__header">
              <div>
                <span className="openrouter-dialog__mark subagent-dialog__mark" aria-hidden="true">
                  <GitFork size={19} strokeWidth={2} />
                </span>
                <span>
                  <small>REAL TASKTOOL SUBAGENT · OPENROUTER</small>
                  <h2 id="subagent-dialog-title">单层 Subagent 委派</h2>
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
                aria-label="关闭 Subagent 运行面板"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            {controller.runtimeLoading ? (
              <div className="openrouter-dialog__state" role="status">
                <Activity size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>正在探测 Subagent 运行环境</strong><p>只验证 DeepAgent、SubAgentConfig 与 TaskTool 依赖，不会调用模型。</p></div>
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
                  <strong>Subagent 运行环境尚未就绪</strong>
                  <p>{controller.runtime?.diagnostic.message ?? "无法读取运行时诊断。"}</p>
                  <p>Python 可由 <code>OPENJIUWEN_SUBAGENT_PYTHON</code> 指定；源码位置和 OpenRouter key 只存在于本地服务。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重新探测
                </button>
              </div>
            ) : (
              <form className="openrouter-form" onSubmit={submit}>
                <div className="openrouter-form__notice subagent-form__notice">
                  <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
                  <p><strong>这会运行真实的父子 DeepAgent 链路。</strong>父 Agent 通过前台 <code>task_tool</code> 创建一个独立 child session；这不是 Agent Team，也不是 SwarmFlow。</p>
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
                  <span>父 Agent 输入 <small>{input.length} / {controller.runtime!.limits.maxInputCharacters}</small></span>
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入任务；运行后可查看父侧 task_tool、child ReAct、Rail、只读 Tool 与两份独立 Context。"
                    maxLength={controller.runtime!.limits.maxInputCharacters}
                    disabled={controller.active || disabled}
                  />
                </label>

                <details className="openrouter-form__advanced">
                  <summary>高级参数</summary>
                  <div>
                    <label className="openrouter-form__field openrouter-form__field--system">
                      <span>附加 Parent System prompt <small>OPTIONAL</small></span>
                      <textarea
                        value={systemPrompt}
                        onChange={(event) => setSystemPrompt(event.target.value)}
                        placeholder="可选；委派次数、child 类型、工具和隔离策略不可由浏览器覆盖。"
                        maxLength={controller.runtime!.limits.maxSystemCharacters}
                        disabled={controller.active || disabled}
                      />
                    </label>
                    <label className="openrouter-form__field openrouter-form__field--tokens">
                      <span>单次模型最大输出 Token</span>
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

                <div className="subagent-form__route" aria-label="固定 Subagent 执行路径">
                  <span><Bot size={13} aria-hidden="true" /> Parent DeepAgent</span>
                  <GitFork size={14} aria-hidden="true" />
                  <code>task_tool</code>
                  <GitFork size={14} aria-hidden="true" />
                  <span><Bot size={13} aria-hidden="true" /> analysis_subagent</span>
                </div>

                <div className="openrouter-form__invocation subagent-form__profile">
                  <span>前台 · 单 child · 单层</span>
                  <code>child: inspect_delegated_task</code>
                  <strong>独立 Context</strong>
                </div>

                {controller.invocation ? (
                  <div className="openrouter-form__invocation">
                    <span><Workflow size={12} aria-hidden="true" />{controller.invocation.parentSessionId}</span>
                    <code>{controller.invocation.id}</code>
                    <strong>{phaseLabel[controller.phase]}</strong>
                  </div>
                ) : null}

                {controller.actionError ? (
                  <p className="openrouter-form__error" role="alert">{controller.actionError}</p>
                ) : null}

                <footer className="openrouter-form__actions">
                  <span>child 卡片出现后可点击进入独立画布；父子完整 Context 由右侧 owner 作用域切换。</span>
                  {controller.active ? (
                    <button
                      type="button"
                      className="openrouter-form__cancel"
                      onClick={() => void controller.cancel()}
                      disabled={controller.phase === "starting" || controller.phase === "cancelling"}
                    >
                      <CircleStop size={16} strokeWidth={2} aria-hidden="true" />
                      {controller.phase === "cancelling" ? "正在取消" : "取消父子链路"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="openrouter-form__run subagent-form__run"
                      disabled={disabled || !input.trim() || !modelId}
                    >
                      <Play size={16} strokeWidth={2} aria-hidden="true" />运行 Subagent
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
