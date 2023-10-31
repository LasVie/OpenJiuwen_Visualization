import { PackageCheck } from "lucide-react";
import type { RuntimeManagedEnvironmentStatus } from "../../adapters/local-environments";

interface RuntimeEnvironmentIdentityProps {
  environment: RuntimeManagedEnvironmentStatus;
}

export function RuntimeEnvironmentIdentity({
  environment,
}: RuntimeEnvironmentIdentityProps) {
  const fingerprint = environment.activeFingerprint ?? environment.desiredFingerprint;
  return (
    <div className="runtime-environment-identity" aria-label="本次运行的受管环境">
      <PackageCheck size={16} strokeWidth={2} aria-hidden="true" />
      <span>
        <small>VERIFIED ENVIRONMENT</small>
        <strong>{environment.id}</strong>
      </span>
      <code title={fingerprint ?? undefined}>
        {fingerprint?.slice(0, 12) ?? "pending"}
      </code>
      <em>
        Python {environment.pythonVersion ?? "—"} · uv {environment.uvVersion ?? "—"}
      </em>
      <small>每次运行前自动检查</small>
    </div>
  );
}
