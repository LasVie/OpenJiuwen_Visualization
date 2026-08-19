import type { GraphSourceReference } from "./contracts/graph";

export const SOURCE_IDENTITY_SCHEMA_VERSION = "1.0.0" as const;

export interface CanonicalSourceIdentity {
  repository: string;
  revision?: string;
  path: string;
  symbol?: string;
}

function normalizePath(value: string) {
  const segments: string[] = [];
  value.replaceAll("\\", "/").split("/").forEach((segment) => {
    if (!segment || segment === ".") return;
    if (segment === "..") {
      segments.pop();
      return;
    }
    segments.push(segment);
  });
  return segments.join("/");
}

export function canonicalSourceIdentity(
  source: GraphSourceReference,
): CanonicalSourceIdentity {
  const revision = source.revision?.trim().toLocaleLowerCase();
  const symbol = source.symbol?.trim();
  return {
    repository: source.repository.trim().toLocaleLowerCase(),
    path: normalizePath(source.path.trim()),
    ...(revision ? { revision } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

export function sourceLocationKey(source: GraphSourceReference) {
  const canonical = canonicalSourceIdentity(source);
  return [canonical.repository, canonical.path, canonical.symbol ?? "<module>"]
    .join(":");
}

export function sourceIdentityKey(source: GraphSourceReference) {
  const canonical = canonicalSourceIdentity(source);
  return `${canonical.repository}@${canonical.revision ?? "?"}:${canonical.path}:${canonical.symbol ?? "<module>"}`;
}

export function sameSourceLocation(
  left: GraphSourceReference,
  right: GraphSourceReference,
) {
  return sourceLocationKey(left) === sourceLocationKey(right);
}
