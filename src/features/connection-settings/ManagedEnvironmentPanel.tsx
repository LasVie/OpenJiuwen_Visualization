import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Cpu,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ManagedEnvironmentStatus } from "../../adapters/local-environments";

interface ManagedEnvironmentPanelProps {
  environment: ManagedEnvironmentStatus;
  reconciling: boolean;
  disabled: boolean;
  onReconcile: () => void;
}

function stateLabel(environment: ManagedEnvironmentStatus) {
  if (environment.state === "ready") return "已验证";
  if (environment.state === "drifted") return "需要更新";
  if (environment.state === "blocked") return "配置受阻";
  if (environment.state === "plan-drift") return "规格待刷新";
  return "待创建";
}

function stateDescription(environment: ManagedEnvironmentStatus) {
  if (environment.state === "ready") {
    return "当前 active generation 与仓库、uv.lock 和 Python 约束完全一致。";
  }
  if (environment.state === "drifted") {
    return "仓库或锁文件已变化；旧环境仍保留，但不会被视为当前可用环境。";
  }
  if (environment.state === "blocked") return environment.desired.resolution.message;
  if (environment.state === "plan-drift") {
    return "本机生成规格缺失或已变化；执行检查时会先按当前仓库证据重新生成。";
  }
  return "期望状态已生成，尚未构建并激活对应的隔离环境。";
}

function actionLabel(environment: ManagedEnvironmentStatus) {
  if (environment.state === "ready") return "重新校验环境";
  if (environment.state === "drifted") return "修复并切换";
  return "创建并校验环境";
}

export function ManagedEnvironmentPanel({
  environment,
  reconciling,
  disabled,
  onReconcile,
}: ManagedEnvironmentPanelProps) {
  const active = environment.active;
  const blocked = environment.desired.resolution.status !== "ready";
  const StateIcon = environment.state === "ready"
    ? CheckCircle2
    : environment.state === "blocked"
      ? AlertTriangle
      : Cpu;

  return (
    <section className={`managed-environment managed-environment--${environment.state}`} aria-label={`${environment.label} 状态`}>
      <header>
        <div>
          <span><Boxes size={16} strokeWidth={1.9} aria-hidden="true" /></span>
          <div>
            <small>MANAGED ENVIRONMENT · {environment.id.toUpperCase()}</small>
            <strong>{environment.label}</strong>
          </div>
        </div>
        <em><StateIcon size={12} strokeWidth={2.1} aria-hidden="true" />{stateLabel(environment)}</em>
      </header>

      <p>{stateDescription(environment)}</p>

      <div className="managed-environment__evidence">
        <div>
          <span>PYTHON</span>
          <strong>{active?.pythonVersion ?? environment.desired.python.requested}</strong>
          <small>{active ? `uv ${active.uvVersion}` : "uv-managed · frozen"}</small>
        </div>
        <div>
          <span>DESIRED</span>
          <code title={environment.desired.fingerprint}>{environment.desired.fingerprint.slice(0, 12)}</code>
          <small>{environment.desired.project.source.dirty ? "source dirty" : "source clean"}</small>
        </div>
        <div>
          <span>ACTIVE</span>
          <code title={active?.fingerprint ?? "尚未激活"}>{active?.fingerprint.slice(0, 12) ?? "—"}</code>
          <small>{active ? "validation passed" : "no generation"}</small>
        </div>
      </div>

      <div className="managed-environment__consumers">
        <Cpu size={14} strokeWidth={1.9} aria-hidden="true" />
        <span>独立服务</span>
        {environment.consumers.map((consumer) => <code key={consumer}>{consumer}</code>)}
      </div>

      <footer>
        <span><ShieldCheck size={13} strokeWidth={1.9} aria-hidden="true" />只修改本机受管目录；源码仓保持只读，验证通过后才原子切换。</span>
        <button
          type="button"
          className={reconciling ? "repository-action--loading" : ""}
          onClick={onReconcile}
          disabled={disabled || blocked}
          title={blocked ? environment.desired.resolution.message : undefined}
        >
          {reconciling
            ? <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" />
            : <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />}
          {reconciling ? "正在检查与修复" : actionLabel(environment)}
        </button>
      </footer>
    </section>
  );
}
