import { useId } from "react";
import { Magnet } from "lucide-react";
import { magneticStrengthLabel } from "./magnetic-layout";

interface MagnetControlsProps {
  enabled: boolean;
  strength: number;
  onToggle: () => void;
  onStrengthChange: (strength: number) => void;
}

export function MagnetControls({
  enabled,
  strength,
  onToggle,
  onStrengthChange,
}: MagnetControlsProps) {
  const inputId = useId();
  const strengthLabel = magneticStrengthLabel(strength);

  return (
    <div
      className={
        enabled ? "magnet-controls magnet-controls--enabled" : "magnet-controls"
      }
      role="group"
      aria-label="画布磁吸设置"
    >
      <button
        type="button"
        className="magnet-controls__toggle"
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={enabled ? "关闭画布磁吸" : "开启画布磁吸"}
      >
        <Magnet size={16} strokeWidth={2} aria-hidden="true" />
        <span>磁吸</span>
      </button>
      <label className="magnet-controls__strength" htmlFor={inputId}>
        <span>磁性</span>
        <input
          id={inputId}
          type="range"
          min={1}
          max={100}
          step={1}
          value={strength}
          disabled={!enabled}
          onInput={(event) =>
            onStrengthChange(Number(event.currentTarget.value))
          }
          aria-label="磁性强度"
          aria-valuetext={strengthLabel}
        />
        <output htmlFor={inputId}>{strengthLabel}</output>
      </label>
    </div>
  );
}
