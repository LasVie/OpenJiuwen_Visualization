import { Braces, Database } from "lucide-react";
import { useState } from "react";
import type { RuntimeTraceEvent } from "../../kernel";
import { RepositoryWorkspace } from "../repository-browser";
import { ToolCatalogWorkspace } from "../tool-catalog";

interface DefinitionWorkspaceProps {
  runtimeEvents: readonly RuntimeTraceEvent[];
  magnetEnabled: boolean;
  magnetStrength: number;
  onToggleMagnet: () => void;
  onMagnetStrengthChange: (strength: number) => void;
}

export function DefinitionWorkspace(props: DefinitionWorkspaceProps) {
  const [view, setView] = useState<"architecture" | "tools">("architecture");
  return (
    <section className="definition-workbench">
      <nav className="definition-workbench__tabs" aria-label="定义图模块">
        <button type="button" className={view === "architecture" ? "active" : ""} aria-pressed={view === "architecture"} onClick={() => setView("architecture")}>
          <Database size={14} /><span><strong>代码定义</strong><small>AST GRAPH</small></span>
        </button>
        <button type="button" className={view === "tools" ? "active" : ""} aria-pressed={view === "tools"} onClick={() => setView("tools")}>
          <Braces size={14} /><span><strong>Tool 注册表</strong><small>REGISTRY</small></span>
        </button>
        <p>{view === "architecture" ? "仓库 → Package → Module → Symbol" : "声明 → 静态注册路径 → 运行确认"}</p>
      </nav>
      {view === "architecture" ? (
        <RepositoryWorkspace
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
