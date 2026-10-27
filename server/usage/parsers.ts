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
function amount(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
const credits = (value: number) => Math.round(value).toLocaleString("en-US");
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
  // `rateLimits` is the account's main bucket; others, such as a model's own bucket, limit only that model.
  const main = string(fallback?.limitId) ?? (buckets.length === 1 ? buckets[0][0] : null);
  const windows: UsageWindow[] = [];
  let plan: string | null = null;
  for (const [id, candidate] of buckets) {
    const bucket = object(candidate);
    if (!bucket) continue;
    plan ??= string(bucket.planType);
    const scope = id === main ? "account" as const : "model" as const;
    for (const key of ["primary", "secondary"]) {
      const window = object(bucket[key]);
      if (!window) continue;
      const duration = numeric(window.windowDurationMins);
      windows.push({ id: `${id}:${key}`, label: `${string(bucket.limitName) ?? id} · ${durationLabel(duration, key)}`, usedPercent: numeric(window.usedPercent), windowDurationMins: duration, resetsAt: date(window.resetsAt, true), scope });
    }
    // Usage-based workspaces (e.g. enterprise_cbp_usage_based) report a monthly credit allowance instead of windows.
    const spend = object(bucket.individualLimit);
    const remaining = numeric(spend?.remainingPercent);
    if (spend && remaining !== null) {
      const limit = amount(spend.limit);
      const used = amount(spend.used);
      windows.push({ id: `${id}:individual`, label: `${string(bucket.limitName) ?? id} · monthly credits`, usedPercent: 100 - Math.min(100, remaining), windowDurationMins: null, resetsAt: date(spend.resetsAt, true),
        detail: limit !== null && used !== null ? `${credits(Math.max(0, limit - used))} of ${credits(limit)} credits left` : null, scope });
    }
  }
  return { identityKey: string(root.accountId), plan, windows, usageAllowed: typeof root.ordinaryUsageAllowed === "boolean" ? root.ordinaryUsageAllowed : null };
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
    windows.push({ id: key, label: !weekly ? "5 hours" : key === "seven_day" ? "Weekly" : `Weekly · ${suffix}`, usedPercent: numeric(row?.utilization), windowDurationMins: weekly ? 10080 : 300, resetsAt: date(row?.resets_at),
      scope: key === "five_hour" || key === "seven_day" ? "account" : "model" });
  }
  if (Array.isArray(root.limits)) for (const [index, value] of root.limits.entries()) {
    const row = object(value);
    if (!row || row.kind !== "weekly_scoped") continue;
    const scope = object(row.scope);
    const model = object(scope?.model);
    const surface = object(scope?.surface);
    const labels = [string(model?.display_name) ?? string(scope?.model), string(surface?.display_name) ?? string(scope?.surface)].filter((s): s is string => !!s);
    if (!labels.length) continue;
    windows.push({ id: `weekly_scoped:${index}`, label: `Weekly · ${labels.join(" · ")}`, usedPercent: numeric(row.percent), windowDurationMins: 10080, resetsAt: date(row.resets_at), scope: "model" });
  }
  // Enterprise seats report a monthly spend allowance; amounts are in minor units of `currency`.
  const extra = object(root.extra_usage);
  const limit = numeric(extra?.monthly_limit);
  const used = numeric(extra?.used_credits);
  if (extra?.is_enabled === true && limit) {
    const scale = 10 ** (numeric(extra.decimal_places) ?? 2);
    const currency = string(extra.currency) ?? "USD";
    const money = (value: number) => { try { return (value / scale).toLocaleString("en-US", { style: "currency", currency }); } catch { return `${(value / scale).toFixed(2)} ${currency}`; } };
    const spend: UsageWindow = { id: "extra_usage", label: "Monthly spend", usedPercent: numeric(extra.utilization) ?? (used === null ? null : used / limit * 100), windowDurationMins: null, resetsAt: null,
      detail: used === null ? null : `${money(Math.max(0, limit - used))} of ${money(limit)} left`, scope: "spend" };
    // Without any plan limits the empty plan rows are noise; the spend allowance is the only quota.
    return { identityKey: null, plan: null, windows: windows.some((quota) => quota.usedPercent !== null) ? [...windows, spend] : [spend] };
  }
  return { identityKey: null, plan: null, windows };
}
/** One `model/list` page: the model IDs the account's plan offers, or null when the page is unreadable. */
export function parseCodexModels(payload: unknown): { models: string[]; nextCursor: string | null } | null {
  const page = object(payload);
  if (!Array.isArray(page?.data)) return null;
  const models = page.data.map(entry => string(object(entry)?.model));
  if (models.some(model => model === null)) return null;
  return { models: models as string[], nextCursor: string(page.nextCursor) };
}
