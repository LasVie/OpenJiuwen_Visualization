import { describe, expect, it } from "vitest";
import type { PluginHostSnapshot } from "../../adapters/plugin-host";
import type { LocalToolCatalogResult } from "../../adapters/local-repository";
import type { RuntimeTraceEvent } from "../../kernel";
import {
  projectRuntimeToolCalls,
  projectRuntimeToolRegistrations,
  projectToolCatalog,
} from "./model";

const catalog = {
  apiVersion: "1.0.0",
  schemaVersion: "1.0.0",
  repository: {
    id: "repo:agent-core",
    name: "agent-core",
    owner: "agent-core",
    path: "C:\\agent-core",
    scanScope: "C:\\agent-core",
    revision: "abc",
    branch: "develop",
    dirty: false,
  },
  tools: [
    {
      id: "tool:weather",
      name: "weather_lookup",
      symbol: "WeatherTool",
      kind: "tool-class",
      owner: "agent-core",
      summary: "Weather",
      source: { path: "tools.py", symbol: "WeatherTool", startLine: 1, endLine: 10 },
      card: {
        description: "Weather",
        exposure: "direct",
        stateless: true,
        parallelSafe: true,
        idempotent: true,
        parameters: ["city"],
        nameSource: "literal",
      },
      registrationSiteIds: ["site:one"],
    },
    {
      id: "tool:declared",
      name: "declared_only",
      symbol: "declared_only",
      kind: "decorated-function",
      owner: "agent-core",
      summary: "Declared",
      source: { path: "tools.py", symbol: "declared_only", startLine: 12, endLine: 14 },
      card: {
        description: "Declared",
        exposure: "unknown",
        stateless: null,
        parallelSafe: null,
        idempotent: null,
        parameters: [],
        nameSource: "symbol",
      },
      registrationSiteIds: [],
    },
  ],
  registrationSites: [
    {
      id: "site:one",
      mechanism: "ability-resource",
      callee: "agent.ability_manager.add_ability",
      container: "bind",
      targetExpression: "weather",
      candidateNames: ["weather"],
      resolvedToolIds: ["tool:weather"],
      confidence: "inferred",
      source: { path: "tools.py", symbol: "bind", startLine: 20, endLine: 20 },
    },
  ],
  statistics: {
    pythonFiles: 1,
    tools: 2,
    registrationSites: 1,
    linkedRegistrations: 1,
    dynamicRegistrations: 0,
    durationMs: 1,
    truncated: false,
  },
  warnings: [],
  writeOperations: false,
} satisfies LocalToolCatalogResult;

const hostSnapshot = {
  mode: "local-loopback",
  storage: { engine: "sqlite", journalMode: "wal", schemaVersion: 1 },
  policies: {
    bundledTrust: "automatic",
    unsignedLocal: "developer-mode-path-scoped",
    secretExposure: "opaque-handle-only",
    readPermission: "install-time",
    networkPermission: "revocable",
    writePermission: "per-operation-approval",
    arbitraryPluginCode: "disabled-in-v1",
  },
  developerMode: { enabled: false, authorizedRoots: [], discoveryErrors: [] },
  plugins: [{
    id: "openjiuwen.host.tool-catalog",
    name: "Tool Catalog",
    version: "1.0.0",
    description: "Catalog",
    group: "tool",
    capabilities: ["repository.tools.read"],
    defaultEnabled: true,
    requestedEnabled: true,
    status: "active",
    diagnostic: { code: "READY", message: "Ready" },
    permissions: [{
      id: "repository.tools.read",
      label: "Read tools",
      description: "Read catalog",
      kind: "read",
      grantMode: "install",
      granted: true,
      revocable: true,
      required: true,
    }],
    secretHandles: [],
    trust: { level: "bundled-trusted", automatic: true, executable: true },
    source: { kind: "bundled", identity: "builtin", integrity: "sha256:test" },
    runtime: { mode: "builtin-adapter", processIsolation: "host-builtin-boundary" },
  }],
  audit: { count: 0, lastEventId: 0 },
} satisfies PluginHostSnapshot;

function runtimeEvent(
  value: Partial<RuntimeTraceEvent> & Pick<RuntimeTraceEvent, "eventId" | "kind" | "phase" | "sequence" | "spanId">,
): RuntimeTraceEvent {
  return {
    traceId: "trace:one",
    receivedAt: "2026-08-18T00:00:00Z",
    timestampMs: value.sequence * 10,
    ...value,
  } as RuntimeTraceEvent;
}

const registration = runtimeEvent({
  sequence: 3,
  eventId: "register-weather",
  kind: "ability.register",
  phase: "instant",
  spanId: "registry",
  payload: { tools: ["weather_lookup", "declared_only"], policy: "fixed" },
  details: [{ label: "tool", value: "weather_lookup" }],
  subject: {
    id: "agent.main",
    kind: "agent",
    label: "Main agent",
    contextOwnerId: "ctx:main",
  },
  definition: {
    repository: "agent-core",
    path: "openjiuwen/core/ability/ability_manager.py",
    symbol: "AbilityManager",
  },
});

