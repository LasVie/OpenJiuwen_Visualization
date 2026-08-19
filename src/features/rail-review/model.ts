import type {
  HookInvocation,
  RailNodeDefinition,
  TraceScenario,
  TraceStep,
} from "../../types/trace";

export type RailReviewStatus =
  | "waiting"
  | "reviewing"
  | "passed"
  | "changed"
  | "blocked"
  | "skipped";

export interface RailReviewCheck {
  id: string;
  label: string;
  description: string;
  status: RailReviewStatus;
}

export interface RailReviewProfile {
  targetLabel: string;
  targetPath: string;
  examines: string;
  aliases: string[];
  checks: Array<Omit<RailReviewCheck, "status">>;
}

export interface RailReviewSnapshot {
  status: RailReviewStatus;
  profile: RailReviewProfile;
  payload: string;
  invocation?: HookInvocation;
  checks: RailReviewCheck[];
  outcome: string;
}

export interface RailReviewFrame {
  id: string;
  stepIndex: number;
  step: TraceStep;
  snapshot: RailReviewSnapshot;
}

const profiles: Record<string, RailReviewProfile> = {
  "rail-init": {
    targetLabel: "Rail registry",
    targetPath: "DeepAgent.rails[]",
    examines: "检查 Rail 是否完成初始化、优先级排序与生命周期注册。",
    aliases: ["SysOperationRail", "SkillUseRail", "TaskPlanningRail", "DeepAgentRail"],
    checks: [
      { id: "construct", label: "实例可构造", description: "配置和依赖满足初始化条件" },
      { id: "priority", label: "优先级有序", description: "相同 Hook 点按 priority 稳定排序" },
      { id: "lifecycle", label: "生命周期已注册", description: "init / uninit 边界可追踪" },
    ],
  },
  "rail-safety": {
    targetLabel: "用户消息",
    targetPath: "request.message",
    examines: "读取当前用户输入，检查提示注入、敏感信息与策略边界。",
    aliases: ["SafetyPromptRail", "BaseSecurityRail"],
    checks: [
      { id: "input", label: "输入完整性", description: "消息结构与角色符合预期" },
      { id: "policy", label: "策略审查", description: "识别注入与敏感信息风险" },
      { id: "signal", label: "控制信号", description: "决定继续、改写或阻断" },
    ],
  },
  "rail-context": {
    targetLabel: "模型上下文",
    targetPath: "ModelCallInputs.messages",
    examines: "审查 system、history、tool schema 的顺序、来源与预算。",
    aliases: ["ContextAssembleRail"],
    checks: [
      { id: "order", label: "消息顺序", description: "system / user / assistant / tool lineage 连续" },
      { id: "mutation", label: "提示变更", description: "记录 Rail 注入或移除的上下文" },
      { id: "budget", label: "Token 预算", description: "最终窗口不超过模型上限" },
    ],
  },
  "rail-retry": {
    targetLabel: "模型异常",
    targetPath: "ModelCallError",
    examines: "审查异常类型、重试资格、退避时间和剩余尝试次数。",
    aliases: ["LLMRetryRail"],
    checks: [
      { id: "kind", label: "异常分类", description: "区分瞬时错误与永久错误" },
      { id: "attempt", label: "重试预算", description: "检查 attempt 与最大次数" },
      { id: "recovery", label: "恢复动作", description: "生成 retry 或 fail 控制信号" },
    ],
  },
  "rail-trajectory": {
    targetLabel: "ReAct 迭代帧",
    targetPath: "trace.iteration[]",
    examines: "记录本轮 route、耗时、Context 变化和最终控制信号。",
    aliases: ["TrajectoryRail"],
    checks: [
      { id: "route", label: "路由结果", description: "记录 tool_calls 或 final 分支" },
      { id: "timing", label: "阶段耗时", description: "保留当前事件持续时间" },
      { id: "delta", label: "上下文增量", description: "关联本轮 token 与工具结果" },
    ],
  },
  "rail-compression": {
    targetLabel: "历史消息窗口",
    targetPath: "ContextWindow.history",
    examines: "检查预算阈值、可压缩消息和摘要替换结果。",
    aliases: ["ContextProcessorRail"],
    checks: [
      { id: "threshold", label: "预算阈值", description: "判断是否需要压缩" },
      { id: "selection", label: "消息选择", description: "保留关键角色和工具 lineage" },
      { id: "result", label: "压缩结果", description: "核对前后 token 与摘要状态" },
    ],
  },
  "rail-tool": {
    targetLabel: "工具调用边界",
    targetPath: "ToolCallInputs",
    examines: "审查 tool name、arguments、timeout、result 与 tool_call_id。",
    aliases: ["ToolCallResilienceRail"],
    checks: [
      { id: "schema", label: "参数结构", description: "tool name 与 arguments 匹配 schema" },
      { id: "boundary", label: "执行边界", description: "记录 timeout、异常与耗时" },
      { id: "lineage", label: "结果关联", description: "result 正确回填对应 tool_call_id" },
    ],
  },
};

