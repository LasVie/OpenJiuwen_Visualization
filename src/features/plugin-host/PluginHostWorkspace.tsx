import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleOff,
  Clock3,
  Database,
  Eye,
  FileKey2,
  KeyRound,
  Network,
  PlugZap,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import type {
  PluginHostPermission,
  PluginHostPlugin,
} from "../../adapters/plugin-host";
import type { PluginHostController } from "./use-plugin-host";

interface PluginHostWorkspaceProps {
  controller: PluginHostController;
}

const statusLabel = {
  active: "运行中",
  blocked: "等待授权",
  disabled: "已关闭",
} as const;

const groupLabel = {
  provider: "MODEL PROVIDER",
  tool: "TOOL REGISTRY",
  integration: "INTEGRATION",
  workspace: "WORKSPACE",
} as const;

const permissionPresentation = {
  read: { label: "只读", icon: Eye },
  network: { label: "网络", icon: Network },
  secret: { label: "凭据句柄", icon: KeyRound },
  write: { label: "写操作", icon: FileKey2 },
} as const;

function statusIcon(status: PluginHostPlugin["status"]) {
  if (status === "active") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === "blocked") return <ShieldAlert size={13} aria-hidden="true" />;
  return <CircleOff size={13} aria-hidden="true" />;
}

function permissionPolicy(permission: PluginHostPermission) {
  if (permission.grantMode === "per-operation") return "每次操作确认";
  if (permission.grantMode === "install") return "安装时固定";
  return "可随时撤销";
}

function auditLabel(action: string) {
  if (action === "plugin.state.changed") return "生命周期变更";
  if (action === "plugin.permission.changed") return "权限变更";
  return action;
}

