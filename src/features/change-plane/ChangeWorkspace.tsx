import {
  AlertTriangle,
  CheckCircle2,
  FileDiff,
  GitBranch,
  GitCompareArrows,
  GitPullRequest,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_LOCAL_REPOSITORY_SERVER,
  LocalRepositoryClient,
  LocalRepositoryClientError,
  type LocalRepositoryCatalog,
} from "../../adapters/local-repository";
import type { GitChangeMode } from "../../kernel";
import { MagnetControls } from "../trace-graph";
import { ChangeGraphCanvas } from "./ChangeGraphCanvas";
import { ChangeInspector } from "./ChangeInspector";
import { projectChangeImpacts, type ChangeImpactProjection } from "./model";

type ConnectionState =
  | { status: "connecting" }
  | { status: "offline"; message: string }
  | { status: "ready"; catalog: LocalRepositoryCatalog };

function errorMessage(error: unknown) {
  if (error instanceof LocalRepositoryClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "Git 变更分析失败。";
}

function preferredRepository(catalog: LocalRepositoryCatalog) {
  return catalog.repositories.find((repository) => repository.owner === "agent-core")
    ?? catalog.repositories[0];
}

function ownerLabel(owner: string) {
  if (owner === "agent-core") return "CORE";
  if (owner === "jiuwenswarm") return "SWARM";
  return "LOCAL";
}

interface ChangeWorkspaceProps {
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function ChangeWorkspace({
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: ChangeWorkspaceProps) {
  const client = useMemo(() => new LocalRepositoryClient(), []);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });
  const [repositoryPath, setRepositoryPath] = useState("");
  const [mode, setMode] = useState<GitChangeMode>("working-tree");
  const [base, setBase] = useState("HEAD~1");
  const [head, setHead] = useState("HEAD");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [analysisError, setAnalysisError] = useState("");
  const [projection, setProjection] = useState<ChangeImpactProjection | null>(null);
  const [activeFileId, setActiveFileId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

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
      setRepositoryPath((current) => current || preferredRepository(catalog)?.path || "");
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      setConnection({ status: "offline", message: errorMessage(error) });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, connectionRevision]);

  function selectRepository(path: string) {
    setRepositoryPath(path);
    setProjection(null);
    setActiveFileId("");
    setSelectedNodeId(null);
    setAnalysisStatus("idle");
    setAnalysisError("");
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repositoryPath.trim() || connection.status !== "ready") return;
    setAnalysisStatus("loading");
    setAnalysisError("");
    setSelectedNodeId(null);
    try {
      const [scan, changes] = await Promise.all([
        client.scan(repositoryPath, {
          includeTests: false,
          includeFunctions: true,
          maxFiles: 5_000,
          maxEdges: 20_000,
        }),
        client.changes(repositoryPath, {
          mode,
          ...(mode === "compare" ? { base, head } : {}),
          options: { includeUntracked, maxFiles: 500 },
        }),
      ]);
      const next = projectChangeImpacts(scan, changes);
      setProjection(next);
      setActiveFileId(next.files[0]?.file.id ?? "");
      setAnalysisStatus("ready");
    } catch (error: unknown) {
      setProjection(null);
      setActiveFileId("");
      setAnalysisStatus("error");
      setAnalysisError(errorMessage(error));
    }
  }

  const activeFile = projection?.files.find((item) => item.file.id === activeFileId)
    ?? projection?.files[0];

  return (
    <section className="change-workspace">
      <aside className="change-sidebar">
        <header className="change-sidebar__header">
          <span><GitPullRequest size={18} /></span>
          <div><strong>Git Change</strong><small>只读影响分析</small></div>
          <em className={`change-service-state change-service-state--${connection.status}`} title={DEFAULT_LOCAL_REPOSITORY_SERVER}>
            {connection.status === "connecting" ? <LoaderCircle size={12} className="spin" /> : connection.status === "ready" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            {connection.status === "connecting" ? "连接中" : connection.status === "ready" ? "只读在线" : "未连接"}
          </em>
        </header>

        <div className="change-sidebar__scroll">
          {connection.status === "offline" ? (
            <section className="change-service-empty">
              <Server size={22} />
              <strong>启动本地只读服务</strong>
              <p>{connection.message}</p>
              <button type="button" onClick={() => setConnectionRevision((value) => value + 1)}><RefreshCw size={13} />重新连接</button>
            </section>
          ) : null}

          {connection.status === "ready" ? (
            <>
              <section className="change-section">
                <div className="change-section__title"><span>REPOSITORIES</span><em>{connection.catalog.repositories.length}</em></div>
                <div className="change-repositories">
                  {connection.catalog.repositories.map((repository) => (
                    <button
                      type="button"
                      key={repository.id}
                      className={repository.path === repositoryPath ? "change-repository change-repository--active" : "change-repository"}
                      onClick={() => selectRepository(repository.path)}
                    >
                      <span className={`change-repository__owner change-repository__owner--${repository.owner}`}>{ownerLabel(repository.owner)}</span>
                      <span><strong>{repository.name}</strong><small><GitBranch size={10} />{repository.branch}</small></span>
                      {repository.dirty ? <em>DIRTY</em> : <CheckCircle2 size={13} />}
                    </button>
                  ))}
                </div>
              </section>

              <form className="change-form" onSubmit={analyze}>
                <label htmlFor="change-repository-path">仓库绝对路径</label>
                <div className="change-path-input"><HardDrive size={13} /><input id="change-repository-path" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} spellCheck={false} /></div>

                <div className="change-mode" role="group" aria-label="Git 比较模式">
                  <button type="button" className={mode === "working-tree" ? "change-mode--active" : ""} onClick={() => setMode("working-tree")} aria-pressed={mode === "working-tree"}><FileDiff size={13} />工作树</button>
                  <button type="button" className={mode === "compare" ? "change-mode--active" : ""} onClick={() => setMode("compare")} aria-pressed={mode === "compare"}><GitCompareArrows size={13} />提交范围</button>
                </div>

                {mode === "compare" ? (
                  <div className="change-refs">
                    <label htmlFor="change-base">Base</label>
                    <input id="change-base" value={base} onChange={(event) => setBase(event.target.value)} placeholder="main" />
                    <label htmlFor="change-head">Head</label>
                    <input id="change-head" value={head} onChange={(event) => setHead(event.target.value)} placeholder="HEAD" />
                    <small>只解析本地已有 commit / refs；不会 fetch 或 checkout。</small>
                  </div>
                ) : (
                  <label className="change-checkbox"><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />包含未跟踪文件</label>
                )}

                <button type="submit" className="change-analyze" disabled={!repositoryPath.trim() || analysisStatus === "loading"}>
                  {analysisStatus === "loading" ? <LoaderCircle size={14} className="spin" /> : <GitCompareArrows size={14} />}
                  {analysisStatus === "loading" ? "正在分析…" : "生成变更图"}
                </button>
                {analysisStatus === "error" ? <p className="change-form__error"><AlertTriangle size={12} />{analysisError}</p> : null}
              </form>
            </>
          ) : null}

          {projection ? (
            <section className="change-file-list-section">
              <div className="change-section__title"><span>CHANGED FILES</span><em>{projection.files.length}</em></div>
              <div className="change-summary-metrics">
                <span><b>{projection.changes.statistics.files}</b><small>files</small></span>
                <span className="change-stat--add"><b>+{projection.changes.statistics.additions}</b><small>lines</small></span>
                <span className="change-stat--delete"><b>−{projection.changes.statistics.deletions}</b><small>lines</small></span>
              </div>
              <div className="change-file-list">
                {projection.files.map((item) => (
                  <button
                    type="button"
                    key={item.file.id}
                    className={item.file.id === activeFile?.file.id ? `change-file change-file--active change-file--${item.file.status}` : `change-file change-file--${item.file.status}`}
                    onClick={() => {
                      setActiveFileId(item.file.id);
                      setSelectedNodeId(null);
                    }}
                  >
                    <span>{item.file.statusCode}</span>
                    <span><strong>{item.file.path.split("/").at(-1)}</strong><small>{item.file.path}</small></span>
                    <em>{item.direct.length + item.fileLevel.length}</em>
                  </button>
                ))}
                {projection.files.length === 0 ? <p>当前比较范围没有文件差异。</p> : null}
              </div>
            </section>
          ) : null}
        </div>
      </aside>

      <main className="change-stage">
        {projection && activeFile ? (
          <>
            <header className="change-toolbar">
              <div className="change-toolbar__identity">
                <GitCompareArrows size={15} />
                <span><strong>{projection.changes.comparison.base.requested} → {projection.changes.comparison.head.requested}</strong><small>{projection.changes.comparison.mergeBase.slice(0, 12)} merge-base</small></span>
              </div>
              <span className={projection.headAligned ? "change-alignment change-alignment--exact" : "change-alignment change-alignment--inferred"}>
                {projection.headAligned ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {projection.headAligned ? "行号已对齐" : "行号推断"}
              </span>
              <MagnetControls enabled={magnetEnabled} strength={magnetStrength} onToggle={onToggleMagnet} onStrengthChange={onMagnetStrengthChange} />
            </header>
            <ChangeGraphCanvas
              projection={projection}
              activeFileId={activeFile.file.id}
              selectedNodeId={selectedNodeId}
              onSelectFile={setActiveFileId}
              onSelectNode={setSelectedNodeId}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
            />
          </>
        ) : projection ? (
          <div className="change-empty"><CheckCircle2 size={30} /><small>CLEAN COMPARISON</small><h2>没有文件变更</h2><p>选择另一个工作树或本地 commit range 继续分析。</p></div>
        ) : (
          <div className="change-empty"><GitCompareArrows size={30} /><small>CHANGE PLANE</small><h2>把 Git diff 映射到代码节点</h2><p>选择仓库和比较范围。系统只读取本地 Git 与 AST，不执行 fetch、checkout、merge 或目标代码。</p></div>
        )}
      </main>

      {projection && activeFile ? (
        <ChangeInspector projection={projection} activeFileId={activeFile.file.id} selectedNodeId={selectedNodeId} />
      ) : (
        <aside className="change-inspector change-inspector--empty"><ShieldCheck size={22} /><strong>变更详情</strong><p>生成变更图后，点击文件或节点查看 hunk、源码范围和影响置信度。</p></aside>
      )}
    </section>
  );
}
