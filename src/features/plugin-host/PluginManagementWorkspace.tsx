import { useState } from "react";
import { Boxes, ServerCog, WifiOff } from "lucide-react";
import type { ResolvedPluginStatus } from "../../kernel";
import { PluginControlWorkspace } from "../plugin-control";
import { PluginHostWorkspace } from "./PluginHostWorkspace";
import type { PluginHostController } from "./use-plugin-host";

interface PluginManagementWorkspaceProps {
  plugins: readonly ResolvedPluginStatus[];
  hasOverrides: boolean;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onReset: () => void;
  host: PluginHostController;
}

export function PluginManagementWorkspace({
  plugins,
  hasOverrides,
  onSetEnabled,
  onReset,
  host,
}: PluginManagementWorkspaceProps) {
  const [plane, setPlane] = useState<"browser" | "host">("host");

  return (
    <section className="plugin-management-workspace">
      <nav className="plugin-management-tabs" aria-label="模块控制平面">
        <div>
          <button
            type="button"
            className={plane === "browser" ? "plugin-management-tab--active" : ""}
            onClick={() => setPlane("browser")}
            aria-pressed={plane === "browser"}
          >
            <Boxes size={15} strokeWidth={1.9} aria-hidden="true" />
            <span><strong>工作台模块</strong><small>BROWSER CONTRIBUTIONS</small></span>
          </button>
          <button
            type="button"
            className={plane === "host" ? "plugin-management-tab--active" : ""}
            onClick={() => setPlane("host")}
            aria-pressed={plane === "host"}
          >
            <ServerCog size={15} strokeWidth={1.9} aria-hidden="true" />
            <span><strong>Local Plugin Host</strong><small>LIFECYCLE · PERMISSIONS · AUDIT</small></span>
          </button>
        </div>
        <span className={`plugin-host-connection plugin-host-connection--${host.connection}`}>
          {host.connection === "offline" ? <WifiOff size={12} /> : <i />}
          {host.connection === "loading"
            ? "连接中"
            : host.connection === "ready"
              ? "HOST ONLINE"
              : "HOST OFFLINE"}
        </span>
      </nav>

      {plane === "browser" ? (
        <PluginControlWorkspace
          plugins={plugins}
          hasOverrides={hasOverrides}
          onSetEnabled={onSetEnabled}
          onReset={onReset}
        />
      ) : (
        <PluginHostWorkspace controller={host} />
      )}
    </section>
  );
}