const callStart = runtimeEvent({
  sequence: 4,
  eventId: "weather-start",
  kind: "tool.call",
  phase: "start",
  spanId: "weather-span",
  payload: { toolName: "weather_lookup" },
  details: [{ label: "arguments", value: "{\"city\":\"Singapore\",\"apiKey\":\"secret-123\"}" }],
  subject: registration.subject,
  definition: {
    repository: "agent-core",
    revision: "abc",
    path: "tools.py",
    symbol: "WeatherTool.invoke",
  },
});

const callEnd = runtimeEvent({
  sequence: 5,
  eventId: "weather-end",
  kind: "tool.call",
  phase: "end",
  spanId: "weather-span",
  durationMs: 18,
  payload: { toolName: "weather_lookup" },
  details: [{ label: "result", value: "{\"temperature\":31}" }],
  subject: registration.subject,
});

describe("Tool catalog evidence projection", () => {
  it("extracts array and detail registration names without duplicates", () => {
    expect(projectRuntimeToolRegistrations([registration]).map((item) => item.name))
      .toEqual(["weather_lookup", "declared_only"]);
  });

  it("pairs tool.call events, retains local raw values and masks previews", () => {
    const [call] = projectRuntimeToolCalls([callEnd, callStart]);

    expect(call).toMatchObject({
      name: "weather_lookup",
      status: "completed",
      startSequence: 4,
      endSequence: 5,
      durationMs: 18,
      ownerId: "agent.main",
    });
    expect(call.rawArguments).toContain("secret-123");
    expect(call.argumentsPreview).not.toContain("secret-123");
    expect(call.rawResult).toContain("temperature");
  });

  it("aligns exact source calls and same-repository unique-name registrations", () => {
    const projection = projectToolCatalog(
      catalog,
      [registration, callStart, callEnd],
      { hostSnapshot, hostConnection: "ready" },
    );

    expect(projection.hostAuthorization).toMatchObject({
      state: "authorized",
      scope: "catalog-read-only",
    });
    expect(projection.toolsById.get("tool:weather")).toMatchObject({ state: "called" });
    expect(projection.toolsById.get("tool:weather")?.registrations[0].match.kind)
      .toBe("name-unique");
    expect(projection.toolsById.get("tool:weather")?.calls[0].match.kind)
      .toBe("source-exact");
    expect(projection.counts).toEqual({
      discovered: 2,
      authorized: 2,
      registered: 2,
      called: 1,
    });

    const callOnly = projectToolCatalog(catalog, [callStart, callEnd]);
    expect(callOnly.toolsById.get("tool:weather")).toMatchObject({
      state: "called",
      registrations: [],
    });
  });

  it("does not merge same names across repositories or revisions", () => {
    const foreign = runtimeEvent({
      sequence: 9,
      eventId: "foreign-register",
      kind: "ability.register",
      phase: "instant",
      spanId: "foreign",
      payload: { toolName: "weather_lookup" },
      definition: { repository: "jiuwenswarm", path: "tools.py", symbol: "WeatherTool" },
    });
    const stale = runtimeEvent({
      sequence: 10,
      eventId: "stale-register",
      kind: "ability.register",
      phase: "instant",
      spanId: "stale",
      payload: { toolName: "weather_lookup" },
      definition: {
        repository: "agent-core",
        revision: "older",
        path: "tools.py",
        symbol: "WeatherTool",
      },
    });

    const projection = projectToolCatalog(catalog, [foreign, stale]);
    expect(projection.unmatchedRegistrations).toHaveLength(2);
    expect(projection.toolsById.get("tool:weather")?.registrations).toHaveLength(0);
  });

  it("keeps identity-less runtime names unmatched instead of guessing across repos", () => {
    const identityLess = runtimeEvent({
      sequence: 11,
      eventId: "identity-less",
      kind: "ability.register",
      phase: "instant",
      spanId: "identity-less",
      payload: { toolName: "weather_lookup" },
    });
    const projection = projectToolCatalog(catalog, [identityLess]);

    expect(projection.unmatchedRegistrations[0].match.kind).toBe("unmatched");
    expect(projection.unmatchedRegistrations[0].match.note).toContain("repository identity");
  });

  it("leaves same-repository duplicate names ambiguous", () => {
    const duplicateCatalog = {
      ...catalog,
      tools: [
        ...catalog.tools,
        {
          ...catalog.tools[0],
          id: "tool:weather-duplicate",
          symbol: "BackupWeatherTool",
          source: {
            path: "backup_tools.py",
            symbol: "BackupWeatherTool",
            startLine: 1,
            endLine: 10,
          },
          registrationSiteIds: [],
        },
      ],
      statistics: { ...catalog.statistics, tools: 3 },
    } satisfies LocalToolCatalogResult;
    const ambiguous = runtimeEvent({
      sequence: 12,
      eventId: "ambiguous-register",
      kind: "ability.register",
      phase: "instant",
      spanId: "ambiguous",
      payload: { toolName: "weather_lookup" },
      definition: {
        repository: "agent-core",
        path: "openjiuwen/core/ability/ability_manager.py",
        symbol: "AbilityManager",
      },
    });

    const projection = projectToolCatalog(duplicateCatalog, [ambiguous]);
    expect(projection.unmatchedRegistrations[0].match.kind).toBe("ambiguous");
    expect(projection.tools.filter((item) => item.registrations.length)).toHaveLength(0);
  });
});
