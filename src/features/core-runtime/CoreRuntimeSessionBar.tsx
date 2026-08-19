import {
  Activity,
  CircleDot,
  KeyRound,
  Plus,
  Radio,
  RotateCcw,
  Server,
} from "lucide-react";
import type { CreatedRuntimeTrace, RuntimeTraceSession } from "../../kernel";
import type { ReactNode } from "react";
import type { CoreRuntimeConnectionState } from "./use-core-runtime-session";

interface CoreRuntimeSessionBarProps {
  created: CreatedRuntimeTrace | null;
  trace: RuntimeTraceSession | null;
  connection: CoreRuntimeConnectionState;
  error: string | null;
  onCreate: () => void;
  onLoadRecording: () => void;
  recordingLabel: string;
  recordingAvailable: boolean;
  recordingLoading: boolean;
  recordingError: string | null;
  providerAction?: ReactNode;
  providerBusy?: boolean;
}

const connectionLabel: Record<CoreRuntimeConnectionState, string> = {
  idle: "未启动",
  creating: "创建中",
  connected: "监听中",
  reconnecting: "重连中",
  completed: "已完成",
  failed: "连接失败",
};

export function CoreRuntimeSessionBar({
  created,
  trace,
  connection,
  error,
  onCreate,
  onLoadRecording,
  recordingLabel,
  recordingAvailable,
  recordingLoading,
  recordingError,
  providerAction,
  providerBusy = false,
}: CoreRuntimeSessionBarProps) {
  return (
    <section className="core-runtime-session" aria-label="Core Runtime Trace 会话">
      <div className="core-runtime-session__identity">
        <Radio size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>
          <small>CORE RUNTIME · MEMORY ONLY</small>
          <strong>{trace?.label ?? "等待创建监听会话"}</strong>
        </span>
      </div>

      <span
        className={`core-runtime-status core-runtime-status--${connection}`}
        role="status"
      >
        <CircleDot size={13} strokeWidth={2} aria-hidden="true" />
        {connectionLabel[connection]}
      </span>

      {trace ? (
        <div className="core-runtime-session__metrics">
          <span><Activity size={13} aria-hidden="true" />{trace.eventCount} events</span>
          <code>{trace.id}</code>
        </div>
      ) : (
        <p>{error ?? "Trace 监听不执行 agent-core 或工具；模型需从 OpenRouter 显式启动。"}</p>
      )}

      {created ? (
        <details className="core-runtime-session__connection">
          <summary><Server size={13} aria-hidden="true" />接入信息</summary>
          <div>
            <span>POST endpoint</span>
            <code>{created.endpoints.events}</code>
            <span><KeyRound size={12} aria-hidden="true" />X-Trace-Token</span>
            <code>{created.writeToken}</code>
          </div>
        </details>
      ) : null}

      <button
        type="button"
        className="core-runtime-session__replay"
        onClick={onLoadRecording}
        disabled={!recordingAvailable || connection === "creating" || recordingLoading || providerBusy}
        title={recordingError ?? `载入：${recordingLabel}`}
      >
        <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
        {recordingLoading ? "载入中" : recordingAvailable ? "模型录制" : "模型模块已关闭"}
      </button>

      {providerAction}

      <button
        type="button"
        className="core-runtime-session__create"
        onClick={onCreate}
        disabled={connection === "creating" || providerBusy}
      >
        <Plus size={15} strokeWidth={2} aria-hidden="true" />
        {trace ? "新建 Trace" : "创建监听"}
      </button>
    </section>
  );
}
