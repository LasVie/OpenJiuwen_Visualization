import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  GitBranch,
  History,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  DEFAULT_LOCAL_REPOSITORY_SERVER,
  LocalRepositoryClient,
  LocalRepositoryClientError,
  type LocalRepositoryCatalog,
  type LocalRepositoryIdentity,
} from "../../adapters/local-repository";
import type {
  GraphSourceReference,
  RegisteredDevelopmentAssistantSource,
} from "../../kernel";
import { MagnetControls } from "../trace-graph";
import { repositoryMatchesSource } from "../source-convergence";
import {
  DevelopmentExecutionPanel,
  useDevelopmentExecution,
} from "../development-execution";
import { DevelopmentCanvas } from "./DevelopmentCanvas";
import { DevelopmentEnhancementPanel } from "./DevelopmentEnhancementPanel";
import { DevelopmentInspector } from "./DevelopmentInspector";
import { DevelopmentSessionPanel } from "./DevelopmentSessionPanel";
import { DevelopmentTimeline } from "./DevelopmentTimeline";
import {
  projectDevelopmentAnalysis,
  type DevelopmentAnalysisProjection,
  type DevelopmentSelection,
  type DevelopmentStageKind,
} from "./model";
import type { DevelopmentNavigationRequest } from "./navigation";
import { useDevelopmentEnhancement } from "./use-development-enhancement";
import { useDevelopmentSessions } from "./use-development-sessions";

type ConnectionState =
  | { status: "connecting" }
  | { status: "offline"; message: string }
  | { status: "ready"; catalog: LocalRepositoryCatalog };

const EXPANDABLE_STAGES = new Set<DevelopmentStageKind>([
  "evidence", "impact", "change-plan", "test-plan", "patch-outline",
]);

