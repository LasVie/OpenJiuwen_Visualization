import type { RuntimeOwner } from "../../types/trace";

export interface RuntimeOwnerMeta {
  id: RuntimeOwner;
  label: string;
  shortLabel: string;
  responsibility: string;
}

export const runtimeOwners: Record<RuntimeOwner, RuntimeOwnerMeta> = {
  "agent-core": {
    id: "agent-core",
    label: "Agent Core",
    shortLabel: "CORE",
    responsibility: "Agent 生命周期、ReAct、Context、Model、Tool 与 Rail 运行时",
  },
  jiuwenswarm: {
    id: "jiuwenswarm",
    label: "JiuwenSwarm",
    shortLabel: "SWARM",
    responsibility: "请求入口、会话宿主、能力装配与响应出口",
  },
};

export function ownerClassName(owner: RuntimeOwner): string {
  return "runtime-owner--" + owner;
}
