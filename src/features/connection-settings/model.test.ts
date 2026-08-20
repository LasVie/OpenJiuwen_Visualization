import { describe, expect, it } from "vitest";
import type { OpenRouterCredentialStatus } from "../../adapters/local-settings";
import {
  credentialSourceLabel,
  credentialStatusCopy,
  secretStorageLabel,
} from "./model";

function status(
  source: OpenRouterCredentialStatus["source"],
  writable = true,
  storageId = writable ? "windows-credential-manager" : "disabled",
): OpenRouterCredentialStatus {
  return {
    handleId: "openrouter.default",
    configured: source !== "none",
    source,
    writable,
    canDelete: source === "system-credential",
    exposure: "write-only",
    environmentFallback: source === "environment",
    storage: {
      id: storageId,
      available: writable,
      writable,
      persistence: writable ? "current-user" : "none",
    },
  };
}

describe("connection settings copy", () => {
  it("distinguishes OS, environment, and unavailable credential sources", () => {
    expect(credentialSourceLabel("system-credential")).toBe("系统凭据");
    expect(credentialStatusCopy(status("system-credential"))).toContain("不能读取");
    expect(credentialStatusCopy(status("system-credential", true, "memory"))).toContain("进程内临时存储");
    expect(credentialStatusCopy(status("environment"))).toContain("删除后恢复");
    expect(credentialStatusCopy(status("none", false))).toContain("启动版本");
    expect(secretStorageLabel(status("system-credential"))).toBe("Windows 凭据管理器");
  });
});
