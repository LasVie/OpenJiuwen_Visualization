import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const traceArchivePlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.trace-archive",
    name: "Local Trace Archive",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "独立管理本机 SQLite/WAL 运行档案、按需原文读取、完整导出、删除与双运行结构化对比。",
    group: "workspace",
    defaultEnabled: true,
    capabilities: ["trace.archive.local.v1"],
  },
  contribute: () => ({}),
};
