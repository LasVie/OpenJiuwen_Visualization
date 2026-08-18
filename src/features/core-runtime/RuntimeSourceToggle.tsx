import { FlaskConical, Network, Radio } from "lucide-react";

export type RuntimeSourceMode = "fixture" | "core-runtime" | "swarm-runtime";

interface RuntimeSourceToggleProps {
  value: RuntimeSourceMode;
  available?: Readonly<Record<RuntimeSourceMode, boolean>>;
  onChange: (value: RuntimeSourceMode) => void;
}

const allSourcesAvailable: Readonly<Record<RuntimeSourceMode, boolean>> = {
  fixture: true,
  "core-runtime": true,
  "swarm-runtime": true,
};

export function RuntimeSourceToggle({
  value,
  available = allSourcesAvailable,
  onChange,
}: RuntimeSourceToggleProps) {
  return (
    <div className="runtime-source-toggle" role="group" aria-label="运行链路数据源">
      <button
        type="button"
        className={value === "fixture" ? "runtime-source-toggle--active" : ""}
        onClick={() => onChange("fixture")}
        aria-pressed={value === "fixture"}
        disabled={!available.fixture}
        aria-label={available.fixture ? "演示" : "演示模块已关闭"}
      >
        <FlaskConical size={14} strokeWidth={1.8} aria-hidden="true" />演示
      </button>
      <button
        type="button"
        className={value === "core-runtime" ? "runtime-source-toggle--active" : ""}
        onClick={() => onChange("core-runtime")}
        aria-pressed={value === "core-runtime"}
        disabled={!available["core-runtime"]}
        aria-label={available["core-runtime"] ? "Core Trace" : "Agent Core 模块已关闭"}
      >
        <Radio size={14} strokeWidth={1.8} aria-hidden="true" />Core Trace
      </button>
      <button
        type="button"
        className={
          value === "swarm-runtime"
            ? "runtime-source-toggle--active runtime-source-toggle--swarm"
            : ""
        }
        onClick={() => onChange("swarm-runtime")}
        aria-pressed={value === "swarm-runtime"}
        disabled={!available["swarm-runtime"]}
        aria-label={available["swarm-runtime"] ? "Swarm Trace" : "JiuWenSwarm 模块已关闭"}
      >
        <Network size={14} strokeWidth={1.8} aria-hidden="true" />Swarm Trace
      </button>
    </div>
  );
}
