import {
  Activity,
  AlertTriangle,
  Binary,
  Box,
  FileSearch,
  FileCode2,
  GitCommitHorizontal,
  Link2,
  RotateCcw,
} from "lucide-react";
import { useMemo } from "react";
import type {
  GraphSourceReference,
  NodeChangeImpact,
  RuntimeTraceEvent,
} from "../../kernel";
import { createDefinitionGraphIndex } from "../repository-browser";
import {
  createChangeDevelopmentNavigation,
  type DevelopmentNavigationSeed,
} from "../development-assistant";
import { RelationExplorer } from "../relation-explorer";
import { SourceViewer } from "../source-viewer";
import type { ChangeImpactProjection } from "./model";

interface ChangeInspectorProps {
  projection: ChangeImpactProjection;
  activeFileId: string;
  selectedNodeId: string | null;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
  onOpenDefinition?: (source: GraphSourceReference) => void;
  onOpenDevelopment?: (navigation: DevelopmentNavigationSeed) => void;
}

const impactLabel: Record<NodeChangeImpact["kind"], string> = {
  direct: "直接命中",
  container: "上层容器",
  dependent: "关系影响",
  file: "文件级",
};

export function ChangeInspector({
  projection,
  activeFileId,
  selectedNodeId,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
  onOpenRuntimeEvent,
  onOpenDefinition,
  onOpenDevelopment,
}: ChangeInspectorProps) {
  const relationIndex = useMemo(
    () => createDefinitionGraphIndex(projection.graph),
    [projection.graph],
  );
  const fileProjection = projection.files.find((item) => item.file.id === activeFileId)
    ?? projection.files[0];
  if (!fileProjection) {
    return (
      <aside className="change-inspector change-inspector--empty">
        <GitCommitHorizontal size={22} />
        <strong>没有变更</strong>
        <p>当前比较范围没有文件差异。</p>
      </aside>
    );
  }
  const file = fileProjection.file;
  const impact = selectedNodeId
    ? [...fileProjection.direct, ...fileProjection.fileLevel, ...fileProjection.containers, ...fileProjection.dependents]
        .find((candidate) => candidate.nodeId === selectedNodeId)
    : undefined;
  const node = impact ? projection.nodesById.get(impact.nodeId) : undefined;
  const source = node?.evidence.find((evidence) => evidence.source)?.source;
  const runtimeSummary = node
    ? projection.runtime.summariesByNode.get(node.id)
    : undefined;

  return (
    <aside className="change-inspector">
      <header className="change-inspector__header">
        <span>{node ? <Box size={17} /> : <FileCode2 size={17} />}</span>
        <div>
          <small>{node ? "NODE IMPACT" : "CHANGED FILE"}</small>
          <strong>{node?.label ?? file.path.split("/").at(-1)}</strong>
        </div>
      </header>

      <div className="change-inspector__scroll">
        <section className="change-inspector__file">
          <div>
            <span className={`change-file-status change-file-status--${file.status}`}>{file.status}</span>
            {file.binary ? <span><Binary size={12} />binary</span> : null}
            {file.staged ? <span>staged</span> : null}
            {file.unstaged ? <span>unstaged</span> : null}
            {file.untracked ? <span>untracked</span> : null}
          </div>
          <code>{file.path}</code>
          {file.previousPath ? <small>from {file.previousPath}</small> : null}
          <footer>
            <span className="change-stat--add">+{file.additions ?? "—"}</span>
            <span className="change-stat--delete">−{file.deletions ?? "—"}</span>
            <span>{file.hunks.length} hunks</span>
          </footer>
        </section>

        {node && impact ? (
          <section className="change-inspector__impact">
            <div className="change-inspector__section-title">
              <Link2 size={13} />影响证据
            </div>
            <div className="change-impact-heading">
              <strong>{impactLabel[impact.kind]}</strong>
              <span className={`change-confidence change-confidence--${impact.confidence}`}>
                {impact.confidence}
              </span>
            </div>
            <p>{impact.reason}</p>
            <dl>
              <div><dt>kind</dt><dd>{node.kind}</dd></div>
              <div><dt>owner</dt><dd>{node.owner}</dd></div>
              <div><dt>plane</dt><dd>{node.plane}</dd></div>
              <div><dt>hunks</dt><dd>{impact.hunkIndexes.length ? impact.hunkIndexes.map((index) => index + 1).join(", ") : "—"}</dd></div>
            </dl>
            <p>{node.summary}</p>
            {source ? (
              <div className="change-source-evidence">
                <code>{source.path}{source.symbol ? `:${source.symbol}` : ""}</code>
                <span>{source.startLine ? `L${source.startLine}${source.endLine ? `–${source.endLine}` : ""}` : "file"}</span>
                <SourceViewer
                  repositoryPath={projection.changes.repository.path}
                  source={source}
                />
                {onOpenDefinition ? (
                  <button
                    type="button"
                    className="change-open-definition"
                    onClick={() => onOpenDefinition?.(source)}
                  >
                    <FileCode2 size={12} />在定义图中定位
                  </button>
                ) : null}
                {onOpenDevelopment ? (
                  <button
                    type="button"
                    className="change-open-development"
                    onClick={() => onOpenDevelopment(createChangeDevelopmentNavigation({
                      node,
                      source,
                      impact,
                      file,
                      comparison: projection.changes.comparison,
                      runtimeSummary,
                    }))}
                  >
                    <FileSearch size={12} />进入开发辅助
                  </button>
                ) : null}
              </div>
            ) : null}
            <RelationExplorer
              index={relationIndex}
              node={node}
              repositoryPath={projection.changes.repository.path}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
              onToggleMagnet={onToggleMagnet}
              onMagnetStrengthChange={onMagnetStrengthChange}
              buttonLabel="沿影响节点深入关系"
            />
          </section>
        ) : (
          <section className="change-inspector__impact-summary">
            <div className="change-inspector__section-title"><Box size={13} />节点映射</div>
            <div>
              <span><b>{fileProjection.direct.length}</b>直接</span>
              <span><b>{fileProjection.containers.length}</b>容器</span>
              <span><b>{fileProjection.dependents.length}</b>关系</span>
              <span><b>{fileProjection.fileLevel.length}</b>文件级</span>
            </div>
          </section>
        )}

        {runtimeSummary ? (
          <section className="change-runtime-evidence">
            <div className="change-inspector__section-title">
              <Activity size={13} />Runtime 实际经过
            </div>
            <div className="change-runtime-evidence__metrics">
              <span><b>{runtimeSummary.spanCount}</b><small>spans</small></span>
              <span><b>{runtimeSummary.eventCount}</b><small>events</small></span>
              <span><b>{runtimeSummary.tokenCount}</b><small>tokens</small></span>
            </div>
            <p>{runtimeSummary.observations.at(-1)?.reason}</p>
            <div className="change-runtime-evidence__events">
              {runtimeSummary.observations.slice(-6).reverse().map((observation) => (
                <button
                  type="button"
                  key={observation.event.eventId}
                  onClick={() => onOpenRuntimeEvent(observation.event)}
                >
                  <code>#{observation.event.sequence}</code>
                  <span>{observation.event.title ?? observation.event.kind}</span>
                  <em>{observation.event.phase}</em>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="change-runtime-return"
              onClick={() => onOpenRuntimeEvent(runtimeSummary.lastEvent)}
            >
              <RotateCcw size={12} />回到最后运行步骤
            </button>
          </section>
        ) : null}

        <section className="change-inspector__hunks">
          <div className="change-inspector__section-title"><GitCommitHorizontal size={13} />行范围</div>
          {file.hunks.length ? file.hunks.map((hunk, index) => (
            <article key={`${hunk.oldStart}:${hunk.newStart}:${index}`}>
              <strong>HUNK {String(index + 1).padStart(2, "0")}</strong>
              <code>− L{hunk.oldStart} · {hunk.oldLines} lines</code>
              <code>+ L{hunk.newStart} · {hunk.newLines} lines</code>
            </article>
          )) : (
            <p>该文件没有文本 hunk；可能是未跟踪、重命名、删除或二进制变更。</p>
          )}
        </section>

        {!projection.headAligned ? (
          <section className="change-alignment-warning">
            <AlertTriangle size={14} />
            <p>比较 head 与当前干净检出不一致，行号命中降级为推断；路径级影响仍保留。</p>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
