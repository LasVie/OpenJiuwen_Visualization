import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  Code2,
  GitBranch,
  MessagesSquare,
  Timer,
} from "lucide-react";
import { RuntimeBadge } from "../../shared/ui/RuntimeBadge";
import type { TraceStep } from "../../kernel";
import {
  swarmSubjectStatusAt,
  type SwarmRuntimeProjection,
} from "./model";

interface SwarmRuntimeInspectorProps {
  projection: SwarmRuntimeProjection;
  step: TraceStep;
  stepIndex: number;
  selectedNodeId: string | null;
  open: boolean;
  onToggle: () => void;
}

function payloadEntries(payload: Readonly<Record<string, unknown>> | undefined) {
  if (!payload) return [];
  return Object.entries(payload).flatMap(([key, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [[key, String(value)] as const]
      : []);
}

export function SwarmRuntimeInspector({
  projection,
  step,
  stepIndex,
  selectedNodeId,
  open,
  onToggle,
}: SwarmRuntimeInspectorProps) {
  const event = projection.events[stepIndex];
  const subject = projection.subjects.find((candidate) => candidate.id === selectedNodeId);
  const parent = subject?.parentId
    ? projection.subjects.find((candidate) => candidate.id === subject.parentId)
    : undefined;
  const activity = subject?.revisions.filter((revision) => revision.stepIndex <= stepIndex) ?? [];
  const contextScope = projection.contextScopes.find((scope) =>
    scope.id === subject?.contextOwnerId || scope.id === subject?.id);

  if (!open) {
    return (
      <section className="inspector inspector--collapsed swarm-runtime-inspector">
        <div>
          <span className="section-kicker">{step.phase}</span>
          <strong>{step.title}</strong>
          <code>{step.eventCode}</code>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label="展开 Swarm 步骤详情"
          data-tooltip="展开步骤详情"
        >
          <ChevronUp size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <section className="inspector swarm-runtime-inspector">
      <header className="inspector__header">
        <div>
          <span className="section-kicker">SWARM STEP INSPECTOR</span>
          <h2>{step.title}</h2>
        </div>
        <div className="inspector__event">
          <code>{step.eventCode}</code>
          <span><Timer size={14} aria-hidden="true" />{step.durationMs}ms</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label="收起 Swarm 步骤详情"
          data-tooltip="收起步骤详情"
        >
          <ChevronDown size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="swarm-runtime-inspector__grid">
        <article>
          <span className="inspector__column-title">
            <CircleDot size={14} aria-hidden="true" />当前事件
          </span>
          <p>{step.summary}</p>
          <dl>
            {step.details.map((detail) => (
              <div key={`${detail.label}:${detail.value}`}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
            {payloadEntries(event?.payload).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </article>

        <article>
          <span className="inspector__column-title">
            <GitBranch size={14} aria-hidden="true" />主体层级
          </span>
          {subject ? (
            <>
              <RuntimeBadge owner="jiuwenswarm" />
              <strong>{subject.label}</strong>
              <small>{subject.kind}{subject.role ? ` · ${subject.role}` : ""}</small>
              <dl>
                <div><dt>id</dt><dd>{subject.id}</dd></div>
                <div><dt>status</dt><dd>{swarmSubjectStatusAt(subject, stepIndex)}</dd></div>
                <div><dt>parent</dt><dd>{parent?.label ?? subject.parentId ?? "root"}</dd></div>
                <div><dt>events</dt><dd>{subject.eventCount}</dd></div>
              </dl>
            </>
          ) : (
            <p className="inspector__empty">点击 Team、Workflow、Member、Agent 或 Subagent 节点查看层级。</p>
          )}
        </article>

        <article>
          <span className="inspector__column-title">
            <MessagesSquare size={14} aria-hidden="true" />Context 所有权
          </span>
          {contextScope ? (
            <dl>
              <div><dt>owner</dt><dd>{contextScope.id}</dd></div>
              <div><dt>messages</dt><dd>{contextScope.messageCount}</dd></div>
              <div><dt>tokens</dt><dd>{contextScope.tokenUsed}</dd></div>
              <div><dt>当前面板</dt><dd>{projection.activeContextOwnerId === contextScope.id ? "是" : "否"}</dd></div>
            </dl>
          ) : (
            <p className="inspector__empty">该主体尚未声明或产生独立 Context。</p>
          )}
        </article>

        <article className="swarm-runtime-inspector__activity">
          <span className="inspector__column-title">
            <Code2 size={14} aria-hidden="true" />节点活动与源码证据
          </span>
          {subject ? (
            <>
              <div className="swarm-runtime-activity-list">
                {activity.slice(-5).map((revision) => (
                  <div key={revision.eventId}>
                    <code>{revision.eventKind}</code>
                    <strong>{revision.status}</strong>
                    <span>step {revision.stepIndex + 1}</span>
                  </div>
                ))}
              </div>
              {subject.sourceLocation ? (
                <code className="inspector__source">
                  {subject.sourceLocation} · {subject.sourceConfidence}
                </code>
              ) : (
                <p className="inspector__empty">事件未提供源码证据，且没有安全的静态映射。</p>
              )}
            </>
          ) : (
            <p className="inspector__empty">选择节点后显示最近活动。</p>
          )}
        </article>
      </div>
    </section>
  );
}
