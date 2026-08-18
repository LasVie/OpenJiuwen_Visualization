import {
  PLUGIN_API_VERSION,
  RUNTIME_TRACE_EVENT_KINDS,
  type VisualizationPlugin,
} from "../../kernel";
import { jiuwenSwarmNodes } from "./definition-graph";
import { subagentDelegationRecording } from "./recordings/subagent-delegation";

export const jiuwenSwarmPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.jiuwenswarm",
    name: "JiuWenSwarm Inspector",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "提供 Swarm 请求入口、会话边界和响应出口定义图。",
    group: "jiuwenswarm",
    defaultEnabled: true,
    capabilities: [
      "graph.definition.jiuwenswarm",
      "trace.runtime.jiuwenswarm",
      "trace.context.ownership",
      "runtime.subagent.execution.v1",
    ],
  },
  contribute: () => ({
    graph: { nodes: jiuwenSwarmNodes },
    runtimeSources: [
      {
        id: "openjiuwen.jiuwenswarm.runtime",
        owner: "jiuwenswarm",
        label: "Swarm Runtime",
        description: "通过本机内存 Trace 会话接收 Team、Workflow、Agent、Subagent 与独立 Context 事件。",
        transport: "loopback-sse",
        eventKinds: RUNTIME_TRACE_EVENT_KINDS,
      },
    ],
    runtimeRecordings: [subagentDelegationRecording],
  }),
};
