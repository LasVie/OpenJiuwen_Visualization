import {
  Braces,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  Radio,
  Route,
  ShieldCheck,
} from "lucide-react";
import type {
  ToolCatalogSourceReference,
  ToolRegistrationSiteRecord,
} from "../../kernel";
import { SourceViewer } from "../source-viewer";
import type {
  ProjectedToolDefinition,
  ToolCatalogProjection,
  ToolCatalogSelection,
} from "./model";

const stateCopy = {
  "runtime-observed": {
    label: "运行确认",
    note: "当前已载入 Trace 中存在同名 ability.register 事件。",
    icon: CheckCircle2,
  },
  "static-linked": {
    label: "静态注册路径",
    note: "AST 能把至少一个注册调用关联到该声明；不等于本次运行已注册。",
    icon: Route,
  },
  "declared-only": {
    label: "仅声明",
    note: "扫描到 Tool 声明，但没有解析出直接关联的注册调用。",
    icon: CircleDashed,
  },
} as const;

const mechanismLabel: Record<ToolRegistrationSiteRecord["mechanism"], string> = {
  "ability-card": "AbilityManager.add(card)",
  "ability-resource": "AbilityManager.add_ability(card, resource)",
  "resource-manager": "Runner.resource_mgr.add_tool(tool)",
  "ownership-helper": "register_tool(tool, owner)",
};

function SourceLocation({ repositoryPath, source }: {
  repositoryPath: string;
  source: ToolCatalogSourceReference;
}) {
  return (
    <section className="tool-inspector__source">
      <span><FileCode2 size={13} />源码证据</span>
      <code>{source.path}:{source.symbol}</code>
      <small>L{source.startLine}{source.endLine !== source.startLine ? `–${source.endLine}` : ""}</small>
      <SourceViewer repositoryPath={repositoryPath} source={source} />
    </section>
  );
}

function ToolDetail({ item, repositoryPath }: {
  item: ProjectedToolDefinition;
  repositoryPath: string;
}) {
  const copy = stateCopy[item.state];
  const StateIcon = copy.icon;
  const card = item.tool.card;
  return (
    <>
      <header className={`tool-inspector__header tool-inspector__header--${item.tool.owner}`}>
        <span><Braces size={18} /></span>
        <div>
          <small>TOOL DEFINITION</small>
          <strong>{item.tool.name}</strong>
          <code>{item.tool.symbol}</code>
        </div>
      </header>
      <div className="tool-inspector__scroll">
        <section className={`tool-inspector__state tool-inspector__state--${item.state}`}>
          <StateIcon size={16} />
          <div><strong>{copy.label}</strong><p>{copy.note}</p></div>
        </section>
        <p className="tool-inspector__description">{card.description || item.tool.summary}</p>
        <dl className="tool-inspector__facts">
          <div><dt>owner</dt><dd>{item.tool.owner}</dd></div>
          <div><dt>kind</dt><dd>{item.tool.kind}</dd></div>
          <div><dt>exposure</dt><dd>{card.exposure}</dd></div>
          <div><dt>name source</dt><dd>{card.nameSource}</dd></div>
          <div><dt>stateless</dt><dd>{card.stateless === null ? "unknown" : String(card.stateless)}</dd></div>
          <div><dt>parallel safe</dt><dd>{card.parallelSafe === null ? "unknown" : String(card.parallelSafe)}</dd></div>
          <div><dt>idempotent</dt><dd>{card.idempotent === null ? "unknown" : String(card.idempotent)}</dd></div>
        </dl>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title">
            <span>参数</span><em>{card.parameters.length}</em>
          </div>
          <div className="tool-inspector__chips">
            {card.parameters.length
              ? card.parameters.map((parameter) => <code key={parameter}>{parameter}</code>)
              : <span>未静态提取参数</span>}
          </div>
        </section>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title">
            <span>注册路径</span><em>{item.registrationSites.length}</em>
          </div>
          {item.registrationSites.map((site) => (
            <article key={site.id} className="tool-inspector__path-card">
              <strong>{mechanismLabel[site.mechanism]}</strong>
              <code>{site.source.path}:L{site.source.startLine}</code>
              <span>{site.confidence} · {site.targetExpression || "dynamic"}</span>
            </article>
          ))}
          {!item.registrationSites.length ? <p className="tool-inspector__empty">无可关联静态路径。</p> : null}
        </section>
        <section className="tool-inspector__section">
          <div className="tool-inspector__section-title">
            <span>运行确认</span><em>{item.observations.length}</em>
          </div>
          {item.observations.map((runtime) => (
            <article key={runtime.id} className="tool-inspector__runtime-card">
              <Radio size={13} />
              <div><strong>{runtime.name}</strong><span>seq {runtime.sequence} · {runtime.ownerId ?? "agent"}</span></div>
            </article>
          ))}
          {!item.observations.length ? <p className="tool-inspector__empty">当前 Trace 未观察到同名 ability.register。</p> : null}
        </section>
        <SourceLocation repositoryPath={repositoryPath} source={item.tool.source} />
      </div>
    </>
  );
}

