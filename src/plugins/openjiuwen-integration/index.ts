import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";
import { fixtureEdge } from "../shared/fixture-graph";

const integrationEdges = [
  fixtureEdge({
    id: "e-input-deep",
    source: "input",
    target: "deep-agent",
    kind: "causal",
    repository: "jiuwenswarm",
    path: "jiuwenswarm/server/runtime/agent_adapter/interface_deep.py",
  }),
  fixtureEdge({
    id: "e-decision-output",
    source: "decision",
    target: "output",
    label: "final",
    kind: "causal",
    repository: "jiuwenswarm",
    path: "jiuwenswarm/server/runtime/agent_adapter/interface_deep.py",
  }),
  fixtureEdge({
    id: "e-rail-safety-input",
    source: "rail-safety",
    target: "input",
    sourceHandle: "rail-source-bottom",
    targetHandle: "rail-target-top",
    kind: "rail",
    repository: "agent-core",
    path: "openjiuwen/harness/rails/security/prompt_security_rail.py",
  }),
];

export const openJiuwenIntegrationPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.integration",
    name: "Core–Swarm Integration",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "连接 JiuWenSwarm 边界与 Agent Core 执行链路。",
    defaultEnabled: true,
    dependencies: ["openjiuwen.agent-core", "openjiuwen.jiuwenswarm"],
    capabilities: ["graph.definition.integration"],
  },
  contribute: () => ({ graph: { edges: integrationEdges } }),
};
