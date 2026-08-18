import type {
  ContextMessage,
  HookInvocation,
  TraceStep,
} from "../../types/trace";

export function hook(
  id: string,
  rail: string,
  event: string,
  priority: number,
  namespace: "outer" | "inner",
  durationMs: number,
  mutationDiff: string,
  controlSignal = "continue",
  noop = false,
): HookInvocation {
  return {
    id,
    rail,
    event,
    priority,
    namespace,
    durationMs,
    mutationDiff,
    controlSignal,
    noop,
  };
}

export function step(
  value: Omit<
    TraceStep,
    "durationMs" | "hooks" | "details" | "tokenDelta" | "toolTokens"
  > &
    Partial<
      Pick<TraceStep, "durationMs" | "hooks" | "details" | "tokenDelta" | "toolTokens">
    >,
): TraceStep {
  return {
    durationMs: 0,
    hooks: [],
    details: [],
    tokenDelta: 0,
    toolTokens: 0,
    ...value,
  };
}

export function message(
  value: ContextMessage,
): ContextMessage {
  return value;
}

