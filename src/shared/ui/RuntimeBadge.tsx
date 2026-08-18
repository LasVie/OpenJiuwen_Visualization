import { Boxes, Orbit } from "lucide-react";
import { ownerClassName, runtimeOwners } from "../../domain/runtime/ownership";
import type { RuntimeOwner } from "../../types/trace";

interface RuntimeBadgeProps {
  owner: RuntimeOwner;
  compact?: boolean;
}

export function RuntimeBadge({ owner, compact = false }: RuntimeBadgeProps) {
  const meta = runtimeOwners[owner];
  const Icon = owner === "agent-core" ? Boxes : Orbit;

  return (
    <span
      className={[
        "runtime-badge",
        ownerClassName(owner),
        compact ? "runtime-badge--compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={meta.responsibility}
    >
      <Icon size={compact ? 11 : 13} strokeWidth={2} aria-hidden="true" />
      {compact ? meta.shortLabel : meta.label}
    </span>
  );
}
