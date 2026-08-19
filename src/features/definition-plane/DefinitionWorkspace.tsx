import { Braces, Database } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  GraphSourceReference,
  RuntimeTraceEvent,
} from "../../kernel";
import type { PluginHostSnapshot } from "../../adapters/plugin-host";
import type { PluginHostConnection } from "../plugin-host";
import { RepositoryWorkspace } from "../repository-browser";
import type { SourceNavigationRequest } from "../source-convergence";
import { ToolCatalogWorkspace } from "../tool-catalog";

interface DefinitionWorkspaceProps {
  runtimeEvents: readonly RuntimeTraceEvent[];
  sourceNavigation: SourceNavigationRequest | null;
  onOpenRuntimeEvent: (event: RuntimeTraceEvent) => void;
  onOpenChange?: (source: GraphSourceReference) => void;
  pluginHostSnapshot: PluginHostSnapshot | null;
  pluginHostConnection: PluginHostConnection;
  toolsEnabled: boolean;
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function DefinitionWorkspace(props: DefinitionWorkspaceProps) {
  const [view, setView] = useState<"architecture" | "tools">("architecture");
  useEffect(() => {
    if (props.sourceNavigation) setView("architecture");
  }, [props.sourceNavigation]);
  return (
    <section className="definition-workbench">
      <nav className="definition-workbench__tabs" aria-label="定义图模块">
        <button type="button" className={view === "architecture" ? "active" : ""} aria-pressed={view === "architecture"} onClick={() => setView("architecture")}>
          <Database size={14} /><span><strong>代码定义</strong><small>AST GRAPH</small></span>
        </button>
        <button type="button" className={view === "tools" ? "active" : ""} aria-pressed={view === "tools"} onClick={() => setView("tools")} disabled={!props.toolsEnabled}>
          <Braces size={14} /><span><strong>Tool 注册表</strong><small>{props.toolsEnabled ? "REGISTRY" : "MODULE OFF"}</small></span>
        </button>
        <p>{view === "architecture" ? "仓库 → Package → Module → Symbol" : "发现 → 目录授权 → 运行注册 → 实际调用"}</p>
      </nav>
      {view === "architecture" ? (
        <RepositoryWorkspace
          runtimeEvents={props.runtimeEvents}
          sourceNavigation={props.sourceNavigation}
          onOpenRuntimeEvent={props.onOpenRuntimeEvent}
          onOpenChange={props.onOpenChange}
          magnetEnabled={props.magnetEnabled}
          magnetStrength={props.magnetStrength}
          onToggleMagnet={props.onToggleMagnet}
          onMagnetStrengthChange={props.onMagnetStrengthChange}
        />
      ) : (
        <ToolCatalogWorkspace {...props} />
      )}
    </section>
  );
}
