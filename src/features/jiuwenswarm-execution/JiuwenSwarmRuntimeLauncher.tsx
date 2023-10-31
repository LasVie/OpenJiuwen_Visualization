import {
  Activity,
  CircleStop,
  KeyRound,
  Network,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  JiuwenSwarmExecutionController,
  JiuwenSwarmExecutionPhase,
} from "./use-jiuwenswarm-execution";
import { RuntimeEnvironmentIdentity } from "../runtime-environment";

interface JiuwenSwarmRuntimeLauncherProps {
  controller: JiuwenSwarmExecutionController;
  disabled?: boolean;
}

const phaseLabel: Record<JiuwenSwarmExecutionPhase, string> = {
  idle: "待运行",
  starting: "组队中",
  running: "团队运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
};

export function JiuwenSwarmRuntimeLauncher({
  controller,
  disabled = false,
}: JiuwenSwarmRuntimeLauncherProps) {
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
        className={`openrouter-launcher__trigger jiuwenswarm-launcher__trigger ${controller.active ? "openrouter-launcher__trigger--active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        disabled={disabled}
        title={`JiuwenSwarm Agent Team · ${triggerStatus}`}
      >
        <Network size={14} strokeWidth={2} aria-hidden="true" />
        Agent Team
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
            className="openrouter-dialog jiuwenswarm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="jiuwenswarm-dialog-title"
          >
            <header className="openrouter-dialog__header">
              <div>
                <span className="openrouter-dialog__mark jiuwenswarm-dialog__mark" aria-hidden="true">
                  <Network size={19} strokeWidth={2} />
                </span>
                <span>
                  <small>REAL AGENT TEAM · OPENROUTER</small>
                  <h2 id="jiuwenswarm-dialog-title">JiuwenSwarm 团队运行</h2>
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
                aria-label="关闭 JiuwenSwarm 运行面板"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            {controller.runtimeLoading ? (
              <div className="openrouter-dialog__state" role="status">
                <Activity size={20} strokeWidth={2} aria-hidden="true" />
                <div><strong>正在探测团队运行环境</strong><p>验证 JiuwenSwarm assembly 与 Agent Core Team 依赖；不会启动团队或访问模型。</p></div>
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
                  <strong>JiuwenSwarm 运行环境尚未就绪</strong>
                  <p>{controller.runtime?.diagnostic.message ?? "无法读取运行时诊断。"}</p>
                  <p>请在“连接”中绑定 JiuwenSwarm 仓库、检查其 Core 依赖并创建 <code>swarm-core-env</code>；无需从 Terminal 指定 Python 或源码路径。</p>
                </div>
                <button type="button" onClick={() => void controller.refresh()}>
                  <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />重新探测
                </button>
              </div>
            ) : (
              <form className="openrouter-form" onSubmit={submit}>
                <div className="openrouter-form__notice jiuwenswarm-form__notice">
                  <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
                  <p><strong>这会运行真实的两成员 Agent Team。</strong>Team Leader 与 Analysis Member 使用独立 Context，通过受控团队消息和任务协作；当前 profile 明确不是 SwarmFlow。</p>
                </div>
                <RuntimeEnvironmentIdentity environment={controller.runtime!.managedEnvironment} />

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
                  <span>团队任务 <small>{input.length} / {controller.runtime!.limits.maxInputCharacters}</small></span>
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入任务；运行后可逐步查看 Team、成员、任务、消息、成员 ReAct、Rail 与各自 Context Window。"
                    maxLength={controller.runtime!.limits.maxInputCharacters}
                    disabled={controller.active || disabled}
                  />
                </label>

                <details className="openrouter-form__advanced">
                  <summary>高级参数</summary>
                  <div>
                    <label className="openrouter-form__field openrouter-form__field--system">
                      <span>附加 Leader System prompt <small>OPTIONAL</small></span>
                      <textarea
                        value={systemPrompt}
                        onChange={(event) => setSystemPrompt(event.target.value)}
                        placeholder="可选；固定 roster、工具和隔离约束不可由浏览器覆盖。"
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

                <div className="openrouter-form__invocation jiuwenswarm-form__profile">
                  <span><Users size={12} aria-hidden="true" /> Leader + Analyst</span>
                  <code>scheduled · in-process</code>
                  <strong>非 SwarmFlow</strong>
                </div>

                {controller.invocation ? (
                  <div className="openrouter-form__invocation">
                    <span><Workflow size={12} aria-hidden="true" />{controller.invocation.teamName}</span>
                    <code>{controller.invocation.id}</code>
                    <strong>{phaseLabel[controller.phase]}</strong>
                  </div>
                ) : null}

                {controller.actionError ? (
                  <p className="openrouter-form__error" role="alert">{controller.actionError}</p>
                ) : null}

                <footer className="openrouter-form__actions">
                  <span>TeamMonitor、成员 Rail、任务/消息和每个成员的完整 Context 会自动进入 Trace。</span>
                  {controller.active ? (
                    <button
                      type="button"
                      className="openrouter-form__cancel"
                      onClick={() => void controller.cancel()}
                      disabled={controller.phase === "starting" || controller.phase === "cancelling"}
                    >
                      <CircleStop size={16} strokeWidth={2} aria-hidden="true" />
                      {controller.phase === "cancelling" ? "正在取消" : "取消团队"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="openrouter-form__run jiuwenswarm-form__run"
                      disabled={disabled || !input.trim() || !modelId}
                    >
                      <Play size={16} strokeWidth={2} aria-hidden="true" />运行 Agent Team
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
