import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  Code2,
  CornerDownRight,
  FileSearch,
  Timer,
} from "lucide-react";
import type { RuntimeTraceEvent } from "../kernel";
import { RailReviewPanel } from "../features/rail-review";
import { RuntimeBadge } from "../shared/ui/RuntimeBadge";
import type { TraceNodeDefinition, TraceStep } from "../types/trace";

interface InspectorPanelProps {
  graphNodes: readonly TraceNodeDefinition[];
  step: TraceStep;
  selectedNodeId: string | null;
  runInput: string;
  open: boolean;
  onToggle: () => void;
  runtimeEvent?: RuntimeTraceEvent;
  onOpenDefinition: (event: RuntimeTraceEvent) => void;
  onOpenDevelopment: (event: RuntimeTraceEvent) => void;
  sourceNavigationEnabled: boolean;
  developmentNavigationEnabled: boolean;
}

export function InspectorPanel({
  graphNodes,
  step,
  selectedNodeId,
  runInput,
  open,
  onToggle,
  runtimeEvent,
  onOpenDefinition,
  onOpenDevelopment,
  sourceNavigationEnabled,
  developmentNavigationEnabled,
}: InspectorPanelProps) {
  const selectedNode = graphNodes.find((node) => node.id === selectedNodeId);
  const selectedRail = selectedNode?.type === "rail" ? selectedNode : null;
  const hooks = step.hooks;

  if (!open) {
    return (
      <section className="inspector inspector--collapsed">
        <div>
          <span className="section-kicker">{step.phase}</span>
          <strong>{step.title}</strong>
          <code>{step.eventCode}</code>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label="展开步骤详情"
          data-tooltip="展开步骤详情"
        >
          <ChevronUp size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <section className="inspector">
      <header className="inspector__header">
        <div>
          <span className="section-kicker">STEP INSPECTOR</span>
          <h2>{step.title}</h2>
        </div>
        <div className="inspector__event">
          <code>{step.eventCode}</code>
          <span>
            <Timer size={14} strokeWidth={1.8} aria-hidden="true" />
            {step.durationMs}ms
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label="收起步骤详情"
          data-tooltip="收起步骤详情"
        >
          <ChevronDown size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      {selectedRail ? (
        <RailReviewPanel
          definition={selectedRail}
          step={step}
          runInput={runInput}
        />
      ) : (
        <div className="inspector__grid">
        <article className="inspector__summary">
          <span className="inspector__column-title">
            <CircleDot size={14} strokeWidth={1.8} aria-hidden="true" />
            当前事件
          </span>
          <p>{step.summary}</p>
          {step.details.length ? (
            <dl>
              {step.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </article>

        <article className="inspector__hooks">
          <span className="inspector__column-title">
            <CornerDownRight size={14} strokeWidth={1.8} aria-hidden="true" />
            Hook 调用
            {hooks.some((hook) => hook.noop) ? <em>包含 no-op</em> : null}
          </span>
          {hooks.length ? (
            <div className="hook-invocation-list">
              {hooks.map((hook) => (
                <div
                  className={
                    hook.noop
                      ? "hook-invocation hook-invocation--noop"
                      : "hook-invocation"
                  }
                  key={hook.id}
                >
                  <div>
                    <strong>{hook.rail}</strong>
                    <code>{hook.event}</code>
                  </div>
                  <span className="hook-invocation__meta">
                    <b>p{hook.priority}</b>
                    <i>{hook.namespace}</i>
                    <i>{hook.durationMs}ms</i>
                  </span>
                  <p>{hook.mutationDiff}</p>
                  <span className="hook-invocation__signal">
                    signal: {hook.controlSignal}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="inspector__empty">本步骤没有可见 Hook 调用。</p>
          )}
        </article>

        <article className="inspector__node">
          <span className="inspector__column-title">
            <Code2 size={14} strokeWidth={1.8} aria-hidden="true" />
            节点详情
          </span>
          {selectedNode ? (
            <>
              <RuntimeBadge owner={selectedNode.owner} />
              <strong>{selectedNode.label}</strong>
              <small>{selectedNode.subtitle}</small>
              <p>{selectedNode.description}</p>
              <code className="inspector__source">
                {selectedNode.sourceLocation}
              </code>
            </>
          ) : (
            <p className="inspector__empty">
              点击画布中的 Stage 或 Rail 节点查看实现位置。
            </p>
          )}
        </article>
        </div>
      )}
      {runtimeEvent?.definition && (sourceNavigationEnabled || developmentNavigationEnabled) ? (
        <div className="runtime-cross-plane-actions">
          {sourceNavigationEnabled ? (
            <button
              type="button"
              className="runtime-source-link"
              onClick={() => onOpenDefinition(runtimeEvent)}
            >
              <Code2 size={13} />定位源码定义
            </button>
          ) : null}
          {developmentNavigationEnabled ? (
            <button
              type="button"
              className="runtime-development-link"
              onClick={() => onOpenDevelopment(runtimeEvent)}
            >
              <FileSearch size={13} />进入开发辅助
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
