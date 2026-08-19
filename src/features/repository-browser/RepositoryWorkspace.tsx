import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  GitBranch,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  GraphSourceReference,
  RuntimeTraceEvent,
} from "../../kernel";
import {
  DEFAULT_LOCAL_REPOSITORY_SERVER,
  LocalRepositoryClient,
  LocalRepositoryClientError,
  type LocalRepositoryCatalog,
  type LocalRepositoryScanResult,
  type RepositoryScanOptions,
} from "../../adapters/local-repository";
import { MagnetControls } from "../trace-graph";
import {
  matchSourceToDefinition,
  projectRuntimeDefinitions,
  repositoryMatchesSource,
  type RuntimeSourceMatch,
  type SourceNavigationRequest,
} from "../source-convergence";
import { DefinitionGraphCanvas } from "./DefinitionGraphCanvas";
import { DefinitionInspector } from "./DefinitionInspector";
import {
  createDefinitionGraphIndex,
  definitionBreadcrumb,
  definitionKinds,
  projectDefinitionViewport,
  searchDefinitionNodes,
} from "./model";

type ConnectionState =
  | { status: "connecting" }
  | { status: "offline"; message: string }
  | { status: "ready"; catalog: LocalRepositoryCatalog };

function errorMessage(error: unknown) {
  if (error instanceof LocalRepositoryClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "本地仓服务连接失败。";
}

function preferredRepository(catalog: LocalRepositoryCatalog) {
  return (
    catalog.repositories.find((repository) => repository.owner === "agent-core") ??
    catalog.repositories[0]
  );
}
function repositoryOwnerLabel(owner: string) {
  if (owner === "agent-core") return "CORE";
  if (owner === "jiuwenswarm") return "SWARM";
  return "LOCAL";
}

interface RepositoryWorkspaceProps {
  runtimeEvents: readonly RuntimeTraceEvent[];
  sourceNavigation: SourceNavigationRequest | null;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
  onOpenChange?: (source: GraphSourceReference) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function RepositoryWorkspace({
  runtimeEvents,
  sourceNavigation,
  onOpenRuntimeEvent,
  onOpenChange,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: RepositoryWorkspaceProps) {
  const client = useMemo(() => new LocalRepositoryClient(), []);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({
    status: "connecting",
  });
  const [repositoryPath, setRepositoryPath] = useState("");
  const [scanOptions, setScanOptions] = useState<RepositoryScanOptions>({
    includeTests: false,
    includeFunctions: false,
  });
  const [scanResult, setScanResult] = useState<LocalRepositoryScanResult | null>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "ready" | "error">(
    "idle",
  );
  const [scanError, setScanError] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(0);
  const [sourceNavigationMatch, setSourceNavigationMatch] =
    useState<RuntimeSourceMatch | null>(null);
  const [sourceNavigationError, setSourceNavigationError] = useState("");
  const handledSourceNavigationId = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setConnection({ status: "connecting" });
    void Promise.all([
      client.health(controller.signal),
      client.listRepositories(controller.signal),
    ])
      .then(([, catalog]) => {
        if (!active) return;
        setConnection({ status: "ready", catalog });
        setRepositoryPath((current) => current || preferredRepository(catalog)?.path || "");
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setConnection({ status: "offline", message: errorMessage(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, connectionRevision]);

  const index = useMemo(
    () => (scanResult ? createDefinitionGraphIndex(scanResult.graph) : null),
    [scanResult],
  );
  const runtimeProjection = useMemo(
    () => scanResult
      ? projectRuntimeDefinitions(scanResult.graph, runtimeEvents, {
          repositoryDirty: scanResult.repository.dirty,
        })
      : null,
    [runtimeEvents, scanResult],
  );
  const resolvedFocusId =
    index && focusId && index.nodesById.has(focusId)
      ? focusId
      : index?.roots[0]?.id ?? null;
  const viewport = useMemo(
    () =>
      index && resolvedFocusId
        ? projectDefinitionViewport(index, resolvedFocusId, { kind, page })
        : null,
    [index, kind, page, resolvedFocusId],
  );
  const selectedNode =
    (selectedNodeId ? index?.nodesById.get(selectedNodeId) : undefined) ??
    (resolvedFocusId ? index?.nodesById.get(resolvedFocusId) : undefined);
  const searchResults = useMemo(
    () => (index ? searchDefinitionNodes(index, query, 18) : []),
    [index, query],
  );
  const kinds = useMemo(() => (index ? definitionKinds(index) : []), [index]);
  const breadcrumb = useMemo(
    () =>
      index && resolvedFocusId
        ? definitionBreadcrumb(index, resolvedFocusId)
        : [],
    [index, resolvedFocusId],
  );

  function navigate(nodeId: string) {
    setFocusId(nodeId);
    setSelectedNodeId(nodeId);
    setPage(0);
    setQuery("");
  }

  const runScan = useCallback(async (
    path: string,
    options: RepositoryScanOptions,
    navigation?: SourceNavigationRequest,
  ) => {
    setScanStatus("scanning");
    setScanError("");
    setSourceNavigationError("");
    if (!navigation) setSourceNavigationMatch(null);
    try {
      const result = await client.scan(path, options);
      const root = result.graph.nodes.find((node) => !node.parentId);
      const match = navigation
        ? matchSourceToDefinition(result.graph, navigation.source, {
            repositoryDirty: result.repository.dirty,
          })
        : null;
      const targetId = match?.node?.id ?? root?.id ?? null;
      setScanResult(result);
      setFocusId(targetId);
      setSelectedNodeId(targetId);
      setSourceNavigationMatch(match);
      setKind("all");
      setPage(0);
      setQuery("");
      setScanStatus("ready");
    } catch (error: unknown) {
      setScanStatus("error");
      setScanError(errorMessage(error));
    }
  }, [client]);

  useEffect(() => {
    if (
      !sourceNavigation ||
      connection.status !== "ready" ||
      handledSourceNavigationId.current === sourceNavigation.id
    ) {
      return;
    }
    handledSourceNavigationId.current = sourceNavigation.id;
    const repository = connection.catalog.repositories.find((candidate) =>
      repositoryMatchesSource(candidate, sourceNavigation.source));
    if (!repository) {
      setSourceNavigationMatch(null);
      setSourceNavigationError(
        `允许目录中没有与 ${sourceNavigation.source.repository} 身份一致的仓库。`,
      );
      return;
    }
    const options = { ...scanOptions, includeFunctions: true };
    setRepositoryPath(repository.path);
    setScanOptions(options);
    void runScan(repository.path, options, sourceNavigation);
  }, [connection, runScan, scanOptions, sourceNavigation]);

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repositoryPath.trim() || connection.status !== "ready") return;
    await runScan(repositoryPath, scanOptions);
  }

  return (
    <section className="repository-workspace">
      <aside className="repository-sidebar">
        <header className="repository-sidebar__header">
          <span className="repository-sidebar__icon"><Database size={18} /></span>
          <span>
            <strong>Local Repository</strong>
            <small>只读静态定义索引</small>
          </span>
          <span
            className={`service-state service-state--${connection.status}`}
            title={DEFAULT_LOCAL_REPOSITORY_SERVER}
          >
            {connection.status === "connecting" ? (
              <LoaderCircle size={12} className="spin" />
            ) : connection.status === "ready" ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertTriangle size={12} />
            )}
            {connection.status === "connecting"
              ? "连接中"
              : connection.status === "ready"
                ? "只读在线"
                : "未连接"}
          </span>
        </header>

        <div className="repository-sidebar__scroll">
          {connection.status === "offline" ? (
            <section className="service-empty-state">
              <Server size={22} />
              <strong>启动本地只读服务</strong>
              <p>{connection.message}</p>
              <code>python -B services/local-server/scripts/run_server.py --allow-root &lt;workspace&gt;</code>
              <button type="button" onClick={() => setConnectionRevision((value) => value + 1)}>
                <RefreshCw size={14} />重新连接
              </button>
            </section>
          ) : null}

          {connection.status === "ready" ? (
            <>
              <section className="repository-section">
                <div className="repository-section__title">
                  <span>DISCOVERED REPOSITORIES</span>
                  <em>{connection.catalog.repositories.length}</em>
                </div>
                <div className="repository-list">
                  {connection.catalog.repositories.map((repository) => (
                    <button
                      type="button"
                      key={repository.id}
                      className={
                        repositoryPath === repository.path
                          ? `repository-card repository-card--active repository-card--${repository.owner}`
                          : `repository-card repository-card--${repository.owner}`
                      }
                      onClick={() => setRepositoryPath(repository.path)}
                    >
                      <span className="repository-card__owner">
                        {repositoryOwnerLabel(repository.owner)}
                      </span>
                      <span className="repository-card__body">
                        <strong>{repository.name}</strong>
                        <small><GitBranch size={11} />{repository.branch}</small>
                      </span>
                      {repository.dirty ? <em>DIRTY</em> : <CheckCircle2 size={14} />}
                    </button>
                  ))}
                  {connection.catalog.repositories.length === 0 ? (
                    <p className="repository-list__empty">允许目录下未发现一级 Git 仓库，可在下方手动输入路径。</p>
                  ) : null}
                </div>
              </section>

              <form className="repository-scan-form" onSubmit={submitScan}>
                <label htmlFor="repository-path">仓库或子目录绝对路径</label>
                <div className="repository-path-input">
                  <HardDrive size={14} />
                  <input
                    id="repository-path"
                    value={repositoryPath}
                    onChange={(event) => setRepositoryPath(event.target.value)}
                    placeholder="C:\\workspace\\agent-core"
                    spellCheck={false}
                  />
                </div>
                <div className="repository-scan-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(scanOptions.includeFunctions)}
                      onChange={(event) =>
                        setScanOptions((current) => ({
                          ...current,
                          includeFunctions: event.target.checked,
                        }))
                      }
                    />
                    顶层函数
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(scanOptions.includeTests)}
                      onChange={(event) =>
                        setScanOptions((current) => ({
                          ...current,
                          includeTests: event.target.checked,
                        }))
                      }
                    />
                    测试目录
                  </label>
                </div>
                <button
                  type="submit"
                  className="repository-scan-button"
                  disabled={!repositoryPath.trim() || scanStatus === "scanning"}
                >
                  {scanStatus === "scanning" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Search size={15} />
                  )}
                  {scanStatus === "scanning" ? "正在索引…" : "生成定义图"}
                </button>
                {scanStatus === "error" ? (
                  <p className="repository-scan-error"><AlertTriangle size={13} />{scanError}</p>
                ) : null}
              </form>
            </>
          ) : null}

          {scanResult ? (
            <section className="scan-summary">
              <div className="repository-section__title">
                <span>INDEX SNAPSHOT</span>
                <em>{scanResult.repository.dirty ? "WORKTREE" : "HEAD"}</em>
              </div>
              <strong>{scanResult.repository.name}</strong>
              <code>{scanResult.repository.revision.slice(0, 12)}</code>
              <div className="scan-summary__metrics">
                <span><b>{scanResult.statistics.pythonFiles.toLocaleString()}</b><small>Python</small></span>
                <span><b>{scanResult.statistics.nodes.toLocaleString()}</b><small>节点</small></span>
                <span><b>{scanResult.statistics.edges.toLocaleString()}</b><small>关系</small></span>
              </div>
              <p>
                <LockKeyhole size={13} />
                {scanResult.statistics.cache?.status === "hit"
                  ? "内存缓存命中"
                  : scanResult.statistics.cache?.status === "bypass"
                    ? "AST 静态分析 · 缓存绕过"
                    : "AST 静态分析"}
                {" · "}{scanResult.statistics.durationMs.toLocaleString()} ms
              </p>
              {scanResult.statistics.cache ? (
                <small className={`scan-summary__cache scan-summary__cache--${scanResult.statistics.cache.status}`}>
                  {scanResult.statistics.cache.status === "hit"
                    ? `已校验 ${scanResult.statistics.cache.pythonFiles.toLocaleString()} 个 Python 文件 · 缓存年龄 ${scanResult.statistics.cache.ageMs.toLocaleString()} ms`
                    : scanResult.statistics.cache.status === "miss"
                      ? `新快照已进入内存 LRU · TTL ${scanResult.statistics.cache.ttlSeconds}s`
                      : `输入验证未缓存：${scanResult.statistics.cache.bypassReason ?? "bounded validation unavailable"}`}
                </small>
              ) : null}
              {scanResult.warnings.slice(0, 3).map((warning) => (
                <small className="scan-summary__warning" key={warning}>{warning}</small>
              ))}
            </section>
          ) : null}
        </div>
      </aside>

      <main className="definition-stage">
        {index && viewport && resolvedFocusId ? (
          <>
            <header className="definition-toolbar">
              {sourceNavigationError ? (
                <p className="definition-source-navigation definition-source-navigation--error">
                  <AlertTriangle size={12} />{sourceNavigationError}
                </p>
              ) : sourceNavigationMatch ? (
                <p className={`definition-source-navigation definition-source-navigation--${sourceNavigationMatch.status}`}>
                  {sourceNavigationMatch.status === "exact"
                    ? <CheckCircle2 size={12} />
                    : <AlertTriangle size={12} />}
                  <span><strong>{sourceNavigationMatch.status}</strong>{sourceNavigationMatch.reason}</span>
                </p>
              ) : null}
              <nav className="definition-breadcrumb" aria-label="定义图层级路径">
                {breadcrumb.map((node, indexInPath) => (
                  <span key={node.id}>
                    {indexInPath > 0 ? <ChevronRight size={13} /> : null}
                    <button type="button" onClick={() => navigate(node.id)}>{node.label}</button>
                  </span>
                ))}
              </nav>
              <div className="definition-toolbar__actions">
                <div className="definition-search">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索符号或源码路径"
                    aria-label="搜索定义节点"
                  />
                  {query ? (
                    <div className="definition-search-results">
                      {searchResults.map((node) => (
                        <button type="button" key={node.id} onClick={() => navigate(node.id)}>
                          <span><strong>{node.label}</strong><small>{node.kind}</small></span>
                          <code>{node.evidence[0]?.source?.path ?? ""}</code>
                        </button>
                      ))}
                      {searchResults.length === 0 ? <p>没有匹配定义。</p> : null}
                    </div>
                  ) : null}
                </div>
                <select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value);
                    setPage(0);
                  }}
                  aria-label="按节点类型筛选"
                >
                  <option value="all">全部类型</option>
                  {kinds.map((value) => <option value={value} key={value}>{value}</option>)}
                </select>
                <MagnetControls
                  enabled={magnetEnabled}
                  strength={magnetStrength}
                  onToggle={onToggleMagnet}
                  onStrengthChange={onMagnetStrengthChange}
                />
              </div>
              <div className="definition-toolbar__meta">
                <span>
                  {viewport.mode === "children" ? "CHILDREN" : "RELATIONS"}
                  <b>{viewport.totalMembers}</b>
                </span>
                {viewport.pageCount > 1 ? (
                  <div className="definition-pagination">
                    <button
                      type="button"
                      onClick={() => setPage((value) => Math.max(0, value - 1))}
                      disabled={viewport.page === 0}
                      aria-label="上一页定义节点"
                    ><ChevronLeft size={14} /></button>
                    <code>{viewport.page + 1} / {viewport.pageCount}</code>
                    <button
                      type="button"
                      onClick={() =>
                        setPage((value) => Math.min(viewport.pageCount - 1, value + 1))
                      }
                      disabled={viewport.page === viewport.pageCount - 1}
                      aria-label="下一页定义节点"
                    ><ChevronRight size={14} /></button>
                  </div>
                ) : null}
              </div>
            </header>
            <DefinitionGraphCanvas
              index={index}
              viewport={viewport}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onFocusNode={navigate}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
            />
          </>
        ) : (
          <div className="definition-empty-state">
            <span><Database size={30} /></span>
            <small>DEFINITION PLANE</small>
            <h2>从真实仓库生成可展开定义图</h2>
            <p>连接左侧只读服务并选择仓库。索引完成后，package、module、Agent、Rail、Tool 与继承/导入关系会按层级加载到画布。</p>
          </div>
        )}
      </main>

      {index && selectedNode && resolvedFocusId ? (
        <DefinitionInspector
          index={index}
          node={selectedNode}
          focusId={resolvedFocusId}
          repositoryPath={scanResult!.repository.path}
          magnetEnabled={magnetEnabled}
          magnetStrength={magnetStrength}
          onToggleMagnet={onToggleMagnet}
          onMagnetStrengthChange={onMagnetStrengthChange}
          onNavigate={navigate}
          runtimeSummary={runtimeProjection?.summariesByNode.get(selectedNode.id)}
          sourceNavigationMatch={sourceNavigationMatch}
          onOpenRuntimeEvent={onOpenRuntimeEvent}
          onOpenChange={onOpenChange}
        />
      ) : (
        <aside className="definition-inspector definition-inspector--empty">
          <Search size={22} />
          <strong>节点详情</strong>
          <p>生成定义图后，点击任意节点查看源码证据、静态属性与关系摘要。</p>
        </aside>
      )}
    </section>
  );
}
