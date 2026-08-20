import type {
  GraphSourceReference,
  RuntimeTraceEvent,
} from "../../kernel";
import type { SourceExcerptResult } from "../../adapters/source-reader";
import type {
  DevelopmentAnalysisProjection,
  DevelopmentEvidenceTarget,
} from "./model";

export const DEVELOPMENT_ENHANCEMENT_API_VERSION = "1.0.0" as const;
export const MAX_DEVELOPMENT_ENHANCEMENT_SOURCES = 3;
export const MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_LINES = 64;
export const MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_CHARACTERS = 8_000;
export const MAX_DEVELOPMENT_ENHANCEMENT_TOTAL_SOURCE_CHARACTERS = 24_000;

export type DevelopmentEnhancementPhase =
  | "idle"
  | "preparing"
  | "preview"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed";

export interface DevelopmentEnhancementSourceChoice {
  id: string;
  label: string;
  confidence: DevelopmentEvidenceTarget["confidence"];
  source: GraphSourceReference;
}

export interface DevelopmentEnhancementExcerpt {
  id: string;
  label: string;
  source: GraphSourceReference;
  language: string;
  contentSha256: string;
  revisionMatches: boolean | null;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface DevelopmentEnhancementStructuredOutput {
  diagnosis: string;
  changeSuggestions: readonly {
    title: string;
    detail: string;
    target: string;
    risk: "low" | "medium" | "high";
  }[];
  testSuggestions: readonly {
    title: string;
    detail: string;
    kind: "focused" | "contract" | "regression";
  }[];
  caveats: readonly string[];
}

export interface DevelopmentEnhancementUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costMicros?: number;
  currency?: string;
}

export interface DevelopmentEnhancementOutboundPreview {
  apiVersion: typeof DEVELOPMENT_ENHANCEMENT_API_VERSION;
  providerId: "openrouter";
  destination: "https://openrouter.ai/api/v1/chat/completions";
  modelId: string;
  maxOutputTokens: number;
  sourceIds: readonly string[];
  sourceCount: number;
  payloadCharacters: number;
  payloadSha256: string;
  systemPrompt: string;
  input: string;
  body: {
    model: string;
    messages: readonly {
      role: "system" | "user";
      content: string;
    }[];
    max_tokens: number;
    stream: true;
  };
  policy: {
    explicitConfirmationRequired: true;
    selectedSourceOnly: true;
    fullContextExcluded: true;
    toolPayloadExcluded: true;
    railPayloadExcluded: true;
    priorModelOutputExcluded: true;
    repositoryWrite: false;
  };
}

export interface DevelopmentEnhancementResult {
  id: "development-enhancement:openrouter";
  phase: Exclude<DevelopmentEnhancementPhase, "idle" | "preparing" | "preview">;
  providerId: "openrouter";
  modelId: string;
  sourceCount: number;
  payloadSha256: string;
  output: string;
  traceId?: string;
  invocationId?: string;
  usage?: DevelopmentEnhancementUsage;
  structured?: DevelopmentEnhancementStructuredOutput;
  error?: string;
}

function normalizedSourceKey(source: GraphSourceReference) {
  return [
    source.repository.toLocaleLowerCase(),
    source.path.replaceAll("\\", "/").toLocaleLowerCase(),
    source.symbol?.toLocaleLowerCase() ?? "",
    source.startLine ?? "",
    source.endLine ?? "",
  ].join(":");
}

export function developmentEnhancementSourceChoices(
  projection: DevelopmentAnalysisProjection,
): readonly DevelopmentEnhancementSourceChoice[] {
  const seen = new Set<string>();
  const choices: DevelopmentEnhancementSourceChoice[] = [];
  projection.evidence.forEach((target) => {
    const key = normalizedSourceKey(target.source);
    if (seen.has(key)) return;
    seen.add(key);
    choices.push({
      id: target.id,
      label: target.node.label,
      confidence: target.confidence,
      source: target.source,
    });
  });
  return choices;
}

