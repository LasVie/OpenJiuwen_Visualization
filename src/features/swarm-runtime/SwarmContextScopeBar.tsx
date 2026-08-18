import { MessagesSquare, Split } from "lucide-react";
import type { SwarmContextScope } from "./model";

interface SwarmContextScopeBarProps {
  scopes: readonly SwarmContextScope[];
  activeId: string | null;
  activeTokenUsed: number;
  onChange: (contextOwnerId: string) => void;
}

export function SwarmContextScopeBar({
  scopes,
  activeId,
  activeTokenUsed,
  onChange,
}: SwarmContextScopeBarProps) {
  const active = scopes.find((scope) => scope.id === activeId);
  return (
    <section className="swarm-context-scope" aria-label="Swarm Context 所有权">
      <div className="swarm-context-scope__title">
        <Split size={15} strokeWidth={1.8} aria-hidden="true" />
        <span><small>CONTEXT OWNERS</small><strong>独立上下文</strong></span>
      </div>
      <label>
        <span className="sr-only">选择 Context owner</span>
        <MessagesSquare size={14} aria-hidden="true" />
        <select
          value={activeId ?? ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={scopes.length === 0}
        >
          {scopes.length === 0 ? <option value="">等待 context.ownerId</option> : null}
          {scopes.map((scope) => (
            <option value={scope.id} key={scope.id}>
              {scope.label} · {scope.kind} · {scope.messageCount} messages
            </option>
          ))}
        </select>
      </label>
      <div className="swarm-context-scope__metrics">
        <span>{scopes.length} owners</span>
        <span>{active ? activeTokenUsed : 0} tokens</span>
        <code>{active?.id ?? "unassigned"}</code>
      </div>
    </section>
  );
}
