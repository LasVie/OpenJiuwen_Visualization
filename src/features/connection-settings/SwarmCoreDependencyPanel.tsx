import {
  Check,
  FileSearch,
  GitCommitHorizontal,
  LoaderCircle,
  MapPin,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { SwarmCoreDependencyInspection } from "../../adapters/local-settings";

interface SwarmCoreDependencyPanelProps {
  inspection: SwarmCoreDependencyInspection | null;
  inspecting: boolean;
  disabled: boolean;
  onInspect: () => void;
}

function statusLabel(inspection: SwarmCoreDependencyInspection | null) {
  if (!inspection) return "等待检查";
  if (inspection.status === "ready") return "可构建";
  if (inspection.status === "attention") return "需要注意";
  return "不可用";
}

function resultMessage(inspection: SwarmCoreDependencyInspection) {
  const messages: Record<string, string> = {
    git_core_dependency_locked: "uv.lock 已将 Core 固定到精确提交，可作为 swarm-core-env 的构建依据。",
    git_core_dependency_unlocked: "已识别远程 Core，但缺少精确锁定提交；构建前需要完成锁定。",
    local_core_dependency: "已识别本地 Core 仓库；环境会跟随该路径的实际 revision。",
    core_lock_source_mismatch: "pyproject.toml 与 uv.lock 指向不同的 Core 仓库，需要先消除漂移。",
    registry_core_dependency: "当前由包注册表提供 Core，无法关联到可检视的源码仓库。",
    core_dependency_missing: "Swarm Config 中没有找到 openjiuwen 依赖声明。",
  };
  return messages[inspection.code] ?? inspection.message;
}

function shortRevision(value: string | null) {
  return value ? value.slice(0, 12) : "未锁定";
}

export function SwarmCoreDependencyPanel({
  inspection,
  inspecting,
  disabled,
  onInspect,
}: SwarmCoreDependencyPanelProps) {
  const source = inspection?.source ?? null;
  const status = inspection?.status ?? "unavailable";

  return (
    <section className={`swarm-core-dependency swarm-core-dependency--${status}`} aria-label="Swarm Core 依赖检查">
      <header>
        <div>
          <span><FileSearch size={16} strokeWidth={1.9} aria-hidden="true" /></span>
          <div><small>SWARM CONFIG</small><strong>Core 依赖</strong></div>
        </div>
        <em>
          {status === "ready" ? <Check size={12} strokeWidth={2.2} aria-hidden="true" /> : <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />}
          {statusLabel(inspection)}
        </em>
      </header>

      <p>{inspection ? resultMessage(inspection) : "尚未取得 Swarm Config 的只读检查结果。"}</p>

      {source ? (
        <div className="swarm-core-dependency__evidence">
          <div>
            <span>模式</span>
            <strong>{source.kind === "git" ? "远程 Git Core" : source.kind === "path" ? "本地 Core 仓库" : "包注册表"}</strong>
          </div>
          {source.kind === "git" ? (
            <>
              <div><span>来源</span><code title={source.url}>{source.url}</code></div>
              <div><span>声明</span><code>{source.ref.value ? `${source.ref.kind} · ${source.ref.value}` : "默认 ref"}</code></div>
              <div><span>锁定</span><code title={source.lockedRevision ?? undefined}><GitCommitHorizontal size={12} strokeWidth={1.9} aria-hidden="true" />{shortRevision(source.lockedRevision)}</code></div>
            </>
          ) : source.kind === "path" ? (
            <>
              <div><span>来源</span><code title={source.path}><MapPin size={12} strokeWidth={1.9} aria-hidden="true" />{source.path}</code></div>
              <div><span>分支</span><code>{source.branch}{source.dirty ? " · dirty" : ""}</code></div>
              <div><span>Revision</span><code title={source.revision}>{shortRevision(source.revision)}</code></div>
            </>
          ) : (
            <>
              <div><span>声明</span><code>{source.declaredRequirement}</code></div>
              <div><span>版本</span><code>{source.lockedVersion ?? "未锁定"}</code></div>
            </>
          )}
          <div>
            <span>证据</span>
            <code>
              {inspection?.evidence.pyproject ? `pyproject · ${inspection.evidence.pyproject.sha256.slice(0, 10)}` : "pyproject unavailable"}
              {inspection?.evidence.uvLock ? ` / uv.lock · ${inspection.evidence.uvLock.sha256.slice(0, 10)}` : " / no uv.lock"}
            </code>
          </div>
        </div>
      ) : null}

      <footer>
        <span>只读解析配置，不导入项目代码；结果仅用于 Swarm + Core 环境。</span>
        <button type="button" className={inspecting ? "repository-action--loading" : ""} onClick={onInspect} disabled={disabled}>
          {inspecting ? <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" /> : <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />}
          {inspecting ? "检查中" : "检查 Swarm Config"}
        </button>
      </footer>
    </section>
  );
}