export function developmentEnhancementSourceRequest(
  source: GraphSourceReference,
): GraphSourceReference {
  const startLine = source.startLine ?? 1;
  const requestedEnd = source.endLine ?? startLine + MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_LINES - 1;
  return {
    ...source,
    startLine,
    endLine: Math.min(
      requestedEnd,
      startLine + MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_LINES - 1,
    ),
  };
}

export function projectDevelopmentEnhancementExcerpt(
  choice: DevelopmentEnhancementSourceChoice,
  result: SourceExcerptResult,
): DevelopmentEnhancementExcerpt {
  const numbered = result.lines.map((line) => `${String(line.number).padStart(5, " ")} | ${line.text}`);
  const joined = numbered.join("\n");
  const text = joined.slice(0, MAX_DEVELOPMENT_ENHANCEMENT_SOURCE_CHARACTERS);
  return {
    id: choice.id,
    label: choice.label,
    source: choice.source,
    language: result.source.language,
    contentSha256: result.source.contentSha256,
    revisionMatches: result.source.revisionMatches,
    startLine: result.range.startLine,
    endLine: result.range.endLine,
    text,
    truncated: result.range.focusTruncated || joined.length > text.length,
  };
}

function entrySummary(projection: DevelopmentAnalysisProjection) {
  const origin = projection.entry?.navigation.origin;
  if (!origin) return null;
  if (origin.plane === "runtime") {
    return {
      plane: origin.plane,
      traceId: origin.traceId,
      sequence: origin.sequence,
      eventKind: origin.eventKind,
      phase: origin.phase,
      tokenCount: origin.tokenCount,
      ...(origin.subject ? { subject: origin.subject } : {}),
    };
  }
  if (origin.plane === "definition") {
    return {
      plane: origin.plane,
      nodeId: origin.nodeId,
      nodeLabel: origin.nodeLabel,
      nodeKind: origin.nodeKind,
      ...(origin.runtime ? {
        runtime: {
          traceId: origin.runtime.traceId,
          lastSequence: origin.runtime.lastSequence,
          lastPhase: origin.runtime.lastPhase,
          spanCount: origin.runtime.spanCount,
          eventCount: origin.runtime.eventCount,
          tokenCount: origin.runtime.tokenCount,
        },
      } : {}),
    };
  }
  return {
    plane: origin.plane,
    nodeId: origin.nodeId,
    nodeLabel: origin.nodeLabel,
    nodeKind: origin.nodeKind,
    comparison: origin.comparison,
    file: origin.file,
    impact: {
      kind: origin.impact.kind,
      confidence: origin.impact.confidence,
      hunkIndexes: origin.impact.hunkIndexes.slice(0, 20),
      reason: origin.impact.reason.slice(0, 1_000),
    },
    ...(origin.runtime ? {
      runtime: {
        traceId: origin.runtime.traceId,
        lastSequence: origin.runtime.lastSequence,
        lastPhase: origin.runtime.lastPhase,
        spanCount: origin.runtime.spanCount,
        eventCount: origin.runtime.eventCount,
        tokenCount: origin.runtime.tokenCount,
      },
    } : {}),
  };
}

export function developmentEnhancementStructuredSummary(
  projection: DevelopmentAnalysisProjection,
) {
  return {
    repository: {
      name: projection.repository.name,
      owner: projection.repository.owner,
      branch: projection.repository.branch,
      revision: projection.repository.revision,
      dirty: projection.repository.dirty,
    },
    deterministicAnalysis: {
      diagnosis: projection.diagnosis,
      warnings: projection.warnings.slice(0, 20),
      evidence: projection.evidence.map((item) => ({
        label: item.node.label,
        kind: item.node.kind,
        path: item.source.path,
        symbol: item.source.symbol ?? null,
        confidence: item.confidence,
      })),
      impactCount: projection.impacts.length,
      impacts: projection.impacts.slice(0, 10).map((item) => ({
        label: item.node.label,
        relationship: item.relationship,
        direction: item.direction,
        confidence: item.confidence,
      })),
      changeSuggestions: projection.changes.map((item) => ({
        title: item.title,
        detail: item.detail,
        risk: item.risk,
        target: {
          path: item.target.source.path,
          symbol: item.target.source.symbol ?? null,
        },
        guardrails: item.guardrails,
      })),
      testSuggestions: projection.tests.map((item) => ({
        title: item.title,
        detail: item.detail,
        kind: item.kind,
        evidenceLabel: item.evidenceLabel,
      })),
    },
    entry: entrySummary(projection),
  };
}

