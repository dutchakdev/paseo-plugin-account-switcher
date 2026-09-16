import type { UsageWindow } from "../../shared/contracts";
import type { CollectedUsage } from "./index";

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function numeric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function date(value: unknown, seconds = false): string | null {
  if (value === null || value === undefined || (seconds ? typeof value !== "number" : typeof value !== "string")) return null;
  const time = seconds ? (value as number) * 1000 : Date.parse(value as string);
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
}
function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}
export function parseCodexUsage(payload: unknown): CollectedUsage {
  const root = object(payload) ?? {};
  const map = object(root.rateLimitsByLimitId);
  const fallback = object(root.rateLimits);
  const buckets = map && Object.keys(map).length ? Object.entries(map) : fallback ? [[string(fallback.limitId) ?? "codex", fallback] as const] : [];
  const windows: UsageWindow[] = [];
  let plan: string | null = null;
  for (const [id, candidate] of buckets) {
    const bucket = object(candidate);
    if (!bucket) continue;
    plan ??= string(bucket.planType);
    for (const key of ["primary", "secondary"]) {
      const window = object(bucket[key]);
      if (!window) continue;
      const duration = numeric(window.windowDurationMins);
      windows.push({ id: `${id}:${key}`, label: `${string(bucket.limitName) ?? id} · ${durationLabel(duration, key)}`, usedPercent: numeric(window.usedPercent), windowDurationMins: duration, resetsAt: date(window.resetsAt, true) });
    }
  }
  return { identityKey: string(root.accountId), plan, windows };
}

export function parseClaudeUsage(payload: unknown): CollectedUsage {
  const root = object(payload) ?? {};
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key !== "five_hour" && !/^seven_day(?:_[a-z0-9_]+)?$/.test(key)) continue;
    const row = object(value);
    if (value !== null && !row) continue;
    const weekly = key !== "five_hour";
    const suffix = key.slice("seven_day_".length).replaceAll("_", " ");
    windows.push({ id: key, label: !weekly ? "5 hours" : key === "seven_day" ? "Weekly" : `Weekly · ${suffix}`, usedPercent: numeric(row?.utilization), windowDurationMins: weekly ? 10080 : 300, resetsAt: date(row?.resets_at) });
  }
  if (Array.isArray(root.limits)) for (const [index, value] of root.limits.entries()) {
    const row = object(value);
    if (!row || row.kind !== "weekly_scoped") continue;
    const scope = object(row.scope);
    const model = object(scope?.model);
    const surface = object(scope?.surface);
    const labels = [string(model?.display_name) ?? string(scope?.model), string(surface?.display_name) ?? string(scope?.surface)].filter((s): s is string => !!s);
    if (!labels.length) continue;
    windows.push({ id: `weekly_scoped:${index}`, label: `Weekly · ${labels.join(" · ")}`, usedPercent: numeric(row.percent), windowDurationMins: 10080, resetsAt: date(row.resets_at) });
  }
  return { identityKey: null, plan: null, windows };
}
