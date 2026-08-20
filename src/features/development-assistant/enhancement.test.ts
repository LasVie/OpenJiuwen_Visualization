import { describe, expect, it } from "vitest";
import type {
  GraphSnapshot,
  RegisteredGraphNode,
  RuntimeTraceEvent,
} from "../../kernel";
import type { LocalRepositoryScanResult } from "../../adapters/local-repository";
import type { SourceExcerptResult } from "../../adapters/source-reader";
import {
  applyDevelopmentEnhancementEvent,
  buildDevelopmentEnhancementPreview,
  developmentEnhancementInvocationRequest,
  developmentEnhancementSourceChoices,
  developmentEnhancementSourceRequest,
  parseDevelopmentEnhancementOutput,
  projectDevelopmentEnhancementExcerpt,
  type DevelopmentEnhancementResult,
} from "./enhancement";
import { buildDevelopmentFlow } from "./DevelopmentCanvas";
import { projectDevelopmentAnalysis } from "./model";
import type { DevelopmentNavigationRequest } from "./navigation";

const revision = "a".repeat(40);
const source = {
  repository: "agent-core",
  revision,
  path: "openjiuwen/core/deep_agent.py",
  symbol: "DeepAgent.run",
  startLine: 30,
  endLine: 180,
};

const graphNode: RegisteredGraphNode = {
  id: "deep-agent",
  kind: "agent",
  plane: "definition",
  level: 3,
  owner: "agent-core",
  label: "DeepAgent",
  summary: "DeepAgent runtime boundary",
  evidence: [{ provenance: "static", confidence: "exact", source }],
  contributedBy: "openjiuwen.local-repository",
};

const graph: GraphSnapshot = {
  schemaVersion: "1.0.0",
  nodes: [graphNode],
  edges: [],
};

const repository = {
  id: "repo:agent-core",
  name: "agent-core",
  owner: "agent-core",
  path: "C:/workspace/agent-core",
  scanScope: "C:/workspace/agent-core",
  revision,
  branch: "develop",
  dirty: false,
};

const scan: LocalRepositoryScanResult = {
  apiVersion: "1.0.0",
  repository,
  graph,
  statistics: {
    pythonFiles: 1,
    symbols: 1,
    nodes: 1,
    edges: 0,
    durationMs: 1,
    truncated: false,
  },
  warnings: [],
};

const navigation: DevelopmentNavigationRequest = {
  id: 7,
  source,
  intent: "检视 DeepAgent.run 的 Rail 与 ReAct 边界",
  origin: {
    plane: "runtime",
    traceId: "tr_runtime_metadata_only",
    sequence: 14,
    eventKind: "agent.react_iteration",
    phase: "end",
    tokenCount: 321,
  },
};

const projection = projectDevelopmentAnalysis(scan, navigation.intent, navigation);

const excerptResult: SourceExcerptResult = {
  apiVersion: "1.0.0",
  repository,
  source: {
    path: source.path,
    language: "python",
    encoding: "utf-8",
    contentSha256: "b".repeat(64),
    requestedRevision: revision,
    currentRevision: revision,
    revisionMatches: true,
    contentBasis: "working-tree",
  },
  range: {
    requestedStartLine: 30,
    requestedEndLine: 93,
    focusStartLine: 30,
    focusEndLine: 93,
    startLine: 30,
    endLine: 31,
    totalLines: 220,
    truncated: true,
    focusTruncated: false,
  },
  lines: [
    { number: 30, text: "class DeepAgent:", focus: true },
    { number: 31, text: "    def run(self): ...", focus: true },
  ],
  readOnly: true,
  writeOperations: false,
};

