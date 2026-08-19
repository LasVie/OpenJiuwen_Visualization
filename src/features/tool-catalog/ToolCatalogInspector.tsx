import { useEffect, useState } from "react";
import {
  Braces,
  CheckCircle2,
  CircleDashed,
  Eye,
  EyeOff,
  FileCode2,
  LocateFixed,
  Play,
  Radio,
  Route,
  ShieldCheck,
} from "lucide-react";
import type {
  RuntimeTraceEvent,
  ToolCatalogSourceReference,
  ToolRegistrationSiteRecord,
} from "../../kernel";
import { SourceViewer } from "../source-viewer";
import type {
  ProjectedToolDefinition,
  RuntimeEvidenceMatchKind,
  RuntimeToolCallEvidence,
  RuntimeToolRegistrationEvidence,
  ToolCatalogProjection,
  ToolCatalogSelection,
  ToolEvidenceStage,
  ToolHostAuthorizationEvidence,
} from "./model";

const mechanismLabel: Record<ToolRegistrationSiteRecord["mechanism"], string> = {
  "ability-card": "AbilityManager.add(card)",
  "ability-resource": "AbilityManager.add_ability(card, resource)",
  "resource-manager": "Runner.resource_mgr.add_tool(tool)",
  "ownership-helper": "register_tool(tool, owner)",
};

const stageCopy: Record<ToolEvidenceStage, { label: string; note: string }> = {
  discovered: { label: "代码发现", note: "AST 扫描得到声明与 revision 绑定的稳定 identity。" },
  authorized: { label: "目录授权", note: "Host 只授权读取 Tool Catalog，不代表 Tool 可执行。" },
  registered: { label: "运行注册", note: "当前 Trace 中出现可对齐的 ability.register。" },
  called: { label: "实际调用", note: "当前 Trace 中出现可对齐的 tool.call。" },
};

const matchLabel: Record<RuntimeEvidenceMatchKind, string> = {
  "source-exact": "SOURCE EXACT",
  "source-unverified": "SOURCE · NO REVISION",
  "name-unique": "NAME UNIQUE",
  ambiguous: "AMBIGUOUS",
  unmatched: "UNMATCHED",
};

function SourceLocation({ repositoryPath, source }: {
  repositoryPath: string;
  source: ToolCatalogSourceReference;
}) {
  return (
    <section className="tool-inspector__source">
      <span><FileCode2 size={13} aria-hidden="true" />源码证据</span>
      <code>{source.path}:{source.symbol}</code>
      <small>L{source.startLine}{source.endLine !== source.startLine ? `–${source.endLine}` : ""}</small>
      <SourceViewer repositoryPath={repositoryPath} source={source} />
    </section>
  );
}

function EvidenceStrip({ item }: { item: ProjectedToolDefinition }) {
  const availability: Record<ToolEvidenceStage, boolean> = {
    discovered: true,
    authorized: item.authorization.state === "authorized",
    registered: item.registrations.length > 0,
    called: item.calls.length > 0,
  };
  return (
    <section className="tool-inspector__evidence-strip" aria-label="Tool 四层证据">
      {(Object.keys(stageCopy) as ToolEvidenceStage[]).map((stage, index) => (
        <div key={stage} className={availability[stage] ? "is-present" : "is-missing"}>
          <span>{availability[stage] ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleDashed size={12} aria-hidden="true" />}</span>
          <small>0{index + 1}</small>
          <strong>{stageCopy[stage].label}</strong>
        </div>
      ))}
    </section>
  );
}

