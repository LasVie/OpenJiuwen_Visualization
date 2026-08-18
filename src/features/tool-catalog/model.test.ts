import { describe, expect, it } from "vitest";
import type { RuntimeTraceEvent } from "../../kernel";
import type { LocalToolCatalogResult } from "../../adapters/local-repository";
import { projectRuntimeToolRegistrations, projectToolCatalog } from "./model";

const catalog = {
  apiVersion: "1.0.0",
  schemaVersion: "1.0.0",
  repository: {
    id: "repo",
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
      id: "tool:observed",
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
      resolvedToolIds: ["tool:observed"],
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

const event = {
  traceId: "trace",
  sequence: 3,
  receivedAt: "2026-08-18T00:00:00Z",
  eventId: "register-weather",
  kind: "ability.register",
  phase: "instant",
  timestampMs: 8,
  spanId: "registry",
  payload: { toolName: "weather_lookup", abilityType: "tool", ownerId: "agent.main" },
} satisfies RuntimeTraceEvent;

describe("Tool catalog projection", () => {
  it("extracts only named ability.register observations", () => {
    expect(projectRuntimeToolRegistrations([event])).toEqual([
      expect.objectContaining({ name: "weather_lookup", ownerId: "agent.main", sequence: 3 }),
    ]);
  });

  it("distinguishes runtime confirmation, static paths and declarations", () => {
    const projection = projectToolCatalog(catalog, [event]);

    expect(projection.toolsById.get("tool:observed")?.state).toBe("runtime-observed");
    expect(projection.toolsById.get("tool:declared")?.state).toBe("declared-only");
    expect(projection.counts).toEqual({
      "runtime-observed": 1,
      "static-linked": 0,
      "declared-only": 1,
    });
  });
});
