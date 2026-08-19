import type {
  ArchivedTraceOwner,
  ArchivedTraceStatus,
} from "../../adapters/trace-archive";

export function formatArchiveBytes(value: number) {
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${value} B`;
  if (absolute < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (absolute < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatArchiveDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function archiveOwnerLabel(owner: ArchivedTraceOwner) {
  return owner === "agent-core" ? "CORE" : "SWARM";
}

export function archiveStatusLabel(status: ArchivedTraceStatus) {
  if (status === "open") return "运行中";
  if (status === "completed") return "已完成";
  return "失败";
}

export function formatMetric(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatMetricDelta(value: number) {
  if (value === 0) return "±0";
  return `${value > 0 ? "+" : ""}${formatMetric(value)}`;
}