export function PluginHostWorkspace({ controller }: PluginHostWorkspaceProps) {
  const plugins = controller.snapshot?.plugins ?? [];
  const [selectedId, setSelectedId] = useState("");
  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? plugins[0];
  const audit = useMemo(
    () => [...controller.auditEvents].reverse(),
    [controller.auditEvents],
  );

  async function toggleLifecycle(plugin: PluginHostPlugin, enabled: boolean) {
    let confirmed = false;
    if (enabled && plugin.trust.level === "unsigned-local") {
      confirmed = window.confirm(
        `确认启用未签名本地插件“${plugin.name}”？\n\n` +
        "V1 只读取声明，不执行插件代码；权限仍需逐项授权。",
      );
      if (!confirmed) return;
    }
    await controller.setEnabled(plugin.id, enabled, confirmed);
  }

  if (controller.connection === "offline" && !controller.snapshot) {
    return (
      <section className="plugin-host-empty" role="alert">
        <ServerCog size={28} strokeWidth={1.6} aria-hidden="true" />
        <h1>Local Plugin Host 不可达</h1>
        <p>{controller.error}</p>
        <button type="button" onClick={() => void controller.refresh()}>
          <RefreshCw size={14} aria-hidden="true" />重新连接
        </button>
      </section>
    );
  }

  if (!controller.snapshot) {
    return (
      <section className="plugin-host-empty" role="status">
        <Activity className="spin" size={26} aria-hidden="true" />
        <h1>正在读取本地 Host 注册表</h1>
        <p>加载生命周期、权限、Opaque Secret Handle 与本机审计。</p>
      </section>
    );
  }

  const activeCount = plugins.filter((plugin) => plugin.status === "active").length;
  const blockedCount = plugins.filter((plugin) => plugin.status === "blocked").length;
  const developer = controller.snapshot.developerMode;

  return (
    <section className="plugin-host-workspace">
      <header className="plugin-host-toolbar">
        <div>
          <span><ServerCog size={19} strokeWidth={2} aria-hidden="true" /></span>
          <div><small>PLUGIN HOST API 1.0</small><h1>本地插件与 Provider 控制面</h1></div>
        </div>
        <p>
          <strong>{activeCount}</strong> 运行中
          <span>·</span>
          <strong>{blockedCount}</strong> 等待授权
          <span>·</span>
          SQLite / WAL
        </p>
        <div className="plugin-host-toolbar__policy">
          <ShieldCheck size={14} aria-hidden="true" />
          <span><strong>SECRET HOST-OWNED</strong><small>插件只获得不透明句柄</small></span>
        </div>
      </header>

      {controller.error ? (
        <div className="plugin-host-action-error" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />{controller.error}
        </div>
      ) : null}

      <div className="plugin-host-layout">
        <aside className="plugin-host-registry">
          <header>
            <div><PlugZap size={14} aria-hidden="true" /><strong>已注册插件</strong></div>
            <em>{plugins.length}</em>
          </header>
          <div className="plugin-host-registry__list">
            {plugins.map((plugin) => (
              <button
                type="button"
                key={plugin.id}
                className={[
                  `plugin-host-card plugin-host-card--${plugin.group}`,
                  `plugin-host-card--${plugin.status}`,
                  selected?.id === plugin.id ? "plugin-host-card--selected" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => setSelectedId(plugin.id)}
                aria-pressed={selected?.id === plugin.id}
              >
                <span className="plugin-host-card__topline">
                  <small>{groupLabel[plugin.group]}</small>
                  <i className={`plugin-host-status plugin-host-status--${plugin.status}`}>
                    {statusIcon(plugin.status)}{statusLabel[plugin.status]}
                  </i>
                </span>
                <strong>{plugin.name}</strong>
                <code>{plugin.id}</code>
                <span className="plugin-host-card__meta">
                  <i>{plugin.trust.level === "bundled-trusted" ? "BUNDLED TRUST" : "UNSIGNED LOCAL"}</i>
                  <em>v{plugin.version}</em>
                </span>
              </button>
            ))}
          </div>

          <section className={`plugin-host-developer plugin-host-developer--${developer.enabled ? "on" : "off"}`}>
            <TerminalSquare size={15} aria-hidden="true" />
            <div>
              <strong>Developer manifests {developer.enabled ? "ON" : "OFF"}</strong>
              <p>
                {developer.enabled
                  ? `${developer.authorizedRoots.length} 个显式路径作用域；V1 不执行第三方代码。`
                  : "启动服务时显式添加参数后才会发现未签名本地声明。"}
              </p>
            </div>
          </section>
        </aside>

        {selected ? (
          <main className={`plugin-host-inspector plugin-host-inspector--${selected.group}`}>
            <header className="plugin-host-inspector__identity">
              <div>
                <span>{groupLabel[selected.group]}</span>
                <h2>{selected.name}</h2>
                <code>{selected.id}</code>
              </div>
              <label className="plugin-host-lifecycle">
                <span>
                  <strong>{selected.requestedEnabled ? "生命周期已开启" : "生命周期已关闭"}</strong>
                  <small>{selected.runtime.mode}</small>
                </span>
                <input
                  type="checkbox"
                  checked={selected.requestedEnabled}
                  disabled={controller.mutationKey !== null}
                  onChange={(event) => void toggleLifecycle(selected, event.target.checked)}
                />
                <i aria-hidden="true"><b /></i>
              </label>
            </header>

            <p className="plugin-host-inspector__description">{selected.description}</p>

            {selected.status === "blocked" ? (
              <div className="plugin-host-blocked">
                <ShieldAlert size={16} aria-hidden="true" />
                <div><strong>Host 已阻止服务能力</strong><p>{selected.diagnostic.message}</p></div>
              </div>
            ) : null}

            <section className="plugin-host-section">
              <header><div><ShieldCheck size={14} aria-hidden="true" /><h3>信任与运行边界</h3></div></header>
              <div className="plugin-host-facts">
                <span><small>TRUST</small><strong>{selected.trust.level}</strong></span>
                <span><small>RUNTIME</small><strong>{selected.runtime.mode}</strong></span>
                <span><small>ISOLATION</small><strong>{selected.runtime.processIsolation}</strong></span>
                <span><small>INTEGRITY</small><code>{selected.source.integrity.slice(0, 24)}…</code></span>
              </div>
              <p className="plugin-host-source">
                <Database size={12} aria-hidden="true" />
                <span>{selected.source.identity}</span>
              </p>
            </section>

            <section className="plugin-host-section plugin-host-permissions">
              <header>
                <div><FileKey2 size={14} aria-hidden="true" /><h3>权限</h3></div>
                <small>服务端最终授权</small>
              </header>
              <div>
                {selected.permissions.map((permission) => {
                  const presentation = permissionPresentation[permission.kind];
                  const PermissionIcon = presentation.icon;
                  const pending = controller.mutationKey === `${selected.id}:${permission.id}`;
                  return (
                    <article key={permission.id}>
                      <span className={`plugin-host-permission__icon plugin-host-permission__icon--${permission.kind}`}>
                        <PermissionIcon size={15} aria-hidden="true" />
                      </span>
                      <div>
                        <span><strong>{permission.label}</strong><em>{presentation.label}</em></span>
                        <p>{permission.description}</p>
                        <code>{permission.id}</code>
                      </div>
                      <label>
                        <span className="sr-only">
                          {permission.granted ? "撤销" : "授予"}{permission.label}
                        </span>
                        <span className="plugin-host-permission__policy" aria-hidden="true">
                          {pending ? "更新中" : permissionPolicy(permission)}
                        </span>
                        <input
                          type="checkbox"
                          checked={permission.granted}
                          disabled={!permission.revocable || controller.mutationKey !== null}
                          onChange={(event) => void controller.setPermission(
                            selected.id,
                            permission.id,
                            event.target.checked,
                          )}
                        />
                        <i aria-hidden="true"><b /></i>
                      </label>
                    </article>
                  );
                })}
              </div>
            </section>

            {selected.secretHandles.length ? (
              <section className="plugin-host-section plugin-host-secrets">
                <header><div><KeyRound size={14} aria-hidden="true" /><h3>Opaque Secret Handle</h3></div><small>不返回原值</small></header>
                {selected.secretHandles.map((handle) => (
                  <article key={handle.id}>
                    <span className={handle.resolved ? "plugin-secret--resolved" : "plugin-secret--missing"}>
                      <i />{handle.resolved ? "已解析" : "未配置"}
                    </span>
                    <code>{handle.id}</code>
                    <p>Host 本机凭据源 · {handle.exposure}</p>
                  </article>
                ))}
              </section>
            ) : null}

            <section className="plugin-host-section plugin-host-capabilities">
              <header><div><Wrench size={14} aria-hidden="true" /><h3>公开能力</h3></div></header>
              <div>{selected.capabilities.map((item) => <code key={item}>{item}</code>)}</div>
            </section>
          </main>
        ) : null}

        <aside className="plugin-host-audit">
          <header>
            <div><Clock3 size={14} aria-hidden="true" /><strong>本机审计</strong></div>
            <span>{controller.snapshot.audit.count}</span>
          </header>
          <p>只记录授权动作、目标与结果，不写入密钥、Prompt 或业务原文。</p>
          <div className="plugin-host-audit__events">
            {audit.length ? audit.map((event) => (
              <article key={event.id}>
                <i />
                <div>
                  <span><strong>{auditLabel(event.action)}</strong><time>{new Date(event.timestampMs).toLocaleTimeString("zh-CN", { hour12: false })}</time></span>
                  <code>{event.pluginId ?? "host"}</code>
                  <p>{event.target} · {event.detailCode}</p>
                </div>
              </article>
            )) : (
              <div className="plugin-host-audit__empty">
                <Clock3 size={20} aria-hidden="true" />
                <strong>暂无授权变更</strong>
                <p>生命周期或权限发生变化后会记录在这里。</p>
              </div>
            )}
          </div>
          <footer>
            <span><Database size={12} aria-hidden="true" />SQLite / WAL</span>
            <span>最多 5,000 条</span>
          </footer>
        </aside>
      </div>
    </section>
  );
}