const SYSTEM_PROMPT = [
  "你是 OpenJiuwen Visualization 的只读开发分析增强器。",
  "只能依据开发意图、结构化 Runtime/Change 摘要和用户显式选定的源码片段作答。",
  "不得声称已执行代码、测试、Shell、Git 或仓库写入；不得生成可直接应用的补丁。",
  "把静态证据、运行时事实与推断明确区分；证据不足时写入 caveats。",
  "只返回一个 JSON 对象，不要 Markdown fence。结构必须是：",
  '{"diagnosis":"string","changeSuggestions":[{"title":"string","detail":"string","target":"path or symbol","risk":"low|medium|high"}],"testSuggestions":[{"title":"string","detail":"string","kind":"focused|contract|regression"}],"caveats":["string"]}',
].join("\n");

function boundedExcerpts(excerpts: readonly DevelopmentEnhancementExcerpt[]) {
  let remaining = MAX_DEVELOPMENT_ENHANCEMENT_TOTAL_SOURCE_CHARACTERS;
  return excerpts.map((excerpt) => {
    const text = excerpt.text.slice(0, Math.max(0, remaining));
    remaining -= text.length;
    return {
      ...excerpt,
      text,
      truncated: excerpt.truncated || text.length < excerpt.text.length,
    };
  });
}

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildDevelopmentEnhancementPreview(
  projection: DevelopmentAnalysisProjection,
  modelId: string,
  maxOutputTokens: number,
  rawExcerpts: readonly DevelopmentEnhancementExcerpt[],
): Promise<DevelopmentEnhancementOutboundPreview> {
  if (!modelId.trim()) throw new TypeError("OpenRouter model is required.");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 4_096) {
    throw new TypeError("OpenRouter output token limit must be between 16 and 4096.");
  }
  if (
    rawExcerpts.length < 1 ||
    rawExcerpts.length > MAX_DEVELOPMENT_ENHANCEMENT_SOURCES
  ) {
    throw new TypeError(`Select between 1 and ${MAX_DEVELOPMENT_ENHANCEMENT_SOURCES} source excerpts.`);
  }
  if (new Set(rawExcerpts.map((item) => item.id)).size !== rawExcerpts.length) {
    throw new TypeError("Selected source excerpts must be unique.");
  }
  const excerpts = boundedExcerpts(rawExcerpts);
  const sections = excerpts.map((excerpt, index) => [
    `SOURCE ${index + 1}`,
    JSON.stringify({
      id: excerpt.id,
      label: excerpt.label,
      path: excerpt.source.path,
      symbol: excerpt.source.symbol ?? null,
      language: excerpt.language,
      revision: projection.repository.revision,
      revisionMatches: excerpt.revisionMatches,
      contentSha256: excerpt.contentSha256,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      truncated: excerpt.truncated,
    }, null, 2),
    excerpt.text,
  ].join("\n"));
  const input = [
    "DEVELOPMENT INTENT",
    projection.intent,
    "",
    "STRUCTURED RUNTIME / CHANGE SUMMARY",
    JSON.stringify(developmentEnhancementStructuredSummary(projection), null, 2),
    "",
    "EXPLICITLY SELECTED SOURCE EXCERPTS",
    sections.join("\n\n"),
  ].join("\n");
  if (input.length > 64_000) {
    throw new TypeError("OpenRouter enhancement payload exceeds the local 64000-character limit.");
  }
  const body = {
    model: modelId,
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: input },
    ],
    max_tokens: maxOutputTokens,
    stream: true as const,
  };
  const encodedBody = JSON.stringify(body);
  return {
    apiVersion: DEVELOPMENT_ENHANCEMENT_API_VERSION,
    providerId: "openrouter",
    destination: "https://openrouter.ai/api/v1/chat/completions",
    modelId,
    maxOutputTokens,
    sourceIds: excerpts.map((item) => item.id),
    sourceCount: excerpts.length,
    payloadCharacters: encodedBody.length,
    payloadSha256: await sha256(encodedBody),
    systemPrompt: SYSTEM_PROMPT,
    input,
    body,
    policy: {
      explicitConfirmationRequired: true,
      selectedSourceOnly: true,
      fullContextExcluded: true,
      toolPayloadExcluded: true,
      railPayloadExcluded: true,
      priorModelOutputExcluded: true,
      repositoryWrite: false,
    },
  };
}

