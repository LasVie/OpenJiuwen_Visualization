import type {
  GraphSourceReference,
  RuntimeSubjectReference,
  RuntimeTraceEvent,
  ToolDefinitionRecord,
  ToolRegistrationSiteRecord,
} from "../../kernel";
import {
  TOOL_CATALOG_HOST_PLUGIN_ID,
  type PluginHostSnapshot,
} from "../../adapters/plugin-host";
import type { LocalToolCatalogResult } from "../../adapters/local-repository";
import { maskSensitiveText } from "../../state/trace-utils";

export type ToolEvidenceStage =
  | "discovered"
  | "authorized"
  | "registered"
  | "called";

/** Kept as the public filter type while the UI migrates from the three-state view. */
export type ToolRegistrationState = ToolEvidenceStage;

export type RuntimeEvidenceMatchKind =
  | "source-exact"
  | "source-unverified"
  | "name-unique"
  | "ambiguous"
  | "unmatched";

export type ToolHostAuthorizationState =
  | "authorized"
  | "blocked"
  | "disabled"
  | "offline"
  | "loading"
  | "unavailable";

export interface ToolStableIdentity {
  key: string;
  repositoryId: string;
  repositoryName: string;
  repositoryOwner: string;
  revision: string;
  path: string;
  symbol: string;
  runtimeName: string;
}

export interface ToolHostAuthorizationEvidence {
  id: string;
  pluginId: string;
  state: ToolHostAuthorizationState;
  scope: "catalog-read-only";
  permissionId: "repository.tools.read";
  permissionGranted: boolean;
  capabilityPresent: boolean;
  diagnosticCode: string;
  diagnosticMessage: string;
}

export interface RuntimeEvidenceMatch {
  kind: RuntimeEvidenceMatchKind;
  definitionId?: string;
  note: string;
}

export interface RuntimeToolRegistrationEvidence {
  id: string;
  name: string;
  abilityType: string;
  ownerId?: string;
  ownerLabel?: string;
  contextOwnerId?: string;
  source?: string;
  traceId: string;
  eventId: string;
  sequence: number;
  timestampMs: number;
  definition?: GraphSourceReference;
  event: RuntimeTraceEvent;
  match: RuntimeEvidenceMatch;
}

export type RuntimeToolCallStatus = "running" | "completed" | "error";

export interface RuntimeToolCallEvidence {
  id: string;
  name: string;
  status: RuntimeToolCallStatus;
  traceId: string;
  spanId: string;
  ownerId?: string;
  ownerLabel?: string;
  contextOwnerId?: string;
  startSequence: number;
  endSequence?: number;
  timestampMs: number;
  durationMs?: number;
  rawArguments?: string;
  rawResult?: string;
  rawError?: string;
  argumentsPreview?: string;
  resultPreview?: string;
  definition?: GraphSourceReference;
  startEvent: RuntimeTraceEvent;
  terminalEvent?: RuntimeTraceEvent;
  match: RuntimeEvidenceMatch;
}

export interface ProjectedToolDefinition {
  tool: ToolDefinitionRecord;
  identity: ToolStableIdentity;
  state: ToolEvidenceStage;
  authorization: ToolHostAuthorizationEvidence;
  registrationSites: readonly ToolRegistrationSiteRecord[];
  registrations: readonly RuntimeToolRegistrationEvidence[];
  calls: readonly RuntimeToolCallEvidence[];
}

export type ToolCatalogSelection =
  | { kind: "tool"; id: string }
  | { kind: "authorization"; id: string }
  | { kind: "registration-path"; id: string }
  | { kind: "runtime-registration"; id: string }
  | { kind: "runtime-call"; id: string };

