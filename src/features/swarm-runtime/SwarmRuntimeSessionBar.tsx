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
}: SwarmRuntimeSessionBarProps) {
  return (
    <section className="swarm-runtime-session" aria-label="Swarm Runtime Trace 会话">
      <div className="swarm-runtime-session__identity">
        <Network size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>
          <small>SWARM RUNTIME · MEMORY ONLY</small>
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
        <p>{error ?? "只接收事件，不执行团队、Agent、工具或模型。"}</p>
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
        disabled={!recordingAvailable || connection === "creating" || recordingLoading}
        title={recordingLabel}
      >
        <PlayCircle size={14} strokeWidth={2} aria-hidden="true" />
        {recordingLoading ? "载入中" : recordingAvailable ? "Subagent 演示" : "Subagent 模块已关闭"}
      </button>

      <button
        type="button"
        className="swarm-runtime-session__create"
        onClick={onCreate}
        disabled={connection === "creating"}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
        新会话
      </button>
      {recordingError ? (
        <p className="swarm-runtime-session__error" role="alert">{recordingError}</p>
      ) : null}
    </section>
  );
}