const fallbackProfile: RailReviewProfile = {
  targetLabel: "运行时载荷",
  targetPath: "rail.context.inputs",
  examines: "读取当前 Hook 输入，记录检查结果与控制信号。",
  aliases: [],
  checks: [
    { id: "input", label: "读取输入", description: "捕获 Hook 收到的结构化载荷" },
    { id: "decision", label: "执行检查", description: "应用 Rail 的审查逻辑" },
    { id: "output", label: "发布结果", description: "输出 mutation 与 control signal" },
  ],
};

export function getRailReviewProfile(railId: string): RailReviewProfile {
  return profiles[railId] ?? fallbackProfile;
}

export function getRailInvocations(
  definition: RailNodeDefinition,
  step: TraceStep,
  profile = getRailReviewProfile(definition.id),
) {
  return step.hooks.filter(
    (hook) =>
      profile.aliases.includes(hook.rail) ||
      definition.hooks.some((candidate) => candidate.event === hook.event),
  );
}

function reviewPayload(
  definition: RailNodeDefinition,
  step: TraceStep,
  runInput: string,
  invocation?: HookInvocation,
) {
  if (invocation?.examines?.length) return invocation.examines.join("\n\n");
  if (definition.id === "rail-safety") return runInput;
  if (definition.id === "rail-init") {
    return definition.hooks.map((hook) => `${hook.event} · p${hook.priority}`).join("\n");
  }
  if (definition.id === "rail-context") {
    return `${step.summary}\nmessages/token window · ${step.tokenUsed} tokens`;
  }
  if (definition.id === "rail-compression" && step.compression) {
    return `${step.compression.processor}\n${step.compression.beforeTokens} → ${step.compression.afterTokens} tokens`;
  }
  if (step.details.length) {
    return step.details.map((detail) => `${detail.label}: ${detail.value}`).join("\n");
  }
  return `${step.eventCode}\n${step.summary}`;
}

export function buildRailReviewSnapshot(
  definition: RailNodeDefinition,
  step: TraceStep,
  runInput: string,
  invocationOverride?: HookInvocation,
): RailReviewSnapshot {
  const profile = getRailReviewProfile(definition.id);
  const invocation =
    invocationOverride ?? getRailInvocations(definition, step, profile)[0];
  const active =
    step.activeNodeIds.includes(definition.id) || Boolean(invocation);
  const mutation = invocation?.mutationDiff.trim() ?? "";
  const blocked = Boolean(
    invocation && !["continue", "retry", "none"].includes(invocation.controlSignal),
  );
  const changed = Boolean(
    invocation && mutation && mutation !== "无变更" && !invocation.noop,
  );
  const status: RailReviewStatus = !active
    ? "waiting"
    : invocation?.noop
      ? "skipped"
      : blocked
        ? "blocked"
        : changed
          ? "changed"
          : invocation
            ? "passed"
            : "reviewing";

  const checks = profile.checks.map((check, index) => {
    let checkStatus: RailReviewStatus = active ? "passed" : "waiting";
    if (active && !invocation) checkStatus = "reviewing";
    if (invocation?.noop) checkStatus = "skipped";
    if (active && changed && index === 1) checkStatus = "changed";
    if (active && blocked && index === profile.checks.length - 1) {
      checkStatus = "blocked";
    }
    return { ...check, status: checkStatus };
  });

  const outcome = !active
    ? "当前步骤未触发此 Rail；展示的是它固定审查的字段与检查顺序。"
    : invocation
      ? `${invocation.mutationDiff} · signal=${invocation.controlSignal}`
      : `已进入 ${step.eventCode}，等待 Hook 结果。`;

  return {
    status,
    profile,
    payload: reviewPayload(definition, step, runInput, invocation),
    invocation,
    checks,
    outcome,
  };
}

export function buildRailReviewFrames(
  definition: RailNodeDefinition,
  scenario: TraceScenario,
  runInput: string,
): RailReviewFrame[] {
  return scenario.steps.flatMap((step, stepIndex) => {
    const invocations = getRailInvocations(definition, step);

    if (invocations.length > 0) {
      return invocations.map((invocation, invocationIndex) => ({
        id: `${step.id}:${invocation.id}:${invocationIndex}`,
        stepIndex,
        step,
        snapshot: buildRailReviewSnapshot(
          definition,
          step,
          runInput,
          invocation,
        ),
      }));
    }

    if (step.activeNodeIds.includes(definition.id)) {
      return [
        {
          id: `${step.id}:active`,
          stepIndex,
          step,
          snapshot: buildRailReviewSnapshot(definition, step, runInput),
        },
      ];
    }

    return [];
  });
}
