import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { PluginHostSnapshot } from "../../adapters/plugin-host";
import {
  DEFAULT_LOCAL_REPOSITORY_SERVER,
  LocalRepositoryClient,
  LocalRepositoryClientError,
  type LocalRepositoryCatalog,
  type LocalToolCatalogResult,
} from "../../adapters/local-repository";
import type { RuntimeTraceEvent } from "../../kernel";
import type { PluginHostConnection } from "../plugin-host";
import { MagnetControls } from "../trace-graph";
import { ToolCatalogCanvas } from "./ToolCatalogCanvas";
import { ToolCatalogInspector } from "./ToolCatalogInspector";
import {
  filterProjectedTools,
  projectToolCatalog,
  type ToolCatalogSelection,
  type ToolEvidenceStage,
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

const stateLabel: Record<ToolEvidenceStage, string> = {
  discovered: "已发现",
  authorized: "目录授权",
  registered: "已注册",
  called: "已调用",
};

const stateIcon = {
  discovered: Braces,
  authorized: ShieldCheck,
  registered: Radio,
  called: Play,
};

interface ToolCatalogWorkspaceProps {
  runtimeEvents: readonly RuntimeTraceEvent[];
  pluginHostSnapshot: PluginHostSnapshot | null;
  pluginHostConnection: PluginHostConnection;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function ToolCatalogWorkspace({
  runtimeEvents,
  pluginHostSnapshot,
  pluginHostConnection,
  onOpenRuntimeEvent,
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
  const [stateFilter, setStateFilter] = useState<ToolEvidenceStage | "all">("all");

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

  const projectionOptions = useMemo(() => ({
    hostSnapshot: pluginHostSnapshot,
    hostConnection: pluginHostConnection,
  }), [pluginHostConnection, pluginHostSnapshot]);
  const projection = useMemo(
    () => scanResult
      ? projectToolCatalog(scanResult, runtimeEvents, projectionOptions)
      : null,
    [projectionOptions, runtimeEvents, scanResult],
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
      const nextProjection = projectToolCatalog(result, runtimeEvents, projectionOptions);
      setScanResult(result);
      const nextToolId = nextProjection.tools[0]?.tool.id ?? null;
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

  const unmatchedCount = (projection?.unmatchedRegistrations.length ?? 0)
    + (projection?.unmatchedCalls.length ?? 0);

  return (
    <section className="tool-catalog-workspace">
      <aside className="tool-catalog-sidebar">
        <header className="tool-catalog-sidebar__header">
          <span className="tool-catalog-sidebar__icon"><Braces size={18} aria-hidden="true" /></span>
          <span><strong>Tool Registry</strong><small>四层证据链</small></span>
          <span className={`service-state service-state--${connection.status}`} title={DEFAULT_LOCAL_REPOSITORY_SERVER}>
            {connection.status === "connecting" ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : connection.status === "ready" ? <CheckCircle2 size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
            {connection.status === "connecting" ? "连接中" : connection.status === "ready" ? "只读在线" : "未连接"}
          </span>
        </header>
        <div className="tool-catalog-sidebar__scroll">
          {connection.status === "offline" ? (
            <section className="service-empty-state">
              <Server size={22} aria-hidden="true" /><strong>启动本地只读服务</strong><p>{connection.message}</p>
              <code>python -B services/local-server/scripts/run_server.py --allow-root &lt;workspace&gt;</code>
              <button type="button" onClick={() => setConnectionRevision((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新连接</button>
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
                      <small><GitBranch size={10} aria-hidden="true" />{repository.branch}</small>
                      {repository.dirty ? <em>DIRTY</em> : null}
                    </button>
                  ))}
                </div>
              </section>
              <form className="tool-catalog-form" onSubmit={submitScan}>
                <label htmlFor="tool-catalog-path">仓库绝对路径</label>
                <div className="tool-catalog-path"><HardDrive size={13} aria-hidden="true" /><input id="tool-catalog-path" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} /></div>
                <label className="tool-catalog-checkbox"><input type="checkbox" checked={includeTests} onChange={(event) => setIncludeTests(event.target.checked)} /><span>包含测试目录</span></label>
                <button type="submit" disabled={scanStatus === "scanning"}>
                  {scanStatus === "scanning" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
                  {scanStatus === "scanning" ? "扫描中" : "扫描 Tool 证据"}
                </button>
              </form>
            </>
          ) : null}
          {scanError ? <section className="tool-catalog-error"><AlertTriangle size={15} aria-hidden="true" /><span>{scanError}</span></section> : null}
          {projection ? (
            <>
              <section className="tool-catalog-summary" aria-label="Tool 四层证据统计">
                {(Object.keys(stateLabel) as ToolEvidenceStage[]).map((stage) => (
                  <div key={stage} className={`tool-catalog-summary--${stage}`}><strong>{projection.counts[stage]}</strong><span>{stateLabel[stage]}</span></div>
                ))}
              </section>
              <section className="tool-catalog-browser">
                <div className="tool-catalog-section__title"><span>TOOL IDENTITIES</span><em>{filteredTools.length}</em></div>
                <label className="tool-catalog-search"><Search size={13} aria-hidden="true" /><input aria-label="搜索 Tool" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、symbol、路径、identity" /></label>
                <div className="tool-catalog-filters" role="group" aria-label="Tool 证据筛选">
                  <button type="button" className={stateFilter === "all" ? "active" : ""} onClick={() => setStateFilter("all")}>全部</button>
                  {(Object.keys(stateLabel) as ToolEvidenceStage[]).map((state) => (
                    <button type="button" key={state} className={stateFilter === state ? "active" : ""} onClick={() => setStateFilter(state)}>{stateLabel[state]} {projection.counts[state]}</button>
                  ))}
                </div>
                <div className="tool-catalog-list">
                  {filteredTools.map((item) => {
                    const StateIcon = stateIcon[item.state];
                    return (
                      <button type="button" key={item.tool.id} className={`tool-catalog-item tool-catalog-item--${item.tool.owner} ${selectedTool?.tool.id === item.tool.id ? "tool-catalog-item--active" : ""}`} onClick={() => selectTool(item.tool.id)}>
                        <span className={`tool-catalog-item__state tool-catalog-item__state--${item.state}`}><StateIcon size={12} aria-hidden="true" /></span>
                        <span><strong>{item.tool.name}</strong><small>{item.tool.source.path}</small></span>
                        <em>{item.calls.length || item.registrations.length || item.registrationSites.length}</em>
                      </button>
                    );
                  })}
                </div>
              </section>
              {projection.catalog.statistics.dynamicRegistrations ? (
                <section className="tool-catalog-dynamic">
                  <div className="tool-catalog-section__title"><span>DYNAMIC STATIC PATHS</span><em>{projection.catalog.statistics.dynamicRegistrations}</em></div>
                  {projection.catalog.registrationSites.filter((site) => site.confidence === "dynamic").slice(0, 12).map((site) => (
                    <button type="button" key={site.id} onClick={() => setSelection({ kind: "registration-path", id: site.id })}><Route size={11} aria-hidden="true" /><span>{site.container || site.callee}</span><small>L{site.source.startLine}</small></button>
                  ))}
                </section>
              ) : null}
              {unmatchedCount ? (
                <section className="tool-catalog-unmatched">
                  <div className="tool-catalog-section__title"><span>UNALIGNED RUNTIME</span><em>{unmatchedCount}</em></div>
                  <p>缺少可核验 identity，不跨仓库或 revision 猜测。</p>
                  {projection.unmatchedRegistrations.slice(0, 6).map((item) => (
                    <button type="button" key={item.id} onClick={() => setSelection({ kind: "runtime-registration", id: item.id })}>
                      <Radio size={11} aria-hidden="true" /><span>{item.name}</span><small>seq {item.sequence}</small>
                    </button>
                  ))}
                  {projection.unmatchedCalls.slice(0, 6).map((item) => (
                    <button type="button" key={item.id} onClick={() => setSelection({ kind: "runtime-call", id: item.id })}>
                      <Play size={11} aria-hidden="true" /><span>{item.name}</span><small>seq {item.startSequence}</small>
                    </button>
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
              <div><ShieldCheck size={16} aria-hidden="true" /><span><strong>Tool 四层证据链</strong><small>静态路径为推断分支 · Host 授权仅限目录读取 · Trace 才证明注册与调用</small></span></div>
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
          <section className="tool-catalog-empty"><Braces size={30} aria-hidden="true" /><span>TOOL EVIDENCE</span><h2>从代码声明走到真实调用</h2><p>扫描仓库后，独立画布会展示稳定 identity、Host 目录读取授权、运行注册、实际调用及参数/结果边界。</p><div><CircleDashed size={13} aria-hidden="true" />未发生的运行阶段会明确保留为空缺节点</div></section>
        )}
      </main>
      <ToolCatalogInspector projection={projection} selectedTool={selectedTool} selection={selection} onOpenRuntimeEvent={onOpenRuntimeEvent} />
    </section>
  );
}
