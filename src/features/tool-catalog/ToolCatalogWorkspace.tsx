import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Radio,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_LOCAL_REPOSITORY_SERVER,
  LocalRepositoryClient,
  LocalRepositoryClientError,
  type LocalRepositoryCatalog,
  type LocalToolCatalogResult,
} from "../../adapters/local-repository";
import type { RuntimeTraceEvent } from "../../kernel";
import { MagnetControls } from "../trace-graph";
import { ToolCatalogCanvas } from "./ToolCatalogCanvas";
import { ToolCatalogInspector } from "./ToolCatalogInspector";
import {
  filterProjectedTools,
  projectToolCatalog,
  type ToolCatalogSelection,
  type ToolRegistrationState,
} from "./model";

type ConnectionState =
  | { status: "connecting" }
  | { status: "offline"; message: string }
  | { status: "ready"; catalog: LocalRepositoryCatalog };

function errorMessage(error: unknown) {
  if (error instanceof LocalRepositoryClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "Tool Catalog 扫描失败。";
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

const stateLabel: Record<ToolRegistrationState, string> = {
  "runtime-observed": "运行确认",
  "static-linked": "静态路径",
  "declared-only": "仅声明",
};

const stateIcon = {
  "runtime-observed": Radio,
  "static-linked": Route,
  "declared-only": CircleDashed,
};

interface ToolCatalogWorkspaceProps {
  runtimeEvents: readonly RuntimeTraceEvent[];
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function ToolCatalogWorkspace({
  runtimeEvents,
  magnetEnabled,
  magnetStrength,
  onToggleMagnet,
  onMagnetStrengthChange,
}: ToolCatalogWorkspaceProps) {
  const client = useMemo(() => new LocalRepositoryClient(), []);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });
  const [repositoryPath, setRepositoryPath] = useState("");
  const [includeTests, setIncludeTests] = useState(false);
  const [scanResult, setScanResult] = useState<LocalToolCatalogResult | null>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "ready" | "error">("idle");
  const [scanError, setScanError] = useState("");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ToolCatalogSelection | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ToolRegistrationState | "all">("all");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setConnection({ status: "connecting" });
    void Promise.all([client.health(controller.signal), client.listRepositories(controller.signal)])
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

  const projection = useMemo(
    () => (scanResult ? projectToolCatalog(scanResult, runtimeEvents) : null),
    [runtimeEvents, scanResult],
  );
  const filteredTools = useMemo(
    () => (projection ? filterProjectedTools(projection, query, stateFilter) : []),
    [projection, query, stateFilter],
  );
  const selectedTool = selectedToolId && projection
    ? projection.toolsById.get(selectedToolId) ?? projection.tools[0] ?? null
    : projection?.tools[0] ?? null;

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repositoryPath.trim() || connection.status !== "ready") return;
    setScanStatus("scanning");
    setScanError("");
    try {
      const result = await client.tools(repositoryPath, { includeTests });
      setScanResult(result);
      const nextToolId = projectToolCatalog(result, runtimeEvents).tools[0]?.tool.id ?? null;
      setSelectedToolId(nextToolId);
      setSelection(nextToolId ? { kind: "tool", id: nextToolId } : null);
      setQuery("");
      setStateFilter("all");
      setScanStatus("ready");
    } catch (error: unknown) {
      setScanStatus("error");
      setScanError(errorMessage(error));
    }
  }

  function selectTool(toolId: string) {
    setSelectedToolId(toolId);
    setSelection({ kind: "tool", id: toolId });
  }

  return (
    <section className="tool-catalog-workspace">
      <aside className="tool-catalog-sidebar">
        <header className="tool-catalog-sidebar__header">
          <span className="tool-catalog-sidebar__icon"><Braces size={18} /></span>
          <span><strong>Tool Registry</strong><small>静态路径 + 运行确认</small></span>
          <span className={`service-state service-state--${connection.status}`} title={DEFAULT_LOCAL_REPOSITORY_SERVER}>
            {connection.status === "connecting" ? <LoaderCircle size={12} className="spin" /> : connection.status === "ready" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            {connection.status === "connecting" ? "连接中" : connection.status === "ready" ? "只读在线" : "未连接"}
          </span>
        </header>
        <div className="tool-catalog-sidebar__scroll">
          {connection.status === "offline" ? (
            <section className="service-empty-state">
              <Server size={22} /><strong>启动本地只读服务</strong><p>{connection.message}</p>
              <code>python -B services/local-server/scripts/run_server.py --allow-root &lt;workspace&gt;</code>
              <button type="button" onClick={() => setConnectionRevision((value) => value + 1)}><RefreshCw size={14} />重新连接</button>
            </section>
          ) : null}
          {connection.status === "ready" ? (
            <>
              <section className="tool-catalog-section">
                <div className="tool-catalog-section__title"><span>REPOSITORIES</span><em>{connection.catalog.repositories.length}</em></div>
                <div className="tool-catalog-repositories">
                  {connection.catalog.repositories.map((repository) => (
                    <button
                      type="button"
                      key={repository.id}
                      className={`tool-catalog-repository tool-catalog-repository--${repository.owner} ${repositoryPath === repository.path ? "tool-catalog-repository--active" : ""}`}
                      onClick={() => setRepositoryPath(repository.path)}
                    >
                      <span>{ownerLabel(repository.owner)}</span>
                      <strong>{repository.name}</strong>
                      <small><GitBranch size={10} />{repository.branch}</small>
                      {repository.dirty ? <em>DIRTY</em> : null}
                    </button>
                  ))}
                </div>
              </section>
              <form className="tool-catalog-form" onSubmit={submitScan}>
                <label htmlFor="tool-catalog-path">仓库绝对路径</label>
                <div className="tool-catalog-path"><HardDrive size={13} /><input id="tool-catalog-path" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} /></div>
                <label className="tool-catalog-checkbox"><input type="checkbox" checked={includeTests} onChange={(event) => setIncludeTests(event.target.checked)} /><span>包含测试目录</span></label>
                <button type="submit" disabled={scanStatus === "scanning"}>
                  {scanStatus === "scanning" ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
                  {scanStatus === "scanning" ? "扫描中" : "扫描 Tool 注册表"}
                </button>
              </form>
            </>
          ) : null}
          {scanError ? <section className="tool-catalog-error"><AlertTriangle size={15} /><span>{scanError}</span></section> : null}
          {projection ? (
            <>
              <section className="tool-catalog-summary">
                <div><strong>{projection.catalog.statistics.tools}</strong><span>TOOLS</span></div>
                <div><strong>{projection.catalog.statistics.linkedRegistrations}</strong><span>LINKED</span></div>
                <div><strong>{projection.observations.length}</strong><span>LIVE</span></div>
              </section>
              <section className="tool-catalog-browser">
                <div className="tool-catalog-section__title"><span>TOOL DEFINITIONS</span><em>{filteredTools.length}</em></div>
                <label className="tool-catalog-search"><Search size={13} /><input aria-label="搜索 Tool" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、symbol、路径" /></label>
                <div className="tool-catalog-filters" role="group" aria-label="Tool 注册状态筛选">
                  <button type="button" className={stateFilter === "all" ? "active" : ""} onClick={() => setStateFilter("all")}>全部</button>
                  {(Object.keys(stateLabel) as ToolRegistrationState[]).map((state) => (
                    <button type="button" key={state} className={stateFilter === state ? "active" : ""} onClick={() => setStateFilter(state)}>{stateLabel[state]} {projection.counts[state]}</button>
                  ))}
                </div>
                <div className="tool-catalog-list">
                  {filteredTools.map((item) => {
                    const StateIcon = stateIcon[item.state];
                    return (
                      <button type="button" key={item.tool.id} className={`tool-catalog-item tool-catalog-item--${item.tool.owner} ${selectedTool?.tool.id === item.tool.id ? "tool-catalog-item--active" : ""}`} onClick={() => selectTool(item.tool.id)}>
                        <span className={`tool-catalog-item__state tool-catalog-item__state--${item.state}`}><StateIcon size={12} /></span>
                        <span><strong>{item.tool.name}</strong><small>{item.tool.source.path}</small></span>
                        <em>{item.registrationSites.length}</em>
                      </button>
                    );
                  })}
                </div>
              </section>
              {projection.catalog.statistics.dynamicRegistrations ? (
                <section className="tool-catalog-dynamic">
                  <div className="tool-catalog-section__title"><span>DYNAMIC PATHS</span><em>{projection.catalog.statistics.dynamicRegistrations}</em></div>
                  {projection.catalog.registrationSites.filter((site) => site.confidence === "dynamic").slice(0, 12).map((site) => (
                    <button type="button" key={site.id} onClick={() => setSelection({ kind: "registration", id: site.id })}><Route size={11} /><span>{site.container || site.callee}</span><small>L{site.source.startLine}</small></button>
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>

      <main className="tool-catalog-main">
        {projection ? (
          <>
            <header className="tool-catalog-toolbar">
              <div><ShieldCheck size={16} /><span><strong>静态注册路径</strong><small>不导入目标代码 · ability.register 才是运行确认</small></span></div>
              <MagnetControls enabled={magnetEnabled} strength={magnetStrength} onToggle={onToggleMagnet} onStrengthChange={onMagnetStrengthChange} />
            </header>
            <ToolCatalogCanvas
              projection={projection}
              selectedTool={selectedTool}
              selection={selection}
              onSelect={setSelection}
              magnetEnabled={magnetEnabled}
              magnetStrength={magnetStrength}
            />
          </>
        ) : (
          <section className="tool-catalog-empty"><Braces size={30} /><span>TOOL REGISTRY</span><h2>查看 Tool 从声明到注册</h2><p>扫描仓库后，可逐层查看 ToolCard、AbilityManager / ResourceManager 注册路径，以及当前 Trace 中的 ability.register 运行确认。</p></section>
        )}
      </main>
      <ToolCatalogInspector projection={projection} selectedTool={selectedTool} selection={selection} />
    </section>
  );
}
