import { maskSensitiveText, materializeText } from "../../state/trace-utils";
import type { ContextMessage } from "../../types/trace";

export interface DisplayToken {
  text: string;
  index: number | null;
}

export function displayTokens(value: string): DisplayToken[] {
  const fragments =
    value.match(/\s+|[\p{Script=Han}]|[A-Za-z0-9_]+|[^\s]/gu) ?? [];
  let tokenIndex = 0;
  return fragments.map((text) => {
    if (/^\s+$/.test(text)) return { text, index: null };
    tokenIndex += 1;
    return { text, index: tokenIndex };
  });
}

export function contextMessageText(
  message: ContextMessage,
  runInput: string,
  expanded: boolean,
): string {
  const raw = materializeText(message.raw, runInput);
  if (expanded) return raw;
  const preview = message.preview
    ? materializeText(message.preview, runInput)
    : raw;
  return compactContextPreview(preview);
}

export function compactContextPreview(value: string, maxLength = 128): string {
  const compact = maskSensitiveText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return compact.slice(0, Math.max(1, maxLength - 1)).trimEnd() + "…";
}