export interface ToolCatalogProjection {
  catalog: LocalToolCatalogResult;
  hostAuthorization: ToolHostAuthorizationEvidence;
  tools: readonly ProjectedToolDefinition[];
  toolsById: ReadonlyMap<string, ProjectedToolDefinition>;
  sitesById: ReadonlyMap<string, ToolRegistrationSiteRecord>;
  registrations: readonly RuntimeToolRegistrationEvidence[];
  registrationsById: ReadonlyMap<string, RuntimeToolRegistrationEvidence>;
  calls: readonly RuntimeToolCallEvidence[];
  callsById: ReadonlyMap<string, RuntimeToolCallEvidence>;
  unmatchedRegistrations: readonly RuntimeToolRegistrationEvidence[];
  unmatchedCalls: readonly RuntimeToolCallEvidence[];
  counts: Readonly<Record<ToolEvidenceStage, number>>;
}

export interface ToolCatalogProjectionOptions {
  hostSnapshot?: PluginHostSnapshot | null;
  hostConnection?: "loading" | "ready" | "offline";
}

function payloadString(event: RuntimeTraceEvent, ...keys: string[]) {
  for (const key of keys) {
    const value = event.payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function detailValues(event: RuntimeTraceEvent, ...labels: string[]) {
  const expected = new Set(labels.map((label) => label.toLocaleLowerCase()));
  return (event.details ?? [])
    .filter((detail) => expected.has(detail.label.trim().toLocaleLowerCase()))
    .map((detail) => detail.value.trim())
    .filter(Boolean);
}

function stringifyPayloadValue(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function payloadValue(event: RuntimeTraceEvent, ...keys: string[]) {
  for (const key of keys) {
    const value = stringifyPayloadValue(event.payload?.[key]);
    if (value) return value;
  }
  return undefined;
}

const SENSITIVE_FIELD = /^(?:api[_-]?key|token|access[_-]?token|secret|password|authorization|cookie)$/i;

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[凭据已隐藏]" : redactStructuredValue(child),
    ]));
  }
  return typeof value === "string" ? maskSensitiveText(value) : value;
}

function redactedPreviewText(value: string) {
  try {
    return JSON.stringify(redactStructuredValue(JSON.parse(value)));
  } catch {
    return maskSensitiveText(value).replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[凭据已隐藏]",
    );
  }
}

