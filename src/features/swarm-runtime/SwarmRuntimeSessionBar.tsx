import {
  Activity,
  CircleDot,
  KeyRound,
  Network,
  PlayCircle,
  Plus,
  Server,
} from "lucide-react";
import type { CreatedRuntimeTrace, RuntimeTraceSession } from "../../kernel";
import type { ReactNode } from "react";
import type { RuntimeTraceConnectionState } from "../runtime-trace";

interface SwarmRuntimeSessionBarProps {
  created: CreatedRuntimeTrace | null;
  trace: RuntimeTraceSession | null;
  connection: RuntimeTraceConnectionState;
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

const connectionLabel: Record<RuntimeTraceConnectionState, string> = {
  idle: "未启动",
  creating: "创建中",
  connected: "监听中",
  reconnecting: "重连中",
  completed: "已完成",
  failed: "连接失败",
};

export function SwarmRuntimeSessionBar({
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
}: SwarmRuntimeSessionBarProps) {
  return (
    <section className="swarm-runtime-session" aria-label="Swarm Runtime Trace 会话">
      <div className="swarm-runtime-session__identity">
        <Network size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>
          <small>SWARM RUNTIME · LIVE MEMORY + LOCAL ARCHIVE</small>
          <strong>{trace?.label ?? "等待创建 Swarm 监听会话"}</strong>
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
        <div className="swarm-runtime-session__metrics">
          <span><Activity size={13} aria-hidden="true" />{trace.eventCount} events</span>
          <code>{trace.id}</code>
        </div>
      ) : (
        <p>{error ?? "Trace 监听本身不执行模型；Agent Team、SwarmFlow 与 Subagent 均需从对应面板显式启动。"}</p>
      )}

      {created ? (
        <details className="swarm-runtime-session__connection">
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
        className="swarm-runtime-session__recording"
        onClick={onLoadRecording}
        disabled={!recordingAvailable || connection === "creating" || recordingLoading || providerBusy}
        title={recordingLabel}
      >
        <PlayCircle size={14} strokeWidth={2} aria-hidden="true" />
        {recordingLoading ? "载入中" : recordingAvailable ? "Subagent 演示" : "Subagent 模块已关闭"}
      </button>

      {providerAction}

      <button
        type="button"
        className="swarm-runtime-session__create"
        onClick={onCreate}
        disabled={connection === "creating" || providerBusy}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
        {trace ? "新建 Trace" : "创建监听"}
      </button>
      {recordingError ? (
        <p className="swarm-runtime-session__error" role="alert">{recordingError}</p>
      ) : null}
    </section>
  );
}
