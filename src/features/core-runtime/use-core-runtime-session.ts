import { useMemo } from "react";
import { CoreRuntimeClient } from "../../adapters/core-runtime";
import { isCoreRuntimeEventKind, type CoreRuntimeEvent } from "../../kernel";
import {
  useRuntimeTraceSession,
  type RuntimeTraceConnectionState,
} from "../runtime-trace";
import { emptyRuntimeScenario, projectCoreRuntimeTrace } from "./model";

export type CoreRuntimeConnectionState = RuntimeTraceConnectionState;

export function useCoreRuntimeSession(
  providedClient?: CoreRuntimeClient,
) {
  const session = useRuntimeTraceSession({
    owner: "agent-core",
    maxTokens: 8192,
    client: providedClient,
  });
  const events = useMemo(
    () => session.events.filter((event) =>
      isCoreRuntimeEventKind(event.kind)) as CoreRuntimeEvent[],
    [session.events],
  );
  const scenario = useMemo(
    () => (session.trace
      ? projectCoreRuntimeTrace(session.trace, events)
      : emptyRuntimeScenario()),
    [events, session.trace],
  );

  return {
    ...session,
    events,
    scenario,
  };
}
