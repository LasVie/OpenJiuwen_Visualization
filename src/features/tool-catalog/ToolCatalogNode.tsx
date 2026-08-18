import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Boxes,
  Braces,
  CircleDot,
  Radio,
  Waypoints,
} from "lucide-react";
import type {
  RuntimeToolRegistration,
  ToolRegistrationSiteRecord,
} from "../../kernel";
import type { ProjectedToolDefinition } from "./model";

export type ToolCatalogNodeData = {
  variant: "root" | "tool" | "registration" | "runtime";
  label: string;
  subtitle: string;
  projectedTool?: ProjectedToolDefinition;
  registration?: ToolRegistrationSiteRecord;
  runtime?: RuntimeToolRegistration;
  counts?: { tools: number; sites: number; observed: number };
} & Record<string, unknown>;

export type ToolCatalogFlowNode = Node<ToolCatalogNodeData, "tool-catalog">;

const mechanismLabel: Record<ToolRegistrationSiteRecord["mechanism"], string> = {
  "ability-card": "ABILITY CARD",
  "ability-resource": "ABILITY + RESOURCE",
  "resource-manager": "RESOURCE MANAGER",
  "ownership-helper": "OWNERSHIP HELPER",
};

const stateLabel = {
  "runtime-observed": "运行确认",
  "static-linked": "静态路径",
  "declared-only": "仅声明",
} as const;

export function ToolCatalogNode({ data, selected }: NodeProps<ToolCatalogFlowNode>) {
  const state = data.projectedTool?.state;
  return (
    <article
      className={`tool-catalog-node tool-catalog-node--${data.variant} ${
        state ? `tool-catalog-node--${state}` : ""
      } ${data.projectedTool ? `tool-catalog-node--${data.projectedTool.tool.owner}` : ""} ${
        selected ? "tool-catalog-node--selected" : ""
      }`}
    >
      {data.variant !== "root" ? (
        <Handle type="target" position={Position.Left} id="target-left" />
      ) : null}
      <header>
        <span className="tool-catalog-node__icon">
          {data.variant === "root" ? (
            <Boxes size={15} aria-hidden="true" />
          ) : data.variant === "tool" ? (
            <Braces size={15} aria-hidden="true" />
          ) : data.variant === "registration" ? (
            <Waypoints size={15} aria-hidden="true" />
          ) : (
            <Radio size={15} aria-hidden="true" />
          )}
        </span>
        <span className="tool-catalog-node__kind">
          {data.variant === "root"
            ? "TOOL CATALOG"
            : state
              ? stateLabel[state]
              : data.registration
                ? mechanismLabel[data.registration.mechanism]
                : "ABILITY.REGISTER"}
        </span>
        {data.registration ? (
          <em className={`tool-catalog-node__confidence tool-catalog-node__confidence--${data.registration.confidence}`}>
            {data.registration.confidence.toUpperCase()}
          </em>
        ) : data.runtime ? (
          <em className="tool-catalog-node__confidence tool-catalog-node__confidence--runtime">
            OBSERVED
          </em>
        ) : null}
      </header>
      <strong>{data.label}</strong>
      <p>{data.subtitle}</p>
      {data.counts ? (
        <footer>
          <span>{data.counts.tools} tools</span>
          <span>{data.counts.sites} paths</span>
          <span>{data.counts.observed} live</span>
        </footer>
      ) : data.projectedTool ? (
        <footer>
          <span>{data.projectedTool.tool.kind}</span>
          <span>{data.projectedTool.registrationSites.length} paths</span>
          <span>{data.projectedTool.observations.length} live</span>
        </footer>
      ) : data.registration ? (
        <footer>
          <span><CircleDot size={10} />L{data.registration.source.startLine}</span>
          <span>{data.registration.targetExpression || "dynamic"}</span>
        </footer>
      ) : data.runtime ? (
        <footer>
          <span>seq {data.runtime.sequence}</span>
          <span>{data.runtime.ownerId ?? "agent"}</span>
        </footer>
      ) : null}
      {data.variant !== "runtime" ? (
        <Handle type="source" position={Position.Right} id="source-right" />
      ) : null}
    </article>
  );
}