function preview(value: string | undefined, maxLength = 144) {
  if (!value) return undefined;
  const compact = redactedPreviewText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function registrationNames(event: RuntimeTraceEvent) {
  const names: string[] = [];
  const payloadTools = event.payload?.tools;
  if (Array.isArray(payloadTools)) {
    payloadTools.forEach((value) => {
      if (typeof value === "string" && value.trim()) names.push(value.trim());
    });
  }
  const singular = payloadString(event, "toolName", "abilityName", "name");
  if (singular) names.push(singular);
  names.push(...detailValues(event, "tool", "tool name", "ability"));
  return [...new Set(names)];
}

function emptyMatch(): RuntimeEvidenceMatch {
  return { kind: "unmatched", note: "尚未与当前仓库中的 Tool identity 对齐。" };
}

export function projectRuntimeToolRegistrations(
  events: readonly RuntimeTraceEvent[],
): RuntimeToolRegistrationEvidence[] {
  return events
    .filter((event) => event.kind === "ability.register")
    .flatMap((event) => registrationNames(event).map((name, index) => ({
      id: `${event.traceId}:${event.sequence}:ability-register:${index}:${name}`,
      name,
      abilityType: payloadString(event, "abilityType", "type") ?? "tool",
      ownerId: payloadString(event, "ownerId") ?? event.subject?.id,
      ownerLabel: event.subject?.label,
      contextOwnerId: event.subject?.contextOwnerId,
      source: payloadString(event, "source", "provider"),
      traceId: event.traceId,
      eventId: event.eventId,
      sequence: event.sequence,
      timestampMs: event.timestampMs,
      definition: event.definition,
      event,
      match: emptyMatch(),
    })))
    .sort((left, right) => left.sequence - right.sequence);
}

function callName(event: RuntimeTraceEvent) {
  return payloadString(event, "toolName", "abilityName", "name")
    ?? detailValues(event, "tool", "tool name", "ability")[0];
}

function ownerFields(subject: RuntimeSubjectReference | undefined) {
  return {
    ownerId: subject?.id,
    ownerLabel: subject?.label,
    contextOwnerId: subject?.contextOwnerId,
  };
}

export function projectRuntimeToolCalls(
  events: readonly RuntimeTraceEvent[],
): RuntimeToolCallEvidence[] {
  const groups = new Map<string, RuntimeTraceEvent[]>();
  events
    .filter((event) => event.kind === "tool.call")
    .forEach((event) => {
      const name = callName(event);
      if (!name) return;
      const key = `${event.traceId}:${event.spanId}:${name.toLocaleLowerCase()}`;
      const values = groups.get(key) ?? [];
      values.push(event);
      groups.set(key, values);
    });

  return [...groups.entries()].flatMap(([id, values]) => {
    const ordered = [...values].sort((left, right) => left.sequence - right.sequence);
    const start = ordered.find((event) => event.phase === "start") ?? ordered[0];
    const terminal = [...ordered].reverse().find((event) =>
      event.phase === "end" || event.phase === "error");
    const name = callName(start) ?? (terminal ? callName(terminal) : undefined);
    if (!name) return [];
    const rawArguments = payloadValue(start, "arguments", "args", "input")
      ?? detailValues(start, "arguments", "args", "input", "tool arguments")[0];
    const rawResult = terminal
      ? payloadValue(terminal, "result", "output", "observation")
        ?? detailValues(terminal, "result", "output", "observation", "tool result")[0]
      : undefined;
    const rawError = terminal
      ? payloadValue(terminal, "error") ?? detailValues(terminal, "error", "exception")[0]
      : undefined;
    const status: RuntimeToolCallStatus = terminal?.phase === "error" || rawError
      ? "error"
      : terminal
        ? "completed"
        : "running";
    return [{
      id,
      name,
      status,
      traceId: start.traceId,
      spanId: start.spanId,
      ...ownerFields(start.subject ?? terminal?.subject),
      startSequence: start.sequence,
      endSequence: terminal?.sequence,
      timestampMs: start.timestampMs,
      durationMs: terminal?.durationMs ?? (
        terminal ? Math.max(0, terminal.timestampMs - start.timestampMs) : undefined
      ),
      rawArguments,
      rawResult,
      rawError,
      argumentsPreview: preview(rawArguments),
      resultPreview: preview(rawError ?? rawResult),
      definition: start.definition ?? terminal?.definition,
      startEvent: start,
      terminalEvent: terminal,
      match: emptyMatch(),
    } satisfies RuntimeToolCallEvidence];
  }).sort((left, right) => left.startSequence - right.startSequence);
}

function canonical(value: string | undefined) {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
}

function normalizedPath(value: string | undefined) {
  return (value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
}

function repositoryMatches(catalog: LocalToolCatalogResult, repository: string) {
  const candidate = canonical(repository);
  return [
    catalog.repository.id,
    catalog.repository.name,
    catalog.repository.owner,
  ].some((value) => canonical(value) === candidate);
}

function symbolMatches(tool: ToolDefinitionRecord, symbol: string | undefined) {
  if (!symbol) return true;
  const runtimeSymbol = canonical(symbol.split(".")[0]);
  return runtimeSymbol === canonical(tool.symbol);
}

function matchEvidence(
  catalog: LocalToolCatalogResult,
  tools: readonly ToolDefinitionRecord[],
  evidence: { name: string; definition?: GraphSourceReference },
): RuntimeEvidenceMatch {
  const source = evidence.definition;
  if (source?.repository && !repositoryMatches(catalog, source.repository)) {
    return {
      kind: "unmatched",
      note: `运行证据来自 ${source.repository}，不与当前仓库 identity 合并。`,
    };
  }
  if (
    source?.revision
    && catalog.repository.revision
    && source.revision !== catalog.repository.revision
  ) {
    return {
      kind: "unmatched",
      note: "运行证据与当前扫描结果属于不同 revision。",
    };
  }

  if (source?.path) {
    const sourceMatches = tools.filter((tool) =>
      normalizedPath(tool.source.path) === normalizedPath(source.path)
      && symbolMatches(tool, source.symbol));
    if (sourceMatches.length === 1) {
      return {
        kind: source.revision ? "source-exact" : "source-unverified",
        definitionId: sourceMatches[0].id,
        note: source.revision
          ? "repository、revision、path 与 symbol 完整一致。"
          : "repository、path 与 symbol 一致；运行事件未携带 revision。",
      };
    }
    if (sourceMatches.length > 1) {
      return { kind: "ambiguous", note: "同一源码位置对应多个 Tool 声明，未自动合并。" };
    }
  }

  const nameMatches = tools.filter((tool) => canonical(tool.name) === canonical(evidence.name));
  if (nameMatches.length === 1 && source?.repository) {
    return {
      kind: "name-unique",
      definitionId: nameMatches[0].id,
      note: "同仓库内运行名称唯一；源码位置未直接指向 Tool 声明。",
    };
  }
  if (nameMatches.length > 1) {
    return { kind: "ambiguous", note: "同仓库存在多个同名 Tool，未自动合并。" };
  }
  return {
    kind: "unmatched",
    note: source?.repository
      ? "当前仓库中没有可核验的同名 Tool 声明。"
      : "运行证据缺少 repository identity，未按名称跨仓库猜测。",
  };
}

function stableIdentity(catalog: LocalToolCatalogResult, tool: ToolDefinitionRecord): ToolStableIdentity {
  return {
    key: [
      catalog.repository.id,
      catalog.repository.revision,
      normalizedPath(tool.source.path),
      tool.symbol,
      tool.name,
    ].join("::"),
    repositoryId: catalog.repository.id,
    repositoryName: catalog.repository.name,
    repositoryOwner: catalog.repository.owner,
    revision: catalog.repository.revision,
    path: tool.source.path,
    symbol: tool.symbol,
    runtimeName: tool.name,
  };
}

export function projectToolHostAuthorization(
  catalog: LocalToolCatalogResult,
  options: ToolCatalogProjectionOptions = {},
): ToolHostAuthorizationEvidence {
  const id = `${catalog.repository.id}:tool-catalog-authorization`;
  const base = {
    id,
    pluginId: TOOL_CATALOG_HOST_PLUGIN_ID,
    scope: "catalog-read-only" as const,
    permissionId: "repository.tools.read" as const,
  };
  if (options.hostConnection === "offline") {
    return {
      ...base,
      state: "offline",
      permissionGranted: false,
      capabilityPresent: false,
      diagnosticCode: "HOST_OFFLINE",
      diagnosticMessage: "Plugin Host 离线，无法核验目录读取授权。",
    };
  }
  if (!options.hostSnapshot) {
    return {
      ...base,
      state: options.hostConnection === "loading" ? "loading" : "unavailable",
      permissionGranted: false,
      capabilityPresent: false,
      diagnosticCode: options.hostConnection === "loading" ? "HOST_LOADING" : "HOST_UNAVAILABLE",
      diagnosticMessage: options.hostConnection === "loading"
        ? "正在读取 Plugin Host 授权快照。"
        : "没有可用的 Plugin Host 授权快照。",
    };
  }
  const plugin = options.hostSnapshot.plugins.find((item) => item.id === TOOL_CATALOG_HOST_PLUGIN_ID);
  if (!plugin) {
    return {
      ...base,
      state: "unavailable",
      permissionGranted: false,
      capabilityPresent: false,
      diagnosticCode: "PLUGIN_NOT_FOUND",
      diagnosticMessage: "Tool Catalog Host 插件未安装。",
    };
  }
  const permission = plugin.permissions.find((item) => item.id === "repository.tools.read");
  const permissionGranted = permission?.granted === true;
  const capabilityPresent = plugin.capabilities.includes("repository.tools.read");
  const state: ToolHostAuthorizationState = plugin.status === "disabled"
    ? "disabled"
    : plugin.status === "active" && permissionGranted && capabilityPresent
      ? "authorized"
      : "blocked";
  return {
    ...base,
    state,
    permissionGranted,
    capabilityPresent,
    diagnosticCode: plugin.diagnostic.code,
    diagnosticMessage: plugin.diagnostic.message,
  };
}

const statePriority: Record<ToolEvidenceStage, number> = {
  called: 0,
  registered: 1,
  authorized: 2,
  discovered: 3,
};

export function projectToolCatalog(
  catalog: LocalToolCatalogResult,
  events: readonly RuntimeTraceEvent[],
  options: ToolCatalogProjectionOptions = {},
): ToolCatalogProjection {
  const sitesById = new Map(catalog.registrationSites.map((site) => [site.id, site]));
  const hostAuthorization = projectToolHostAuthorization(catalog, options);
  const registrations = projectRuntimeToolRegistrations(events).map((item) => ({
    ...item,
    match: matchEvidence(catalog, catalog.tools, item),
  }));
  const calls = projectRuntimeToolCalls(events).map((item) => ({
    ...item,
    match: matchEvidence(catalog, catalog.tools, item),
  }));
  const registrationsByDefinition = new Map<string, RuntimeToolRegistrationEvidence[]>();
  const callsByDefinition = new Map<string, RuntimeToolCallEvidence[]>();
  registrations.forEach((item) => {
    if (!item.match.definitionId) return;
    const values = registrationsByDefinition.get(item.match.definitionId) ?? [];
    values.push(item);
    registrationsByDefinition.set(item.match.definitionId, values);
  });
  calls.forEach((item) => {
    if (!item.match.definitionId) return;
    const values = callsByDefinition.get(item.match.definitionId) ?? [];
    values.push(item);
    callsByDefinition.set(item.match.definitionId, values);
  });

  const tools = catalog.tools.map<ProjectedToolDefinition>((tool) => {
    const toolRegistrations = registrationsByDefinition.get(tool.id) ?? [];
    const toolCalls = callsByDefinition.get(tool.id) ?? [];
    const registrationSites = tool.registrationSiteIds
      .map((siteId) => sitesById.get(siteId))
      .filter((site): site is ToolRegistrationSiteRecord => Boolean(site));
    const state: ToolEvidenceStage = toolCalls.length
      ? "called"
      : toolRegistrations.length
        ? "registered"
        : hostAuthorization.state === "authorized"
          ? "authorized"
          : "discovered";
    return {
      tool,
      identity: stableIdentity(catalog, tool),
      state,
      authorization: hostAuthorization,
      registrationSites,
      registrations: toolRegistrations,
      calls: toolCalls,
    };
  }).sort((left, right) =>
    statePriority[left.state] - statePriority[right.state]
    || left.tool.name.localeCompare(right.tool.name));

  const counts: Record<ToolEvidenceStage, number> = {
    discovered: tools.length,
    authorized: tools.filter((item) => item.authorization.state === "authorized").length,
    registered: tools.filter((item) => item.registrations.length > 0).length,
    called: tools.filter((item) => item.calls.length > 0).length,
  };
  return {
    catalog,
    hostAuthorization,
    tools,
    toolsById: new Map(tools.map((item) => [item.tool.id, item])),
    sitesById,
    registrations,
    registrationsById: new Map(registrations.map((item) => [item.id, item])),
    calls,
    callsById: new Map(calls.map((item) => [item.id, item])),
    unmatchedRegistrations: registrations.filter((item) => !item.match.definitionId),
    unmatchedCalls: calls.filter((item) => !item.match.definitionId),
    counts,
  };
}

function hasStage(item: ProjectedToolDefinition, stage: ToolEvidenceStage) {
  if (stage === "discovered") return true;
  if (stage === "authorized") return item.authorization.state === "authorized";
  if (stage === "registered") return item.registrations.length > 0;
  return item.calls.length > 0;
}

export function filterProjectedTools(
  projection: ToolCatalogProjection,
  query: string,
  state: ToolEvidenceStage | "all",
) {
  const normalized = query.trim().toLocaleLowerCase();
  return projection.tools.filter((item) => {
    if (state !== "all" && !hasStage(item, state)) return false;
    if (!normalized) return true;
    const haystack = [
      item.tool.name,
      item.tool.symbol,
      item.tool.summary,
      item.tool.source.path,
      item.tool.card.description,
      item.identity.key,
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(normalized);
  });
}
