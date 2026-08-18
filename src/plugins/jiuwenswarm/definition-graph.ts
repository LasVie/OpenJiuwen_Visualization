import type { GraphNodeRecord } from "../../kernel";
import { fixtureNode } from "../shared/fixture-graph";

const repository = "jiuwenswarm";

export const jiuwenSwarmNodes: readonly GraphNodeRecord[] = [
  fixtureNode({
    id: "input",
    kind: "input",
    level: 1,
    owner: repository,
    label: "Swarm Ingress",
    subtitle: "request + session ingress",
    summary: "JiuwenSwarm 接收用户输入与会话信息，再把请求交给 Agent Core 运行时。",
    repository,
    path: "jiuwenswarm/server/agent_ws_server.py",
    position: { x: 20, y: 280 },
    renderer: "stage",
    expandable: true,
  }),
  fixtureNode({
    id: "output",
    kind: "output",
    level: 1,
    owner: repository,
    label: "Swarm Response",
    subtitle: "stream + persist",
    summary: "JiuwenSwarm 接收 Agent Core 的最终结果，完成流式响应与会话持久化。",
    repository,
    path: "jiuwenswarm/server/runtime/agent_adapter/interface_deep.py",
    position: { x: 1200, y: 280 },
    renderer: "stage",
    expandable: true,
    viewProperties: { accent: "signal" },
  }),
];