function ToolDetail({ item, repositoryPath }: {
  item: ProjectedToolDefinition;
  repositoryPath: string;
}) {
  const card = item.tool.card;
  return (
    <>
      <header className={`tool-inspector__header tool-inspector__header--${item.tool.owner}`}>
        <span><Braces size={18} aria-hidden="true" /></span>
        <div>
          <small>TOOL IDENTITY · {item.state.toUpperCase()}</small>
          <strong>{item.tool.name}</strong>
          <code>{item.tool.symbol}</code>
        </div>
      </header>
      <div className="tool-inspector__scroll">
        <EvidenceStrip item={item} />
        <section className={`tool-inspector__state tool-inspector__state--${item.state}`}>
          <CheckCircle2 size={16} aria-hidden="true" />
          <div><strong>{stageCopy[item.state].label}</strong><p>{stageCopy[item.state].note}</p></div>
        </section>
        <p className="tool-inspector__description">{card.description || item.tool.summary}</p>
        <dl className="tool-inspector__facts">
          <div><dt>owner</dt><dd>{item.tool.owner}</dd></div>
          <div><dt>kind</dt><dd>{item.tool.kind}</dd></div>
          <div><dt>revision</dt><dd>{item.identity.revision.slice(0, 12)}</dd></div>
          <div><dt>exposure</dt><dd>{card.exposure}</dd></div>
          <div><dt>stateless</dt><dd>{card.stateless === null ? "unknown" : String(card.stateless)}</dd></div>
          <div><dt>parallel safe</dt><dd>{card.parallelSafe === null ? "unknown" : String(card.parallelSafe)}</dd></div>
        </dl>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title"><span>稳定 Identity</span></div>
          <code className="tool-inspector__identity">{item.identity.key}</code>
        </section>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title"><span>参数</span><em>{card.parameters.length}</em></div>
          <div className="tool-inspector__chips">
            {card.parameters.length
              ? card.parameters.map((parameter) => <code key={parameter}>{parameter}</code>)
              : <span>未静态提取参数</span>}
          </div>
        </section>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title"><span>证据数量</span></div>
          <dl className="tool-inspector__facts">
            <div><dt>static paths</dt><dd>{item.registrationSites.length}</dd></div>
            <div><dt>runtime register</dt><dd>{item.registrations.length}</dd></div>
            <div><dt>tool calls</dt><dd>{item.calls.length}</dd></div>
            <div><dt>context owner</dt><dd>{item.calls[0]?.contextOwnerId ?? item.registrations[0]?.contextOwnerId ?? "not supplied"}</dd></div>
          </dl>
        </section>
        <SourceLocation repositoryPath={repositoryPath} source={item.tool.source} />
      </div>
    </>
  );
}

function AuthorizationDetail({ authorization }: { authorization: ToolHostAuthorizationEvidence }) {
  return (
    <>
      <header className="tool-inspector__header tool-inspector__header--authorization">
        <span><ShieldCheck size={18} aria-hidden="true" /></span>
        <div><small>HOST CATALOG AUTHORIZATION</small><strong>目录读取授权</strong><code>{authorization.permissionId}</code></div>
      </header>
      <div className="tool-inspector__scroll">
        <section className={`tool-inspector__state tool-inspector__state--${authorization.state}`}>
          <ShieldCheck size={16} aria-hidden="true" />
          <div><strong>{authorization.state.toUpperCase()}</strong><p>{authorization.diagnosticMessage}</p></div>
        </section>
        <div className="tool-inspector__boundary-note">
          <strong>边界说明</strong>
          <p>这项证据只说明 Host 允许插件读取本地 Tool Catalog。它不授予 Tool 执行权限，也不证明 Tool 已注册或已调用。</p>
        </div>
        <dl className="tool-inspector__facts tool-inspector__facts--wide">
          <div><dt>plugin</dt><dd>{authorization.pluginId}</dd></div>
          <div><dt>scope</dt><dd>{authorization.scope}</dd></div>
          <div><dt>permission granted</dt><dd>{String(authorization.permissionGranted)}</dd></div>
          <div><dt>capability present</dt><dd>{String(authorization.capabilityPresent)}</dd></div>
          <div><dt>diagnostic</dt><dd>{authorization.diagnosticCode}</dd></div>
        </dl>
      </div>
    </>
  );
}