function errorMessage(error: unknown) {
  if (error instanceof LocalRepositoryClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "只读开发分析失败。";
}

function preferredRepository(catalog: LocalRepositoryCatalog) {
  return catalog.repositories.find((repository) => repository.owner === "agent-core")
    ?? catalog.repositories[0];
}

function sampleIntent(repository?: LocalRepositoryIdentity) {
  return repository?.owner === "jiuwenswarm"
    ? "梳理 Agent Team 成员消息与 Context 隔离边界，给出保持现有事件合同的修改和测试方案"
    : "梳理 DeepAgent 的 Rail 审查与 ReAct 循环边界，给出不改变公开 API 的修改和测试方案";
}

function ownerLabel(owner: string) {
  if (owner === "agent-core") return "CORE";
  if (owner === "jiuwenswarm") return "SWARM";
  return "LOCAL";
}

function navigationTitle(navigation: DevelopmentNavigationRequest) {
  const origin = navigation.origin;
  if (origin.plane === "runtime") {
    return `Runtime step #${origin.sequence} · ${origin.eventKind}`;
  }
  if (origin.plane === "definition") {
    return `${origin.nodeLabel} · ${origin.nodeKind}`;
  }
  return `${origin.nodeLabel} · ${origin.file.status} / ${origin.impact.kind}`;
}

function navigationMeta(navigation: DevelopmentNavigationRequest) {
  const origin = navigation.origin;
  if (origin.plane === "runtime") {
    return `${origin.phase} · ${origin.tokenCount} observed tokens`;
  }
  if (origin.plane === "definition") {
    return origin.runtime
      ? `${origin.runtime.eventCount} runtime events · ${origin.runtime.tokenCount} tokens`
      : "static definition evidence";
  }
  return `${origin.comparison.mode} · ${origin.comparison.base} → ${origin.comparison.head} · ${origin.impact.confidence}`;
}

interface DevelopmentAssistantWorkspaceProps {
  sources: readonly RegisteredDevelopmentAssistantSource[];
  navigation: DevelopmentNavigationRequest | null;
  onOpenDefinition?: (source: GraphSourceReference) => void;
  openRouterEnabled: boolean;
  controlledExecutionEnabled: boolean;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function DevelopmentAssistantWorkspace({
  sources,
  navigation,
  onOpenDefinition,
  openRouterEnabled,
  controlledExecutionEnabled,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: DevelopmentAssistantWorkspaceProps) {
  const client = useMemo(() => new LocalRepositoryClient(), []);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const handledNavigationId = useRef(0);
  const developmentSessions = useDevelopmentSessions();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });
  const [repositoryPath, setRepositoryPath] = useState("");
  const [intent, setIntent] = useState(sampleIntent());
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [analysisError, setAnalysisError] = useState("");
  const [projection, setProjection] = useState<DevelopmentAnalysisProjection | null>(null);
  const [activeNavigation, setActiveNavigation] = useState<DevelopmentNavigationRequest | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<DevelopmentStageKind>>(new Set());
  const [selection, setSelection] = useState<DevelopmentSelection | null>(null);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [enhancementPanelOpen, setEnhancementPanelOpen] = useState(false);
  const [executionPanelOpen, setExecutionPanelOpen] = useState(false);
  const developmentEnhancement = useDevelopmentEnhancement({
    projection,
    enabled: openRouterEnabled,
  });
  const developmentExecution = useDevelopmentExecution({
    projection,
    enabled: controlledExecutionEnabled,
  });

  useEffect(() => {
    const result = developmentEnhancement.result;
    if (!result?.traceId) return;
    setSelection({ kind: "model-enhancement", id: result.id });
  }, [developmentEnhancement.result?.traceId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setConnection({ status: "connecting" });
    void Promise.all([
      client.health(controller.signal),
      client.listRepositories(controller.signal),
    ]).then(([, catalog]) => {
      if (!active) return;
      setConnection({ status: "ready", catalog });
      const preferred = preferredRepository(catalog);
      setRepositoryPath((current) => current || preferred?.path || "");
      setIntent((current) => current || sampleIntent(preferred));
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      setConnection({ status: "offline", message: errorMessage(error) });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, connectionRevision]);

  const selectedRepository = connection.status === "ready"
    ? connection.catalog.repositories.find((repository) => repository.path === repositoryPath)
    : undefined;

  const runAnalysis = useCallback(async (
    path: string,
    nextIntent: string,
    entry?: DevelopmentNavigationRequest,
  ) => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setStatus("loading");
    setAnalysisError("");
    setProjection(null);
    setSelection(null);
    setEnhancementPanelOpen(false);
    setExecutionPanelOpen(false);
    developmentSessions.clearActiveSession();
    try {
      const scan = await client.scan(path, {
        includeTests: true,
        includeFunctions: true,
        maxFiles: 5_000,
        maxEdges: 20_000,
      }, controller.signal);
      if (controller.signal.aborted) return;
      const next = projectDevelopmentAnalysis(scan, nextIntent, entry);
      setProjection(next);
      setActiveIndex(0);
      setExpanded(new Set());
      setSelection({ kind: "stage", id: next.stages[0].id });
      setStatus("ready");
      void developmentSessions.save(next);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setAnalysisError(errorMessage(error));
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null;
    }
  }, [client, developmentSessions.clearActiveSession, developmentSessions.save]);

  useEffect(() => {
    if (!navigation || connection.status !== "ready") return;
    if (handledNavigationId.current === navigation.id) return;
    handledNavigationId.current = navigation.id;
    const repository = connection.catalog.repositories.find((candidate) =>
      repositoryMatchesSource(candidate, navigation.source));
    setActiveNavigation(navigation);
    setIntent(navigation.intent);
    setActiveIndex(0);
    setExpanded(new Set());
    setSelection(null);
    setEnhancementPanelOpen(false);
    setExecutionPanelOpen(false);
    if (!repository) {
      analysisAbortRef.current?.abort();
      setProjection(null);
      setStatus("error");
      setAnalysisError(`跨平面入口指向 ${navigation.source.repository}，当前目录授权中没有对应仓库。`);
      return;
    }
    setRepositoryPath(repository.path);
    void runAnalysis(repository.path, navigation.intent, navigation);
  }, [connection, navigation, runAnalysis]);

  function selectRepository(repository: LocalRepositoryIdentity) {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setRepositoryPath(repository.path);
    setIntent(sampleIntent(repository));
    setProjection(null);
    setActiveNavigation(null);
    setStatus("idle");
    setAnalysisError("");
    setActiveIndex(0);
    setExpanded(new Set());
    setSelection(null);
    setEnhancementPanelOpen(false);
    setExecutionPanelOpen(false);
    developmentSessions.clearActiveSession();
  }

  async function restoreSession(sessionId: string) {
    const restored = await developmentSessions.restore(sessionId);
    if (!restored) return;
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setRepositoryPath(restored.repository.path);
    setIntent(restored.intent);
    setProjection(restored);
    setActiveNavigation(restored.entry?.navigation ?? null);
    setStatus("ready");
    setAnalysisError("");
    setActiveIndex(0);
    setExpanded(new Set());
    setSelection({ kind: "stage", id: restored.stages[0].id });
    setSessionPanelOpen(false);
    setEnhancementPanelOpen(false);
    setExecutionPanelOpen(false);
  }

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connection.status !== "ready" || !repositoryPath || !intent.trim()) return;
    void runAnalysis(repositoryPath, intent, activeNavigation ?? undefined);
  }

  useEffect(() => () => analysisAbortRef.current?.abort(), []);

  const toggleStage = useCallback((kind: DevelopmentStageKind) => {
    if (!EXPANDABLE_STAGES.has(kind)) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const changeStep = useCallback((index: number) => {
    if (!projection) return;
    const next = Math.max(0, Math.min(index, projection.stages.length - 1));
    const stage = projection.stages[next];
    setActiveIndex(next);
    setSelection({ kind: "stage", id: stage.id });
    if (EXPANDABLE_STAGES.has(stage.kind)) {
      setExpanded(new Set([stage.kind]));
    } else {
      setExpanded(new Set());
    }
  }, [projection]);

  useEffect(() => {
    if (!projection) return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button") || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        changeStep(activeIndex - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        changeStep(activeIndex + 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, changeStep, projection]);

  const allExpanded = [...EXPANDABLE_STAGES].every((kind) => expanded.has(kind));
  const source = sources[0];

  return (
    <section className="development-workspace">
      <aside className="development-sidebar">
        <header className="development-sidebar__header">
          <span><FileSearch size={18} /></span>
          <div><strong>Development Evidence</strong><small>确定性只读分析</small></div>
          <em className={`development-service-state development-service-state--${connection.status}`} title={DEFAULT_LOCAL_REPOSITORY_SERVER}>
            {connection.status === "connecting" ? <LoaderCircle size={12} className="spin" /> : connection.status === "ready" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            {connection.status === "connecting" ? "连接中" : connection.status === "ready" ? "只读在线" : "未连接"}
          </em>
        </header>

        <div className="development-sidebar__scroll">
          {connection.status === "offline" ? (
            <section className="development-service-empty">
              <Server size={24} />
              <strong>启动本地只读服务</strong>
              <p>{connection.message}</p>
              <button type="button" onClick={() => setConnectionRevision((value) => value + 1)}><RefreshCw size={13} />重新连接</button>
            </section>
          ) : null}

          {connection.status === "ready" ? (
            <>
              <button
                type="button"
                className={`development-session-entry development-session-entry--${developmentSessions.connection}`}
                onClick={() => setSessionPanelOpen(true)}
              >
                <span><History size={16} strokeWidth={1.8} aria-hidden="true" /></span>
                <span>
                  <strong>分析 Sessions</strong>
                  <small>{developmentSessions.connection === "loading"
                    ? "正在读取本机索引"
                    : developmentSessions.connection === "offline"
                      ? "本机持久化未连接"
                      : `${developmentSessions.total} 条 · SQLite / WAL`}</small>
                </span>
                <em>{developmentSessions.saving ? <LoaderCircle size={12} className="spin" /> : developmentSessions.total}</em>
              </button>
              {activeNavigation ? (
                <section className={`development-entry-card development-entry-card--${activeNavigation.origin.plane}`}>
                  <header>
                    <Route size={13} />
                    <span>FROM {activeNavigation.origin.plane.toUpperCase()}</span>
                    <em>{projection?.entry?.status ?? (status === "loading" ? "matching" : "pending")}</em>
                  </header>
                  <strong>{navigationTitle(activeNavigation)}</strong>
                  <code>{activeNavigation.source.path}{activeNavigation.source.symbol ? `:${activeNavigation.source.symbol}` : ""}</code>
                  <small>{navigationMeta(activeNavigation)}</small>
                </section>
              ) : null}
              <section className="development-sidebar__section">
                <div className="development-section-title"><span>REPOSITORY SCOPE</span><em>{connection.catalog.repositories.length}</em></div>
                <div className="development-repositories">
                  {connection.catalog.repositories.map((repository) => (
                    <button
                      type="button"
                      key={repository.id}
                      className={repository.path === repositoryPath ? `development-repository development-repository--active development-repository--${repository.owner}` : `development-repository development-repository--${repository.owner}`}
                      onClick={() => selectRepository(repository)}
                    >
                      <span>{ownerLabel(repository.owner)}</span>
                      <strong>{repository.name}</strong>
                      <small><GitBranch size={10} />{repository.branch}</small>
                      {repository.dirty ? <em>DIRTY</em> : <CheckCircle2 size={13} />}
                    </button>
                  ))}
                </div>
                {selectedRepository ? <code className="development-repository-path">{selectedRepository.path}</code> : null}
              </section>

              <form className="development-intent-form" onSubmit={analyze}>
                <label htmlFor="development-intent">开发意图</label>
                <textarea
                  id="development-intent"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="描述希望理解或调整的行为，并尽量包含类、函数、Rail、Tool 或 Workflow 名称。"
                  spellCheck={false}
                />
                <div className="development-intent-hint">
                  <ShieldCheck size={12} />
                  <span>基础分析只读取当前工作树并保存到本机；模型外发与隔离写入均由独立模块逐次审批。</span>
                </div>
                <button type="submit" disabled={status === "loading" || !repositoryPath || !intent.trim()}>
                  {status === "loading" ? <LoaderCircle size={15} className="spin" /> : <FileSearch size={15} />}
                  {status === "loading" ? "正在检视代码…" : "生成分析链路"}
                </button>
                {status === "error" ? <p className="development-form-error"><AlertTriangle size={13} />{analysisError}</p> : null}
              </form>

              <section className="development-contract-card">
                <header><Layers3 size={14} /><span>分析合同</span></header>
                <dl>
                  <div><dt>ENGINE</dt><dd>{source?.engine ?? "deterministic-static"}</dd></div>
                  <div><dt>MODEL</dt><dd>{!openRouterEnabled ? "module off" : developmentEnhancement.provider?.status === "ready" ? "optional" : "base off"}</dd></div>
                  <div><dt>REPO WRITE</dt><dd>{controlledExecutionEnabled ? "per action" : "false"}</dd></div>
                  <div><dt>SESSION</dt><dd>{developmentSessions.connection === "ready" ? "local / wal" : "offline"}</dd></div>
                </dl>
              </section>

              {projection?.warnings.length ? (
                <section className="development-warning-list">
                  <h3>证据边界</h3>
                  {projection.warnings.map((warning) => <p key={warning}><AlertTriangle size={11} />{warning}</p>)}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>

      <main className="development-stage">
        {projection ? (
          <>
            <header className="development-toolbar">
              <span className={`development-toolbar__owner development-toolbar__owner--${projection.repository.owner}`}>{ownerLabel(projection.repository.owner)}</span>
              <span className="development-toolbar__identity">
                <strong>{projection.repository.name}</strong>
                <small>{projection.repository.branch} · {projection.repository.revision.slice(0, 12)} · {projection.repository.dirty ? "working tree dirty" : "clean HEAD"}</small>
              </span>
              <span className="development-toolbar__metrics">
                <b>{projection.evidence.length}</b> evidence
                <b>{projection.impacts.length}</b> impacts
              </span>
              {controlledExecutionEnabled ? (
                <button
                  type="button"
                  className={`development-execution-entry development-execution-entry--${developmentExecution.phase}`}
                  onClick={() => setExecutionPanelOpen(true)}
                  title={developmentExecution.error ?? "完整 Diff 预览后，逐次审批隔离应用、固定测试、本地 commit 或回滚"}
                >
                  {developmentExecution.busy
                    ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                    : <GitBranch size={13} aria-hidden="true" />}
                  {developmentExecution.busy
                    ? "受控执行中"
                    : developmentExecution.execution
                      ? "执行链路"
                      : "受控执行"}
                </button>
              ) : null}
              {openRouterEnabled ? (
                <button
                  type="button"
                  className={`development-enhancement-entry development-enhancement-entry--${developmentEnhancement.phase}`}
                  onClick={() => setEnhancementPanelOpen(true)}
                  title={developmentEnhancement.providerError ?? "逐次选择源码、预览完整外发 JSON，再确认调用 OpenRouter"}
                >
                  {developmentEnhancement.active
                    ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                    : <Sparkles size={13} aria-hidden="true" />}
                  {developmentEnhancement.active
                    ? "模型运行中"
                    : developmentEnhancement.result
                      ? "模型分支"
                      : "OpenRouter 增强"}
                </button>
              ) : null}
              <button
                type="button"
                className={`development-session-save-state development-session-save-state--${developmentSessions.error ? "error" : developmentSessions.saving ? "saving" : developmentSessions.activeSessionId ? "saved" : "unsaved"}`}
                onClick={() => setSessionPanelOpen(true)}
                title={developmentSessions.error || "打开本机分析 Sessions"}
              >
                {developmentSessions.saving
                  ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  : <History size={13} aria-hidden="true" />}
                {developmentSessions.saving
                  ? "正在保存"
                  : developmentSessions.error
                    ? "未保存"
                    : developmentSessions.activeSessionId
                      ? "本机已保存"
                      : "Session"}
              </button>
              <button
                type="button"
                className="development-expand-all"
                onClick={() => setExpanded(allExpanded ? new Set() : new Set(EXPANDABLE_STAGES))}
              >
                <Layers3 size={13} />{allExpanded ? "收起分支" : "展开全部"}
              </button>
              <MagnetControls enabled={magnetEnabled} strength={magnetStrength} onToggle={onToggleMagnet} onStrengthChange={onMagnetStrengthChange} />
            </header>
            <DevelopmentCanvas
              projection={projection}
              activeIndex={activeIndex}
              expanded={expanded}
              selection={selection}
              onSelect={setSelection}
              onToggle={toggleStage}
              enhancement={developmentEnhancement.result}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
            />
          </>
        ) : (
          <div className="development-empty">
            <div className="development-empty__route" aria-hidden="true">
              <span>意图</span><i /><span>证据</span><i /><span>影响</span><i /><span>建议</span><i /><span>草案</span>
            </div>
            <FileSearch size={34} />
            <small>READ-ONLY DEVELOPMENT PLANE</small>
            <h2>先找到证据，再提出改动</h2>
            <p>选择仓库并描述开发意图。分析器只使用当前 revision 的定义和关系图，无法证明的内容会保留为推断。</p>
          </div>
        )}
      </main>

      {projection ? (
        <DevelopmentInspector
          projection={projection}
          selection={selection}
          enhancement={developmentEnhancement.result}
          onOpenDefinition={onOpenDefinition}
        />
      ) : (
        <aside className="development-inspector development-inspector--empty">
          <ShieldCheck size={24} />
          <strong>分析详情</strong>
          <p>生成链路后，点击任意节点查看源码锚点、置信度、约束和补丁结构草案。</p>
        </aside>
      )}

      {projection ? (
        <DevelopmentTimeline stages={projection.stages} activeIndex={activeIndex} onChange={changeStep} />
      ) : <div className="development-timeline development-timeline--empty" />}

      <DevelopmentSessionPanel
        open={sessionPanelOpen}
        connection={developmentSessions.connection}
        storage={developmentSessions.storage}
        sessions={developmentSessions.sessions}
        total={developmentSessions.total}
        activeSessionId={developmentSessions.activeSessionId}
        action={developmentSessions.action}
        error={developmentSessions.error}
        onClose={() => setSessionPanelOpen(false)}
        onRefresh={() => void developmentSessions.refresh()}
        onRestore={(sessionId) => void restoreSession(sessionId)}
        onExport={(sessionId) => void developmentSessions.exportSession(sessionId)}
        onDelete={developmentSessions.deleteSession}
        onClearError={developmentSessions.clearError}
      />

      {projection ? (
        <DevelopmentEnhancementPanel
          open={enhancementPanelOpen}
          projection={projection}
          controller={developmentEnhancement}
          onClose={() => setEnhancementPanelOpen(false)}
        />
      ) : null}

      {projection && controlledExecutionEnabled ? (
        <DevelopmentExecutionPanel
          open={executionPanelOpen}
          projection={projection}
          controller={developmentExecution}
          onClose={() => setExecutionPanelOpen(false)}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
        />
      ) : null}
    </section>
  );
}
