import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DevelopmentStage } from "./model";

interface DevelopmentTimelineProps {
  stages: readonly DevelopmentStage[];
  activeIndex: number;
  onChange: (index: number) => void;
}

export function DevelopmentTimeline({
  stages,
  activeIndex,
  onChange,
}: DevelopmentTimelineProps) {
  const active = stages[activeIndex];
  const progress = stages.length > 1 ? (activeIndex / (stages.length - 1)) * 100 : 100;
  return (
    <section className="development-timeline" aria-label="开发分析步骤">
      <div className="development-timeline__controls">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, activeIndex - 1))}
          disabled={activeIndex === 0}
          aria-label="上一步"
        >
          <ChevronLeft size={18} />
        </button>
        <span>
          <small>STEP {String(activeIndex + 1).padStart(2, "0")} / {String(stages.length).padStart(2, "0")}</small>
          <strong>{active?.label}</strong>
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(stages.length - 1, activeIndex + 1))}
          disabled={activeIndex >= stages.length - 1}
          aria-label="下一步"
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="development-timeline__track">
        <div className="development-timeline__progress" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="development-timeline__steps">
          {stages.map((stage, index) => (
            <button
              type="button"
              key={stage.id}
              className={[
                index === activeIndex ? "development-timeline__step--active" : "",
                index < activeIndex ? "development-timeline__step--visited" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => onChange(index)}
              aria-current={index === activeIndex ? "step" : undefined}
            >
              <span>{String(stage.ordinal).padStart(2, "0")}</span>
              <strong>{stage.label}</strong>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
