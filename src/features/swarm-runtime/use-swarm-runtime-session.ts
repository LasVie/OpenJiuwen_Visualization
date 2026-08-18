import { useCallback, useEffect, useMemo, useState } from "react";
import { RuntimeTraceClient } from "../../adapters/runtime-trace";
import { useRuntimeTraceSession } from "../runtime-trace";
import {
  emptySwarmRuntimeProjection,
  projectSwarmRuntimeTrace,
} from "./model";

export function useSwarmRuntimeSession(
  providedClient?: RuntimeTraceClient,
) {
  const session = useRuntimeTraceSession({
    owner: "jiuwenswarm",
    maxTokens: 32768,
    client: providedClient,
  });
  const [contextOwnerId, setContextOwnerId] = useState<string | null>(null);
  const projection = useMemo(
    () => (session.trace
      ? projectSwarmRuntimeTrace(session.trace, session.events, contextOwnerId)
      : emptySwarmRuntimeProjection()),
    [contextOwnerId, session.events, session.trace],
  );

  useEffect(() => {
    if (
      projection.activeContextOwnerId &&
      projection.activeContextOwnerId !== contextOwnerId
    ) {
      setContextOwnerId(projection.activeContextOwnerId);
    }
  }, [contextOwnerId, projection.activeContextOwnerId]);

  const startSession = useCallback(async (label: string) => {
    setContextOwnerId(null);
    return await session.startSession(label);
  }, [session.startSession]);

  return {
    ...session,
    scenario: projection.scenario,
    projection,
    contextOwnerId: projection.activeContextOwnerId,
    setContextOwnerId,
    startSession,
  };
}
