import type {
  OpenRouterCredentialSource,
  OpenRouterCredentialStatus,
} from "../../adapters/local-settings";

const sourceLabels: Record<OpenRouterCredentialSource, string> = {
  "system-credential": "系统凭据",
  environment: "服务环境",
  injected: "嵌入配置",
  none: "未配置",
};

export function credentialSourceLabel(source: OpenRouterCredentialSource) {
  return sourceLabels[source];
}

export function credentialStatusCopy(status: OpenRouterCredentialStatus) {
  if (status.source === "system-credential") {
    return `API key 已写入${secretStorageLabel(status)}；页面不能读取或恢复原文。`;
  }
  if (status.source === "environment") {
    return status.writable
      ? "当前 key 来自服务环境；在此保存会用系统凭据覆盖，删除后恢复环境值。"
      : "当前 key 来自服务环境；此启动方式不允许网页写入系统凭据。";
  }
  if (status.source === "injected") {
    return status.writable
      ? "当前 key 由本地宿主注入；可在此迁移到系统凭据库。"
      : "当前 key 由本地宿主持有，页面不能修改。";
  }
  return status.writable
    ? "尚未配置。保存后立即供 OpenRouter、Core 和 Swarm 运行链路使用。"
    : "当前 Companion 未开放系统凭据写入；请使用支持凭据库的启动版本。";
}

export function secretStorageLabel(status: OpenRouterCredentialStatus) {
  if (status.storage.id === "windows-credential-manager") {
    return "Windows 凭据管理器";
  }
  if (status.storage.id === "memory") return "进程内临时存储";
  if (!status.storage.available) return "系统凭据库不可用";
  return status.storage.id;
}
