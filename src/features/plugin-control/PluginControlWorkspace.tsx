import { useMemo, useState } from "react";
import {
  Box,
  Cable,
  CheckCircle2,
  CircleOff,
  Cpu,
  Database,
  Link2,
  Network,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import type {
  ResolvedPluginStatus,
  VisualizationPluginGroup,
} from "../../kernel";
import { pluginStateLabel, projectPluginModules } from "./model";

interface PluginControlWorkspaceProps {
  plugins: readonly ResolvedPluginStatus[];
  hasOverrides: boolean;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onReset: () => void;
}

const groupPresentation: Record<
  VisualizationPluginGroup,
  { label: string; note: string; icon: typeof Cpu }
> = {
  "agent-core": {
    label: "Agent Core",
    note: "执行内核与模型观测",
    icon: Cpu,
  },
  jiuwenswarm: {
    label: "JiuWenSwarm",
    note: "编排、成员与 Subagent",
    icon: Network,
  },
  integration: {
    label: "Bridge",
    note: "跨仓连接与确定性回放",
    icon: Cable,
  },
  workspace: {
    label: "Workspace",
    note: "仓库、Tool 与 Git 数据面",
    icon: Database,
  },
};

function pluginName(
  plugins: readonly ResolvedPluginStatus[],
  id: string,
) {
  return plugins.find((plugin) => plugin.id === id)?.name ?? id;
}

export function PluginControlWorkspace({
  plugins,
  hasOverrides,
  onSetEnabled,
  onReset,
}: PluginControlWorkspaceProps) {
  const modules = useMemo(() => projectPluginModules(plugins), [plugins]);
  const [selectedId, setSelectedId] = useState(modules[0]?.id ?? "");
  const selected = modules.find((plugin) => plugin.id === selectedId) ?? modules[0];
  const enabledCount = modules.filter((plugin) => plugin.state === "enabled").length;
  const blockedCount = modules.filter((plugin) => plugin.state === "blocked").length;
  const statusById = new Map(modules.map((plugin) => [plugin.id, plugin]));
  const blockingDependencies = selected?.dependencies.filter(
    (id) => statusById.get(id)?.state !== "enabled",
  ) ?? [];

  return (
    <section className="plugin-control-workspace">
      <header className="plugin-control-toolbar">
        <div className="plugin-control-toolbar__title">
          <span aria-hidden="true"><Box size={19} strokeWidth={2} /></span>
          <div>
            <small>MODULE CONTROL PLANE</small>
            <h1>能力模块与依赖</h1>
          </div>
        </div>
        <p>
          <strong>{enabledCount}</strong> 个运行中
          <span aria-hidden="true">·</span>
          <strong>{blockedCount}</strong> 个等待依赖
          <span aria-hidden="true">·</span>
          浏览器偏好；Provider / Tool 开关联动本地 Host
        </p>
        <button
          type="button"
          className="plugin-reset-button"
          onClick={onReset}
          disabled={!hasOverrides}
        >
          <RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
          恢复默认
        </button>
      </header>

      <div className="plugin-control-layout">
        <main className="plugin-switchboard" aria-label="插件模块依赖配电盘">
          <div className="plugin-switchboard__bus" aria-hidden="true">
            <span>PLUGIN API 1.0</span>
            <i />
            <em>DEPENDENCY BUS</em>
          </div>
          <div className="plugin-lanes">
            {(Object.keys(groupPresentation) as VisualizationPluginGroup[]).map(
              (group) => {
                const presentation = groupPresentation[group];
                const GroupIcon = presentation.icon;
                const groupModules = modules.filter(
                  (plugin) => plugin.group === group,
                );
                return (
                  <section className={`plugin-lane plugin-lane--${group}`} key={group}>
                    <header>
                      <GroupIcon size={15} strokeWidth={1.8} aria-hidden="true" />
                      <span>
                        <strong>{presentation.label}</strong>
                        <small>{presentation.note}</small>
                      </span>
                      <em>{groupModules.length}</em>
                    </header>
                    <div className="plugin-lane__modules">
                      {groupModules.map((plugin) => (
                        <article
                          className={[
                            "plugin-module-card",
                            `plugin-module-card--${plugin.state}`,
                            selected?.id === plugin.id
                              ? "plugin-module-card--selected"
                              : "",
                          ].filter(Boolean).join(" ")}
                          key={plugin.id}
                        >
                          <button
                            type="button"
                            className="plugin-module-card__select"
                            onClick={() => setSelectedId(plugin.id)}
                            aria-pressed={selected?.id === plugin.id}
                          >
                            <span className="plugin-module-card__ordinal">
                              {String(plugin.ordinal).padStart(2, "0")}
                            </span>
                            <span className="plugin-module-card__identity">
                              <strong>{plugin.name}</strong>
                              <code>{plugin.id}</code>
                            </span>
                          </button>
                          <label className="plugin-power-switch">
                            <span className="sr-only">
                              {plugin.requestedEnabled ? "关闭" : "开启"}{plugin.name}
                            </span>
                            <input
                              type="checkbox"
                              checked={plugin.requestedEnabled}
                              onChange={(event) =>
                                onSetEnabled(plugin.id, event.target.checked)}
                            />
                            <span aria-hidden="true"><i /></span>
                          </label>
                          <p>{plugin.description}</p>
                          {plugin.dependencies.length ? (
                            <div className="plugin-module-card__dependencies">
                              <Link2 size={11} strokeWidth={1.8} aria-hidden="true" />
                              {plugin.dependencies.map((dependencyId) => (
                                <span key={dependencyId}>
                                  {pluginName(plugins, dependencyId)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="plugin-module-card__dependencies plugin-module-card__dependencies--root">
                              <Cable size={11} strokeWidth={1.8} aria-hidden="true" />
                              根模块
                            </div>
                          )}
                          <footer>
                            <span className={`plugin-state plugin-state--${plugin.state}`}>
                              {plugin.state === "enabled" ? (
                                <CheckCircle2 size={11} aria-hidden="true" />
                              ) : plugin.state === "blocked" ? (
                                <ShieldAlert size={11} aria-hidden="true" />
                              ) : (
                                <CircleOff size={11} aria-hidden="true" />
                              )}
                              {pluginStateLabel(plugin.state)}
                            </span>
                            <span>{plugin.capabilities.length} capabilities</span>
                          </footer>
                        </article>
                      ))}
                    </div>
                  </section>
                );
              },
            )}
          </div>
        </main>

        {selected ? (
          <aside className={`plugin-inspector plugin-inspector--${selected.group}`}>
            <header>
              <span className="plugin-inspector__eyebrow">
                MODULE {String(selected.ordinal).padStart(2, "0")}
              </span>
              <h2>{selected.name}</h2>
              <code>{selected.id}</code>
              <span className={`plugin-state plugin-state--${selected.state}`}>
                {pluginStateLabel(selected.state)}
              </span>
            </header>
            <p className="plugin-inspector__description">{selected.description}</p>

            {selected.state === "blocked" ? (
              <section className="plugin-inspector__alert">
                <ShieldAlert size={16} strokeWidth={1.8} aria-hidden="true" />
                <div>
                  <strong>模块已请求开启，但依赖尚未就绪</strong>
                  <p>
                    启用 {blockingDependencies.map((id) => pluginName(plugins, id)).join("、")}
                    后，本模块会自动恢复。
                  </p>
                </div>
              </section>
            ) : null}

            <section className="plugin-inspector__section">
              <h3>依赖</h3>
              {selected.dependencies.length ? (
                <div className="plugin-inspector__links">
                  {selected.dependencies.map((dependencyId) => {
                    const dependency = statusById.get(dependencyId);
                    return (
                      <button
                        type="button"
                        key={dependencyId}
                        onClick={() => setSelectedId(dependencyId)}
                      >
                        <span>{pluginName(plugins, dependencyId)}</span>
                        <em>{dependency ? pluginStateLabel(dependency.state) : "缺失"}</em>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p>无上游依赖，可独立启停。</p>
              )}
            </section>

            <section className="plugin-inspector__section">
              <h3>下游模块</h3>
              {selected.dependants.length ? (
                <div className="plugin-inspector__links">
                  {selected.dependants.map((dependantId) => {
                    const dependant = statusById.get(dependantId);
                    return (
                      <button
                        type="button"
                        key={dependantId}
                        onClick={() => setSelectedId(dependantId)}
                      >
                        <span>{pluginName(plugins, dependantId)}</span>
                        <em>{dependant ? pluginStateLabel(dependant.state) : "未知"}</em>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p>当前没有模块直接依赖它。</p>
              )}
            </section>

            <section className="plugin-inspector__section plugin-inspector__capabilities">
              <h3>公开能力</h3>
              <div>
                {selected.capabilities.map((capability) => (
                  <code key={capability}>{capability}</code>
                ))}
              </div>
            </section>

            <footer className="plugin-inspector__footer">
              <span>v{selected.version}</span>
              <span>{selected.defaultEnabled ? "默认开启" : "默认关闭"}</span>
            </footer>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