export function ToolCatalogInspector({
  projection,
  selectedTool,
  selection,
}: {
  projection: ToolCatalogProjection | null;
  selectedTool: ProjectedToolDefinition | null;
  selection: ToolCatalogSelection | null;
}) {
  if (!projection || !selectedTool) {
    return (
      <aside className="tool-inspector tool-inspector--empty">
        <ShieldCheck size={22} />
        <strong>Tool 详情</strong>
        <p>扫描仓库后选择 Tool，查看 Card 属性、注册路径和运行确认。</p>
      </aside>
    );
  }
  if (selection?.kind === "registration") {
    const site = projection.sitesById.get(selection.id);
    if (site) return (
      <aside className="tool-inspector">
        <header className="tool-inspector__header tool-inspector__header--path">
          <span><Route size={18} /></span>
          <div><small>REGISTRATION PATH</small><strong>{mechanismLabel[site.mechanism]}</strong><code>{site.container || site.callee}</code></div>
        </header>
        <div className="tool-inspector__scroll">
          <section className={`tool-inspector__state tool-inspector__state--${site.confidence}`}>
            <Route size={16} />
            <div><strong>{site.confidence.toUpperCase()}</strong><p>{site.confidence === "dynamic" ? "注册目标依赖运行时变量，静态扫描不猜测具体 Tool。" : "注册调用已与当前 Tool 声明建立静态关联。"}</p></div>
          </section>
          <dl className="tool-inspector__facts tool-inspector__facts--wide">
            <div><dt>callee</dt><dd>{site.callee}</dd></div>
            <div><dt>target</dt><dd>{site.targetExpression || "dynamic"}</dd></div>
            <div><dt>candidates</dt><dd>{site.candidateNames.join(", ") || "none"}</dd></div>
            <div><dt>resolved</dt><dd>{site.resolvedToolIds.length}</dd></div>
          </dl>
          <SourceLocation
            repositoryPath={projection.catalog.repository.path}
            source={site.source}
          />
        </div>
      </aside>
    );
  }
  if (selection?.kind === "runtime") {
    const runtime = projection.observations.find((item) => item.id === selection.id);
    if (runtime) return (
      <aside className="tool-inspector">
        <header className="tool-inspector__header tool-inspector__header--runtime">
          <span><Radio size={18} /></span>
          <div><small>RUNTIME CONFIRMATION</small><strong>{runtime.name}</strong><code>ability.register · seq {runtime.sequence}</code></div>
        </header>
        <div className="tool-inspector__scroll">
          <section className="tool-inspector__state tool-inspector__state--runtime-observed">
            <CheckCircle2 size={16} /><div><strong>运行已观察</strong><p>该记录来自当前内存 Trace，不代表其他 Agent 或其他会话。</p></div>
          </section>
          <dl className="tool-inspector__facts tool-inspector__facts--wide">
            <div><dt>ability type</dt><dd>{runtime.abilityType}</dd></div>
            <div><dt>owner</dt><dd>{runtime.ownerId ?? "not supplied"}</dd></div>
            <div><dt>source</dt><dd>{runtime.source ?? "not supplied"}</dd></div>
            <div><dt>timestamp</dt><dd>t+{runtime.timestampMs}ms</dd></div>
          </dl>
        </div>
      </aside>
    );
  }
  return (
    <aside className="tool-inspector">
      <ToolDetail
        item={selectedTool}
        repositoryPath={projection.catalog.repository.path}
      />
    </aside>
  );
}
