import type { CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Keyboard,
  RotateCcw,
  TimerReset,
} from "lucide-react";
import type { TraceScenario, TraceStep } from "../types/trace";

interface TimelineControlsProps {
  scenario: TraceScenario;
  step: TraceStep;
  stepIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
}

type ProgressStyle = CSSProperties & { "--progress": string };

export function TimelineControls({
  scenario,
  step,
  stepIndex,
  onPrevious,
  onNext,
  onJump,
}: TimelineControlsProps) {
  const lastStep = scenario.steps.length - 1;
  const progress = lastStep === 0 ? 100 : (stepIndex / lastStep) * 100;

  return (
    <footer className="timeline">
      <div className="timeline__transport">
        <button
          type="button"
          className="icon-button timeline__reset"
          onClick={() => onJump(0)}
          disabled={stepIndex === 0}
          aria-label="回到第一步"
          data-tooltip="回到第一步"
        >
          <RotateCcw size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="transport-button"
          onClick={onPrevious}
          disabled={stepIndex === 0}
        >
          <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
          上一步
        </button>
        <button
          type="button"
          className="transport-button transport-button--primary"
          onClick={onNext}
          disabled={stepIndex === lastStep}
        >
          下一步
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="timeline__main">
        <div className="timeline__headline">
          <span className="timeline__step-count">
            STEP
            <b>{String(stepIndex + 1).padStart(2, "0")}</b>
            <em>/ {String(scenario.steps.length).padStart(2, "0")}</em>
          </span>
          <span className="timeline__current-title">
            <strong>{step.title}</strong>
            <code>{step.eventCode}</code>
          </span>
          <span className="timeline__time">
            <TimerReset size={15} strokeWidth={1.8} aria-hidden="true" />
            t+{step.timestampMs}ms
          </span>
        </div>

        <div
          className="timeline__step-rail"
          style={{ "--progress": progress + "%" } as ProgressStyle}
          aria-label="回放步骤轨道"
        >
          {scenario.steps.map((traceStep, index) => {
            const state =
              index === stepIndex
                ? "current"
                : index < stepIndex
                  ? "complete"
                  : "future";
            return (
              <button
                type="button"
                className={
                  "timeline-step timeline-step--" + state
                }
                onClick={() => onJump(index)}
                aria-current={state === "current" ? "step" : undefined}
                aria-label={
                  "跳转到第 " +
                  (index + 1) +
                  " 步：" +
                  traceStep.title
                }
                title={
                  String(index + 1).padStart(2, "0") +
                  " · " +
                  traceStep.title
                }
                key={traceStep.id}
              >
                <span>{index + 1}</span>
              </button>
            );
          })}
        </div>

        <div className="timeline__rail-footer">
          <span>INPUT</span>
          <span>点击编号可直接跳转</span>
          <span>OUTPUT</span>
        </div>
      </div>

      <div className="timeline__shortcut">
        <Keyboard size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd>
        </span>
        <small>键盘步进</small>
      </div>
    </footer>
  );
}
