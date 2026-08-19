import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Boxes,
  Braces,
  CircleDashed,
  Play,
  Radio,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import type { ToolRegistrationSiteRecord } from "../../kernel";
import type {
  ProjectedToolDefinition,
  RuntimeToolCallEvidence,
  RuntimeToolRegistrationEvidence,
  ToolHostAuthorizationEvidence,
} from "./model";

export type ToolCatalogNodeVariant =
  | "root"
  | "tool"
  | "authorization"
  | "registration-path"
  | "runtime-registration"
  | "runtime-call"
  | "placeholder";

export type ToolCatalogNodeData = {
  variant: ToolCatalogNodeVariant;
  label: string;
  subtitle: string;
  projectedTool?: ProjectedToolDefinition;
  authorization?: ToolHostAuthorizationEvidence;
  registrationPath?: ToolRegistrationSiteRecord;
  runtimeRegistration?: RuntimeToolRegistrationEvidence;
  runtimeCall?: RuntimeToolCallEvidence;
  placeholderStage?: "registered" | "called";
  repositoryOwner?: string;
  counts?: { tools: number; authorized: number; registered: number; called: number };
} & Record<string, unknown>;

export type ToolCatalogFlowNode = Node<ToolCatalogNodeData, "tool-catalog">;

const mechanismLabel: Record<ToolRegistrationSiteRecord["mechanism"], string> = {
  "ability-card": "ABILITY CARD",
  "ability-resource": "ABILITY + RESOURCE",
  "resource-manager": "RESOURCE MANAGER",
  "ownership-helper": "OWNERSHIP HELPER",
};

const stageLabel = {
  discovered: "01 · CODE DISCOVERY",
  authorized: "02 · CATALOG READ",
  registered: "03 · RUNTIME REGISTER",
  called: "04 · TOOL CALL",
} as const;

function NodeIcon({ data }: { data: ToolCatalogNodeData }) {
  if (data.variant === "root") return <Boxes size={15} aria-hidden="true" />;
  if (data.variant === "tool") return <Braces size={15} aria-hidden="true" />;
  if (data.variant === "authorization") return <ShieldCheck size={15} aria-hidden="true" />;
  if (data.variant === "registration-path") return <Waypoints size={15} aria-hidden="true" />;
  if (data.variant === "runtime-registration") return <Radio size={15} aria-hidden="true" />;
  if (data.variant === "runtime-call") return <Play size={15} aria-hidden="true" />;
  return <CircleDashed size={15} aria-hidden="true" />;
}

function kindLabel(data: ToolCatalogNodeData) {
  if (data.variant === "root") return "TOOL EVIDENCE ROOT";
  if (data.variant === "tool") return stageLabel.discovered;
  if (data.variant === "authorization") return stageLabel.authorized;
  if (data.variant === "registration-path") {
    return data.registrationPath
      ? `STATIC · ${mechanismLabel[data.registrationPath.mechanism]}`
      : "STATIC REGISTRATION PATH";
  }
  if (data.variant === "runtime-registration") return stageLabel.registered;
  if (data.variant === "runtime-call") return stageLabel.called;
  return data.placeholderStage === "registered" ? stageLabel.registered : stageLabel.called;
}

function badge(data: ToolCatalogNodeData) {
  if (data.authorization) return data.authorization.state.toUpperCase();
  if (data.registrationPath) return data.registrationPath.confidence.toUpperCase();
  if (data.runtimeRegistration) return data.runtimeRegistration.match.kind.toUpperCase();
  if (data.runtimeCall) return data.runtimeCall.status.toUpperCase();
  if (data.variant === "placeholder") return "NO EVENT";
  return undefined;
}

export function ToolCatalogNode({ data, selected }: NodeProps<ToolCatalogFlowNode>) {
  const marker = badge(data);
  const terminal = data.variant === "runtime-call" || (
    data.variant === "placeholder" && data.placeholderStage === "called"
  );
  return (
    <article
      className={`tool-catalog-node tool-catalog-node--${data.variant} ${
        data.repositoryOwner || data.projectedTool
          ? `tool-catalog-node--${data.repositoryOwner ?? data.projectedTool?.tool.owner}`
          : ""
      } ${selected ? "tool-catalog-node--selected" : ""}`}
    >
      {data.variant !== "root" ? (
        <Handle type="target" position={Position.Left} id="target-left" />
      ) : null}
      <header>
        <span className="tool-catalog-node__icon"><NodeIcon data={data} /></span>
        <span className="tool-catalog-node__kind">{kindLabel(data)}</span>
        {marker ? (
          <em className={`tool-catalog-node__confidence tool-catalog-node__confidence--${
            data.authorization?.state
              ?? data.registrationPath?.confidence
              ?? data.runtimeCall?.status
              ?? data.runtimeRegistration?.match.kind
              ?? "missing"
          }`}>{marker}</em>
        ) : null}
      </header>
      <strong>{data.label}</strong>
      <p>{data.subtitle}</p>
      {data.counts ? (
        <footer>
          <span>{data.counts.tools} found</span>
          <span>{data.counts.registered} registered</span>
          <span>{data.counts.called} called</span>
        </footer>
      ) : data.projectedTool ? (
        <footer>
          <span>{data.projectedTool.tool.kind}</span>
          <span>{data.projectedTool.registrationSites.length} static</span>
          <span>{data.projectedTool.calls.length} calls</span>
        </footer>
      ) : data.authorization ? (
        <footer><span>read only</span><span>{data.authorization.permissionId}</span></footer>
      ) : data.registrationPath ? (
        <footer><span>L{data.registrationPath.source.startLine}</span><span>{data.registrationPath.targetExpression || "dynamic"}</span></footer>
      ) : data.runtimeRegistration ? (
        <footer><span>seq {data.runtimeRegistration.sequence}</span><span>{data.runtimeRegistration.ownerId ?? "trace owner"}</span></footer>
      ) : data.runtimeCall ? (
        <footer><span>seq {data.runtimeCall.startSequence}</span><span>{data.runtimeCall.durationMs ?? "—"} ms</span></footer>
      ) : (
        <footer><span>当前 Trace 无证据</span></footer>
      )}
      {!terminal ? (
        <Handle type="source" position={Position.Right} id="source-right" />
      ) : null}
    </article>
  );
}
