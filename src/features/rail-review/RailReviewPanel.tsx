import {
  ArrowRight,
  Check,
  CircleDashed,
  Eye,
  GitCompareArrows,
  OctagonAlert,
} from "lucide-react";
import type { RailNodeDefinition, TraceStep } from "../../types/trace";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import {
  buildRailReviewSnapshot,
  type RailReviewStatus,
} from "./model";

interface RailReviewPanelProps {
  definition: RailNodeDefinition;
  step: TraceStep;
  runInput: string;
}

const statusLabels: Record<RailReviewStatus, string> = {
  waiting: "WAIT",
  reviewing: "CHECKING",
  passed: "PASS",
  changed: "CHANGED",
  blocked: "BLOCKED",
  skipped: "SKIPPED",
};

function StatusIcon({ status }: { status: RailReviewStatus }) {
  if (status === "blocked") return <OctagonAlert size={14} strokeWidth={2} />;
  if (status === "changed") return <GitCompareArrows size={14} strokeWidth={2} />;
  if (status === "passed") return <Check size={14} strokeWidth={2.2} />;
  return <CircleDashed size={14} strokeWidth={1.8} />;
}

export function RailReviewPanel({
  definition,
  step,
  runInput,
}: RailReviewPanelProps) {
  const snapshot = buildRailReviewSnapshot(definition, step, runInput);

  return (
    <section className="rail-review" aria-label={`${definition.label} 审查过程`}>
      <header className="rail-review__header">
        <div>
          <span className="inspector__column-title">
            <Eye size={15} strokeWidth={1.8} aria-hidden="true" />
            Rail 审查过程
          </span>
          <strong>{definition.label}</strong>
          <code>{snapshot.profile.targetPath}</code>
        </div>
        <div className="rail-review__header-meta">
          <RuntimeBadge owner={definition.owner} />
          <span className={`rail-review-status rail-review-status--${snapshot.status}`}>
            {statusLabels[snapshot.status]}
          </span>
        </div>
      </header>

      <p className="rail-review__description">{snapshot.profile.examines}</p>

      <div className="rail-review__pipeline">
        <article className="rail-review__payload">
          <span>01 · READ</span>
          <strong>{snapshot.profile.targetLabel}</strong>
          <pre>{snapshot.payload}</pre>
        </article>
        <ArrowRight className="rail-review__arrow" size={18} aria-hidden="true" />
        <div className="rail-review__checks">
          {snapshot.checks.map((check, index) => (
            <article
              className={`rail-review-check rail-review-check--${check.status}`}
              key={check.id}
            >
              <span className="rail-review-check__index">0{index + 2}</span>
              <span className="rail-review-check__icon" aria-hidden="true">
                <StatusIcon status={check.status} />
              </span>
              <span>
                <strong>{check.label}</strong>
                <small>{check.description}</small>
              </span>
            </article>
          ))}
        </div>
        <ArrowRight className="rail-review__arrow" size={18} aria-hidden="true" />
        <article className={`rail-review__outcome rail-review__outcome--${snapshot.status}`}>
          <span>05 · EMIT</span>
          <strong>{statusLabels[snapshot.status]}</strong>
          <p>{snapshot.outcome}</p>
        </article>
      </div>

      <footer className="rail-review__source">
        <span>实现位置</span>
        <code>{definition.sourceLocation}</code>
      </footer>
    </section>
  );
}