function RegistrationDetail({
  registration,
  onOpenRuntimeEvent,
}: {
  registration: RuntimeToolRegistrationEvidence;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
}) {
  return (
    <>
      <header className="tool-inspector__header tool-inspector__header--registration">
        <span><Radio size={18} aria-hidden="true" /></span>
        <div><small>RUNTIME REGISTRATION</small><strong>{registration.name}</strong><code>ability.register · seq {registration.sequence}</code></div>
      </header>
      <div className="tool-inspector__scroll">
        <section className="tool-inspector__state tool-inspector__state--registered">
          <CheckCircle2 size={16} aria-hidden="true" />
          <div><strong>当前 Trace 已观察</strong><p>只对当前 trace、owner 与 context owner 有效。</p></div>
        </section>
        <div className={`tool-inspector__match tool-inspector__match--${registration.match.kind}`}>
          <strong>{matchLabel[registration.match.kind]}</strong><p>{registration.match.note}</p>
        </div>
        <dl className="tool-inspector__facts tool-inspector__facts--wide">
          <div><dt>trace</dt><dd>{registration.traceId}</dd></div>
          <div><dt>owner</dt><dd>{registration.ownerLabel ?? registration.ownerId ?? "not supplied"}</dd></div>
          <div><dt>context owner</dt><dd>{registration.contextOwnerId ?? "not supplied"}</dd></div>
          <div><dt>ability type</dt><dd>{registration.abilityType}</dd></div>
          <div><dt>timestamp</dt><dd>t+{registration.timestampMs}ms</dd></div>
        </dl>
        <button className="tool-inspector__locate" type="button" onClick={() => onOpenRuntimeEvent(registration.event)}>
          <LocateFixed size={14} aria-hidden="true" />定位到运行步骤
        </button>
      </div>
    </>
  );
}

