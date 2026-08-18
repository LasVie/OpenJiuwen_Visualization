import type {
  RuntimeToolRegistration,
  RuntimeTraceEvent,
  ToolDefinitionRecord,
  ToolRegistrationSiteRecord,
} from "../../kernel";
import type { LocalToolCatalogResult } from "../../adapters/local-repository";

export type ToolRegistrationState =
  | "runtime-observed"
  | "static-linked"
  | "declared-only";

export interface ProjectedToolDefinition {
  tool: ToolDefinitionRecord;
  state: ToolRegistrationState;
  registrationSites: readonly ToolRegistrationSiteRecord[];
  observations: readonly RuntimeToolRegistration[];
}

export type ToolCatalogSelection =
  | { kind: "tool"; id: string }
  | { kind: "registration"; id: string }
  | { kind: "runtime"; id: string };

export interface ToolCatalogProjection {
  catalog: LocalToolCatalogResult;
  tools: readonly ProjectedToolDefinition[];
  toolsById: ReadonlyMap<string, ProjectedToolDefinition>;
  sitesById: ReadonlyMap<string, ToolRegistrationSiteRecord>;
  observations: readonly RuntimeToolRegistration[];
  unmatchedObservations: readonly RuntimeToolRegistration[];
  counts: Readonly<Record<ToolRegistrationState, number>>;
}

function payloadString(event: RuntimeTraceEvent, ...keys: string[]) {
  for (const key of keys) {
    const value = event.payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function projectRuntimeToolRegistrations(
  events: readonly RuntimeTraceEvent[],
): RuntimeToolRegistration[] {
  const registrations = events
    .filter((event) => event.kind === "ability.register")
    .flatMap((event) => {
      const name = payloadString(event, "toolName", "abilityName", "name");
      if (!name) return [];
      return [{
        id: `${event.traceId}:${event.sequence}:ability-register`,
        name,
        abilityType: payloadString(event, "abilityType", "type") ?? "tool",
        ownerId: payloadString(event, "ownerId") ?? event.subject?.id,
        source: payloadString(event, "source", "provider"),
        sequence: event.sequence,
        timestampMs: event.timestampMs,
      } satisfies RuntimeToolRegistration];
    });
  return registrations.sort((left, right) => left.sequence - right.sequence);
}

const statePriority: Record<ToolRegistrationState, number> = {
  "runtime-observed": 0,
  "static-linked": 1,
  "declared-only": 2,
};

export function projectToolCatalog(
  catalog: LocalToolCatalogResult,
  events: readonly RuntimeTraceEvent[],
): ToolCatalogProjection {
  const sitesById = new Map(catalog.registrationSites.map((site) => [site.id, site]));
  const observations = projectRuntimeToolRegistrations(events);
  const observationsByName = new Map<string, RuntimeToolRegistration[]>();
  observations.forEach((observation) => {
    const key = observation.name.toLocaleLowerCase();
    const values = observationsByName.get(key) ?? [];
    values.push(observation);
    observationsByName.set(key, values);
  });
  const matchedObservationIds = new Set<string>();
  const tools = catalog.tools.map<ProjectedToolDefinition>((tool) => {
    const toolObservations = observationsByName.get(tool.name.toLocaleLowerCase()) ?? [];
    toolObservations.forEach((observation) => matchedObservationIds.add(observation.id));
    const registrationSites = tool.registrationSiteIds
      .map((siteId) => sitesById.get(siteId))
      .filter((site): site is ToolRegistrationSiteRecord => Boolean(site));
    const state: ToolRegistrationState = toolObservations.length
      ? "runtime-observed"
      : registrationSites.length
        ? "static-linked"
        : "declared-only";
    return { tool, state, registrationSites, observations: toolObservations };
  }).sort((left, right) =>
    statePriority[left.state] - statePriority[right.state] ||
    left.tool.name.localeCompare(right.tool.name));
  const counts: Record<ToolRegistrationState, number> = {
    "runtime-observed": 0,
    "static-linked": 0,
    "declared-only": 0,
  };
  tools.forEach((item) => { counts[item.state] += 1; });
  return {
    catalog,
    tools,
    toolsById: new Map(tools.map((item) => [item.tool.id, item])),
    sitesById,
    observations,
    unmatchedObservations: observations.filter((item) => !matchedObservationIds.has(item.id)),
    counts,
  };
}

export function filterProjectedTools(
  projection: ToolCatalogProjection,
  query: string,
  state: ToolRegistrationState | "all",
) {
  const normalized = query.trim().toLocaleLowerCase();
  return projection.tools.filter((item) => {
    if (state !== "all" && item.state !== state) return false;
    if (!normalized) return true;
    const haystack = [
      item.tool.name,
      item.tool.symbol,
      item.tool.summary,
      item.tool.source.path,
      item.tool.card.description,
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(normalized);
  });
}
