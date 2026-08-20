import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  GitBranch,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
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
import { DevelopmentCanvas } from "./DevelopmentCanvas";
import { DevelopmentInspector } from "./DevelopmentInspector";
import { DevelopmentTimeline } from "./DevelopmentTimeline";
import {
  projectDevelopmentAnalysis,
  type DevelopmentAnalysisProjection,
  type DevelopmentSelection,
  type DevelopmentStageKind,
} from "./model";

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

interface DevelopmentAssistantWorkspaceProps {
  sources: readonly RegisteredDevelopmentAssistantSource[];
  onOpenDefinition?: (source: GraphSourceReference) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function DevelopmentAssistantWorkspace({
  sources,
  onOpenDefinition,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: DevelopmentAssistantWorkspaceProps) {
  const client = useMemo(() => new LocalRepositoryClient(), []);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });
  const [repositoryPath, setRepositoryPath] = useState("");
  const [intent, setIntent] = useState(sampleIntent());
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [analysisError, setAnalysisError] = useState("");
  const [projection, setProjection] = useState<DevelopmentAnalysisProjection | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<DevelopmentStageKind>>(new Set());
  const [selection, setSelection] = useState<DevelopmentSelection | null>(null);

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

  function selectRepository(repository: LocalRepositoryIdentity) {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setRepositoryPath(repository.path);
    setIntent(sampleIntent(repository));
    setProjection(null);
    setStatus("idle");
    setAnalysisError("");
    setActiveIndex(0);
    setExpanded(new Set());
    setSelection(null);
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connection.status !== "ready" || !repositoryPath || !intent.trim()) return;
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setStatus("loading");
    setAnalysisError("");
    setProjection(null);
    setSelection(null);
    try {
      const scan = await client.scan(repositoryPath, {
        includeTests: true,
        includeFunctions: true,
        maxFiles: 5_000,
        maxEdges: 20_000,
      }, controller.signal);
      if (controller.signal.aborted) return;
      const next = projectDevelopmentAnalysis(scan, intent);
      setProjection(next);
      setActiveIndex(0);
      setExpanded(new Set());
      setSelection({ kind: "stage", id: next.stages[0].id });
      setStatus("ready");
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setAnalysisError(errorMessage(error));
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null;
    }
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
                  <span>只读取当前工作树；不运行目标代码、不调用模型、不生成可应用 patch。</span>
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
                  <div><dt>MODEL</dt><dd>disabled</dd></div>
                  <div><dt>REPO WRITE</dt><dd>false</dd></div>
                  <div><dt>OUTPUT</dt><dd>{source?.capabilities.length ?? 5} layers</dd></div>
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
    </section>
  );
}
