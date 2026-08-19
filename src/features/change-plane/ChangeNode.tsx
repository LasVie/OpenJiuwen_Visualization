import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  FileCode2,
  GitCompareArrows,
  Link2,
} from "lucide-react";
import type {
  GitChangedFile,
  NodeChangeImpact,
  RegisteredGraphNode,
} from "../../kernel";
import type { DefinitionRuntimeSummary } from "../source-convergence";

export type ChangeNodeData = {
  variant: "root" | "file" | "impact";
  label: string;
  subtitle: string;
  file?: GitChangedFile;
  impact?: NodeChangeImpact;
  graphNode?: RegisteredGraphNode;
  additions?: number;
  deletions?: number;
  fileCount?: number;
  runtimeSummary?: DefinitionRuntimeSummary;
  runtimeObservedCount?: number;
} & Record<string, unknown>;

export type ChangeFlowNode = Node<ChangeNodeData, "change">;

const statusLabel: Record<GitChangedFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  conflicted: "冲突",
  untracked: "未跟踪",
};

const impactLabel: Record<NodeChangeImpact["kind"], string> = {
  direct: "直接命中",
  container: "上层容器",
  dependent: "关系影响",
  file: "文件级",
};

export function ChangeNode({ data, selected }: NodeProps<ChangeFlowNode>) {
  return (
    <article
      className={`change-node change-node--${data.variant} ${
        data.impact ? `change-node--${data.impact.kind}` : ""
      } ${selected ? "change-node--selected" : ""}`}
      data-runtime-observed={Boolean(data.runtimeSummary || data.runtimeObservedCount)}
    >
      {data.variant !== "root" ? (
        <Handle type="target" position={Position.Left} id="target-left" />
      ) : null}
      <header>
        <span className="change-node__icon">
          {data.variant === "root" ? (
            <GitCompareArrows size={15} aria-hidden="true" />
          ) : data.variant === "file" ? (
            <FileCode2 size={15} aria-hidden="true" />
          ) : data.impact?.kind === "dependent" ? (
            <Link2 size={15} aria-hidden="true" />
          ) : (
            <Box size={15} aria-hidden="true" />
          )}
        </span>
        <span className="change-node__kind">
          {data.variant === "root"
            ? "CHANGE SET"
            : data.file
              ? statusLabel[data.file.status]
              : data.impact
                ? impactLabel[data.impact.kind]
                : "IMPACT"}
        </span>
        {data.impact ? (
          <em className={`change-node__confidence change-node__confidence--${data.impact.confidence}`}>
            {data.impact.confidence === "exact" ? "EXACT" : "INFERRED"}
          </em>
        ) : null}
        {data.runtimeSummary ? (
          <em className="change-node__runtime">RUN ×{data.runtimeSummary.spanCount}</em>
        ) : null}
      </header>
      <strong>{data.label}</strong>
      <p>{data.subtitle}</p>
      {data.variant === "root" ? (
        <footer>
          <span>{data.fileCount ?? 0} files</span>
          <span className="change-stat--add">+{data.additions ?? 0}</span>
          <span className="change-stat--delete">−{data.deletions ?? 0}</span>
          <span>run {data.runtimeObservedCount ?? 0}</span>
        </footer>
      ) : data.file ? (
        <footer>
          <span>{data.file.hunks.length} hunks</span>
          <span className="change-stat--add">+{data.file.additions ?? "—"}</span>
          <span className="change-stat--delete">−{data.file.deletions ?? "—"}</span>
          <span>run {data.runtimeObservedCount ?? 0}</span>
        </footer>
      ) : data.graphNode ? (
        <footer>
          <span>{data.graphNode.kind}</span>
          <span>{data.impact?.hunkIndexes.length ?? 0} hunk refs</span>
          {data.runtimeSummary ? <span>{data.runtimeSummary.eventCount} events</span> : null}
        </footer>
      ) : null}
      <Handle type="source" position={Position.Right} id="source-right" />
    </article>
  );
}
