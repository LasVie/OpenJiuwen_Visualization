import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../../types/trace";
import {
  compactContextPreview,
  contextMessageText,
  displayTokens,
} from "./model";

const message: ContextMessage = {
  id: "test-message",
  role: "user",
  label: "User message",
  raw: "{{input}}",
  tokens: 12,
  addedAt: 0,
  source: "request",
};

describe("context disclosure model", () => {
  it("shows a masked compact preview until the message is expanded", () => {
    const input =
      "请联系 demo@example.com 并使用 sk-demo-9A31F2x7。" + "很长的补充内容".repeat(30);

    const preview = contextMessageText(message, input, false);
    const raw = contextMessageText(message, input, true);

    expect(preview).toContain("[邮箱已隐藏]");
    expect(preview).toContain("[凭据已隐藏]");
    expect(preview.length).toBeLessThanOrEqual(128);
    expect(raw).toBe(input);
  });

  it("keeps continuous text complete while exposing display-token boundaries", () => {
    const raw = "System contract\n工具：weather.lookup";
    const tokens = displayTokens(raw).filter((token) => token.index !== null);

    expect(tokens.length).toBeGreaterThan(4);
    expect(tokens.map((token) => token.text).join(""))
      .toBe(compactContextPreview(raw, 999).replace(/\s+/g, ""));
  });
});
