import { FlaskConical, Network, Radio } from "lucide-react";

export type RuntimeSourceMode = "fixture" | "core-runtime" | "swarm-runtime";

interface RuntimeSourceToggleProps {
  value: RuntimeSourceMode;
  onChange: (value: RuntimeSourceMode) => void;
}

export function RuntimeSourceToggle({ value, onChange }: RuntimeSourceToggleProps) {
  return (
    <div className="runtime-source-toggle" role="group" aria-label="运行链路数据源">
      <button
        type="button"
        className={value === "fixture" ? "runtime-source-toggle--active" : ""}
        onClick={() => onChange("fixture")}
        aria-pressed={value === "fixture"}
      >
        <FlaskConical size={14} strokeWidth={1.8} aria-hidden="true" />演示
      </button>
      <button
        type="button"
        className={value === "core-runtime" ? "runtime-source-toggle--active" : ""}
        onClick={() => onChange("core-runtime")}
        aria-pressed={value === "core-runtime"}
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
      >
        <Network size={14} strokeWidth={1.8} aria-hidden="true" />Swarm Trace
      </button>
    </div>
  );
}