describe("Development OpenRouter enhancement", () => {
  it("offers only evidence-backed source choices and clamps each read to 64 lines", () => {
    const choices = developmentEnhancementSourceChoices(projection);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ id: "evidence:deep-agent", label: "DeepAgent" });
    expect(developmentEnhancementSourceRequest(choices[0].source)).toMatchObject({
      startLine: 30,
      endLine: 93,
    });
  });

  it("builds the exact, bounded outbound JSON only after selected source text is read", async () => {
    const choice = developmentEnhancementSourceChoices(projection)[0];
    const excerpt = projectDevelopmentEnhancementExcerpt(choice, excerptResult);
    const preview = await buildDevelopmentEnhancementPreview(
      projection,
      "openrouter/free",
      1_024,
      [excerpt],
    );

    expect(preview).toMatchObject({
      providerId: "openrouter",
      destination: "https://openrouter.ai/api/v1/chat/completions",
      modelId: "openrouter/free",
      sourceCount: 1,
      policy: {
        explicitConfirmationRequired: true,
        selectedSourceOnly: true,
        fullContextExcluded: true,
        toolPayloadExcluded: true,
        railPayloadExcluded: true,
        priorModelOutputExcluded: true,
        repositoryWrite: false,
      },
    });
    expect(preview.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.body).toEqual({
      model: "openrouter/free",
      messages: [
        { role: "system", content: preview.systemPrompt },
        { role: "user", content: preview.input },
      ],
      max_tokens: 1_024,
      stream: true,
    });
    expect(developmentEnhancementInvocationRequest(preview)).toEqual({
      modelId: preview.body.model,
      input: preview.body.messages[1].content,
      systemPrompt: preview.body.messages[0].content,
      maxOutputTokens: preview.body.max_tokens,
    });
    expect(preview.input).toContain(navigation.intent);
    expect(preview.input).toContain("tr_runtime_metadata_only");
    expect(preview.input).toContain("class DeepAgent:");
    expect(preview.input).not.toContain("tool-secret-that-is-not-in-projection");
  });

  it("rejects implicit or oversized source selection before any provider call", async () => {
    await expect(buildDevelopmentEnhancementPreview(
      projection,
      "openrouter/free",
      1_024,
      [],
    )).rejects.toThrow(/select between 1 and 3/i);
  });

  it("validates structured model output and preserves unstructured text as raw only", () => {
    const valid = JSON.stringify({
      diagnosis: "Rail 与 ReAct 的边界需要保持事件顺序。",
      changeSuggestions: [{
        title: "收敛 Rail 调用点",
        detail: "在 DeepAgent.run 内保持现有公开入口。",
        target: "DeepAgent.run",
        risk: "medium",
      }],
      testSuggestions: [{
        title: "补充顺序断言",
        detail: "验证 hook 与 iteration 的顺序。",
        kind: "contract",
      }],
      caveats: ["未执行目标仓测试。"],
    });
    expect(parseDevelopmentEnhancementOutput(valid)).toMatchObject({
      diagnosis: "Rail 与 ReAct 的边界需要保持事件顺序。",
      changeSuggestions: [{ risk: "medium" }],
      testSuggestions: [{ kind: "contract" }],
    });
    expect(parseDevelopmentEnhancementOutput("plain unstructured output")).toBeUndefined();
  });

  it("projects stream and usage events into an isolated model branch", () => {
    const initial: DevelopmentEnhancementResult = {
      id: "development-enhancement:openrouter",
      phase: "running",
      providerId: "openrouter",
      modelId: "openrouter/free",
      sourceCount: 1,
      payloadSha256: "c".repeat(64),
      traceId: "tr_model",
      output: "",
    };
    const stream = {
      kind: "model.stream",
      phase: "instant",
      model: { delta: "hello" },
    } as RuntimeTraceEvent;
    const usage = {
      kind: "model.usage",
      phase: "instant",
      model: {
        usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
      },
    } as RuntimeTraceEvent;
    const streamed = applyDevelopmentEnhancementEvent(initial, stream);
    expect(streamed.output).toBe("hello");
    expect(applyDevelopmentEnhancementEvent(streamed, usage).usage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
    });

    const flow = buildDevelopmentFlow(
      projection,
      3,
      new Set(),
      { kind: "model-enhancement", id: initial.id },
      () => undefined,
      initial,
    );
    expect(flow.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selected: true,
        data: expect.objectContaining({
          variant: "model-enhancement",
          entity: initial,
        }),
      }),
    ]));
    expect(flow.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "development-stage:diagnosis",
        target: `development-child:model-enhancement:${initial.id}`,
      }),
    ]));
  });
});