function CallDetail({
  call,
  onOpenRuntimeEvent,
}: {
  call: RuntimeToolCallEvidence;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  useEffect(() => setRawOpen(false), [call.id]);
  return (
    <>
      <header className="tool-inspector__header tool-inspector__header--call">
        <span><Play size={18} aria-hidden="true" /></span>
        <div><small>RUNTIME TOOL CALL</small><strong>{call.name}</strong><code>{call.status} · seq {call.startSequence}</code></div>
      </header>
      <div className="tool-inspector__scroll">
        <section className={`tool-inspector__state tool-inspector__state--${call.status}`}>
          <Play size={16} aria-hidden="true" />
          <div><strong>{call.status.toUpperCase()}</strong><p>{call.durationMs === undefined ? "调用仍在运行或没有终态。" : `本次调用耗时 ${call.durationMs} ms。`}</p></div>
        </section>
        <div className={`tool-inspector__match tool-inspector__match--${call.match.kind}`}>
          <strong>{matchLabel[call.match.kind]}</strong><p>{call.match.note}</p>
        </div>
        <dl className="tool-inspector__facts tool-inspector__facts--wide">
          <div><dt>trace / span</dt><dd>{call.traceId} / {call.spanId}</dd></div>
          <div><dt>owner</dt><dd>{call.ownerLabel ?? call.ownerId ?? "not supplied"}</dd></div>
          <div><dt>context owner</dt><dd>{call.contextOwnerId ?? "not supplied"}</dd></div>
          <div><dt>sequence</dt><dd>{call.startSequence}{call.endSequence ? ` → ${call.endSequence}` : " → running"}</dd></div>
        </dl>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title"><span>参数</span><em>{rawOpen ? "RAW" : "REDACTED"}</em></div>
          <pre className="tool-inspector__payload">{rawOpen ? call.rawArguments ?? "未提供" : call.argumentsPreview ?? "未提供"}</pre>
        </section>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title"><span>{call.rawError ? "错误" : "结果"}</span><em>{rawOpen ? "RAW" : "REDACTED"}</em></div>
          <pre className={`tool-inspector__payload ${call.rawError ? "tool-inspector__payload--error" : ""}`}>{rawOpen ? call.rawError ?? call.rawResult ?? "未提供" : call.resultPreview ?? "未提供"}</pre>
        </section>
        <button className="tool-inspector__raw-toggle" type="button" aria-pressed={rawOpen} onClick={() => setRawOpen((value) => !value)}>
          {rawOpen ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
          {rawOpen ? "收起本次原文" : "展开本次原文"}
        </button>
        <p className="tool-inspector__raw-note">默认只展示脱敏摘要；原始参数与结果仅在本机界面显式展开。</p>
        <button className="tool-inspector__locate" type="button" onClick={() => onOpenRuntimeEvent(call.startEvent)}>
          <LocateFixed size={14} aria-hidden="true" />定位到运行步骤
        </button>
      </div>
    </>
  );
}

export function ToolCatalogInspector({
  projection,
  selectedTool,
  selection,
  onOpenRuntimeEvent,
}: {
  projection: ToolCatalogProjection | null;
  selectedTool: ProjectedToolDefinition | null;
  selection: ToolCatalogSelection | null;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
}) {
  if (!projection || !selectedTool) {
    return (
      <aside className="tool-inspector tool-inspector--empty">
        <ShieldCheck size={22} aria-hidden="true" />
        <strong>Tool 证据详情</strong>
        <p>扫描仓库后选择 Tool，查看四层证据、源码和运行步骤。</p>
      </aside>
    );
  }
  if (selection?.kind === "authorization") {
    return <aside className="tool-inspector"><AuthorizationDetail authorization={selectedTool.authorization} /></aside>;
  }
  if (selection?.kind === "registration-path") {
    const site = projection.sitesById.get(selection.id);
    if (site) return (
      <aside className="tool-inspector">
        <header className="tool-inspector__header tool-inspector__header--path">
          <span><Route size={18} aria-hidden="true" /></span>
          <div><small>STATIC REGISTRATION PATH</small><strong>{mechanismLabel[site.mechanism]}</strong><code>{site.container || site.callee}</code></div>
        </header>
        <div className="tool-inspector__scroll">
          <section className={`tool-inspector__state tool-inspector__state--${site.confidence}`}>
            <Route size={16} aria-hidden="true" />
            <div><strong>{site.confidence.toUpperCase()}</strong><p>{site.confidence === "dynamic" ? "注册目标依赖运行时变量，静态扫描不猜测具体 Tool。" : "这是源码路径证据，不等于本次运行已经注册。"}</p></div>
          </section>
          <dl className="tool-inspector__facts tool-inspector__facts--wide">
            <div><dt>callee</dt><dd>{site.callee}</dd></div>
            <div><dt>target</dt><dd>{site.targetExpression || "dynamic"}</dd></div>
            <div><dt>candidates</dt><dd>{site.candidateNames.join(", ") || "none"}</dd></div>
            <div><dt>resolved</dt><dd>{site.resolvedToolIds.length}</dd></div>
          </dl>
          <SourceLocation repositoryPath={projection.catalog.repository.path} source={site.source} />
        </div>
      </aside>
    );
  }
  if (selection?.kind === "runtime-registration") {
    const registration = projection.registrationsById.get(selection.id);
    if (registration) return <aside className="tool-inspector"><RegistrationDetail registration={registration} onOpenRuntimeEvent={onOpenRuntimeEvent} /></aside>;
  }
  if (selection?.kind === "runtime-call") {
    const call = projection.callsById.get(selection.id);
    if (call) return <aside className="tool-inspector"><CallDetail call={call} onOpenRuntimeEvent={onOpenRuntimeEvent} /></aside>;
  }
  return (
    <aside className="tool-inspector">
      <ToolDetail item={selectedTool} repositoryPath={projection.catalog.repository.path} />
    </aside>
  );
}