export function developmentEnhancementInvocationRequest(
  preview: DevelopmentEnhancementOutboundPreview,
) {
  return {
    modelId: preview.modelId,
    input: preview.input,
    systemPrompt: preview.systemPrompt,
    maxOutputTokens: preview.maxOutputTokens,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 4_000) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

export function parseDevelopmentEnhancementOutput(
  output: string,
): DevelopmentEnhancementStructuredOutput | undefined {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(first, last + 1));
  } catch {
    return undefined;
  }
  if (!record(value)) return undefined;
  const diagnosis = boundedString(value.diagnosis);
  const rawChanges = value.changeSuggestions;
  const rawTests = value.testSuggestions;
  const rawCaveats = value.caveats;
  if (
    !diagnosis ||
    !Array.isArray(rawChanges) ||
    !Array.isArray(rawTests) ||
    !Array.isArray(rawCaveats)
  ) return undefined;
  const changeSuggestions = rawChanges.slice(0, 6).map((item) => {
    if (!record(item)) return null;
    const title = boundedString(item.title, 500);
    const detail = boundedString(item.detail);
    const target = boundedString(item.target, 1_000);
    if (!title || !detail || !target || !["low", "medium", "high"].includes(String(item.risk))) return null;
    return { title, detail, target, risk: item.risk as "low" | "medium" | "high" };
  });
  const testSuggestions = rawTests.slice(0, 6).map((item) => {
    if (!record(item)) return null;
    const title = boundedString(item.title, 500);
    const detail = boundedString(item.detail);
    if (!title || !detail || !["focused", "contract", "regression"].includes(String(item.kind))) return null;
    return {
      title,
      detail,
      kind: item.kind as "focused" | "contract" | "regression",
    };
  });
  const caveats = rawCaveats.slice(0, 10).map((item) => boundedString(item, 1_000));
  if (
    changeSuggestions.some((item) => item === null) ||
    testSuggestions.some((item) => item === null) ||
    caveats.some((item) => item === null)
  ) return undefined;
  return {
    diagnosis,
    changeSuggestions: changeSuggestions as DevelopmentEnhancementStructuredOutput["changeSuggestions"],
    testSuggestions: testSuggestions as DevelopmentEnhancementStructuredOutput["testSuggestions"],
    caveats: caveats as readonly string[],
  };
}

export function applyDevelopmentEnhancementEvent(
  result: DevelopmentEnhancementResult,
  event: RuntimeTraceEvent,
): DevelopmentEnhancementResult {
  if (event.kind === "model.stream" && event.model?.delta) {
    return { ...result, phase: "running", output: result.output + event.model.delta };
  }
  if (event.kind === "model.usage" && event.model?.usage) {
    return { ...result, usage: event.model.usage };
  }
  if (event.kind === "trace.status" && event.phase === "error") {
    return {
      ...result,
      phase: "failed",
      error: event.summary || "OpenRouter enhancement trace failed.",
      structured: parseDevelopmentEnhancementOutput(result.output),
    };
  }
  return result;
}

export function developmentEnhancementSummary(result: DevelopmentEnhancementResult) {
  if (result.phase === "starting") return "正在创建独立 Runtime Trace";
  if (result.phase === "running") return result.output.trim().slice(0, 160) || "OpenRouter 正在流式返回建议";
  if (result.phase === "cancelling") return "正在停止 OpenRouter 流";
  if (result.phase === "failed") return result.error ?? "OpenRouter 只读增强失败";
  return result.structured?.diagnosis ?? (
    result.output.trim().slice(0, 180) || "OpenRouter 只读增强已完成"
  );
}
