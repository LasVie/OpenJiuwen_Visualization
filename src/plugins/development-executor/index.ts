import { PLUGIN_API_VERSION, type VisualizationPlugin } from "../../kernel";

export const developmentExecutorPlugin: VisualizationPlugin = {
  manifest: {
    id: "openjiuwen.development-executor",
    name: "Controlled Development Executor",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "在隔离 worktree/branch 中逐次审批补丁、固定测试、本地 commit 与回滚；不修改源 checkout，不 push。",
    group: "workspace",
    defaultEnabled: false,
    dependencies: [
      "openjiuwen.development-assistant",
      "openjiuwen.local-repository",
    ],
    capabilities: [
      "development.execution.controlled.v1",
      "development.patch.apply.approved.v1",
      "development.test.allowlist.v1",
      "development.git.local-commit.v1",
      "development.execution.rollback.v1",
    ],
  },
  contribute: () => ({}),
};
