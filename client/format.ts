import type { Account, AccountState, Provider, UsageSnapshot, UsageWindow } from "../shared/contracts";

export const providerName: Record<Provider, string> = { claude: "Claude", codex: "Codex · ChatGPT" };

export function supportedProvider(value: string): Provider | null {
  const name = value.split("/")[0];
  return name === "claude" || name === "codex" ? name : null;
}

export function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.round(value * 10) / 10}%`;
}

export function remainingPercent(used: number | null): number | null {
  return used === null || !Number.isFinite(used) ? null : Math.max(0, 100 - used);
}

export function quotaLevel(used: number | null): "unknown" | "normal" | "warning" | "critical" | "exhausted" {
  if (used === null || !Number.isFinite(used)) return "unknown";
  if (used >= 100) return "exhausted";
  if (used >= 95) return "critical";
  if (used >= 80) return "warning";
  return "normal";
}

export function localDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "unknown";
  return new Date(value).toLocaleString("en-US", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function resetCountdown(value: string | null, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Reset time unknown";
  const difference = Date.parse(value) - now;
  if (difference <= 0) return "Reset time passed · waiting for new data";
  const minutes = Math.ceil(difference / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  return `Resets in ${[days ? `${days} d` : "", hours ? `${hours} hr` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ")}`;
}

export function windowIsExpired(quota: UsageWindow, now = Date.now()): boolean {
  return quota.resetsAt !== null && Number.isFinite(Date.parse(quota.resetsAt)) && Date.parse(quota.resetsAt) <= now;
}

export function usageSummary(snapshot: UsageSnapshot | undefined, now = Date.now()): string {
  if (!snapshot) return "limits —";
  if (snapshot.status === "needs_auth") return "sign-in required";
  if (snapshot.status === "unavailable") return "limits unavailable";
  const known = snapshot.windows.filter((quota) => quota.usedPercent !== null && Number.isFinite(quota.usedPercent));
  if (!known.length) return snapshot.status === "stale" ? "limits stale" : "limits —";
  const limiting = known.reduce((left, right) => left.usedPercent! >= right.usedPercent! ? left : right);
  const stale = snapshot.status === "stale" || windowIsExpired(limiting, now);
  return `${percent(remainingPercent(limiting.usedPercent))} left${stale ? " · stale" : ""}`;
}

export function currentAccount(state: AccountState, agentId: string, provider: Provider): Account | undefined {
  const binding = state.bindings.find((item) => item.agentId === agentId);
  if (binding && binding.currentAccountId === null) return undefined;
  const id = binding ? binding.currentAccountId : `system-${provider}`;
  return state.accounts.find((account) => account.id === id);
}

export function currentAccountName(state: AccountState, agentId: string, provider: Provider): string {
  const binding = state.bindings.find((item) => item.agentId === agentId);
  if (binding && binding.currentAccountId === null) return "Account not confirmed";
  return currentAccount(state, agentId, provider)?.label ?? "Account unknown";
}

export function idleForSwitch(agent: {
  status: string;
  activeTurn?: unknown;
  pendingPermissions: readonly unknown[];
} | null | undefined): boolean {
  return Boolean(agent && agent.status === "idle" && !agent.activeTurn && agent.pendingPermissions.length === 0);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Could not complete the action. Try again.";
}

export type Tone = "muted" | "success" | "warning" | "danger";

export function quotaTone(used: number | null): Tone {
  const level = quotaLevel(used);
  return level === "exhausted" || level === "critical" ? "danger" : level === "warning" ? "warning" : level === "normal" ? "success" : "muted";
}

/** Windows with a measured percentage first (provider order kept); windows without data are listed separately. */
export function splitWindows(windows: readonly UsageWindow[]): { known: UsageWindow[]; unknown: UsageWindow[] } {
  const known: UsageWindow[] = [];
  const unknown: UsageWindow[] = [];
  for (const quota of windows) (quota.usedPercent !== null && Number.isFinite(quota.usedPercent) ? known : unknown).push(quota);
  return { known, unknown };
}

export function shortDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days} d ${hours} hr` : `${days} d`;
  if (hours) return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  return `${rest} min`;
}

/** Compact reset countdown for one line; the full sentence stays in resetCountdown. */
export function shortCountdown(value: string | null, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "reset time unknown";
  const difference = Date.parse(value) - now;
  return difference <= 0 ? "reset time passed" : `in ${shortDuration(difference)}`;
}

export function relativeTime(value: string | null, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "unknown";
  const difference = now - Date.parse(value);
  if (difference < 60_000) return "just now";
  return `${shortDuration(difference)} ago`;
}

export function windowLength(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return shortDuration(minutes * 60_000);
}

/** One short freshness line per snapshot; errors are shown separately and never hidden. */
export function freshness(snapshot: UsageSnapshot | undefined, now = Date.now()): { text: string; tone: Tone } {
  if (!snapshot) return { text: "limits not fetched yet", tone: "muted" };
  if (snapshot.status === "needs_auth") return { text: "limits: sign-in required", tone: "warning" };
  if (snapshot.status === "unavailable") return { text: `limits unavailable · checked ${relativeTime(snapshot.checkedAt, now)}`, tone: "danger" };
  const age = relativeTime(snapshot.fetchedAt, now);
  if (snapshot.status === "stale") return { text: `stale data · ${age}`, tone: "warning" };
  const expired = snapshot.windows.some((quota) => windowIsExpired(quota, now));
  return expired ? { text: `reset time passed · data from ${age}`, tone: "warning" } : { text: `updated ${age}`, tone: "muted" };
}

export function accountStatus(account: Account, snapshot: UsageSnapshot | undefined): { text: string; tone: Tone } {
  if (account.login) return { text: "sign-in in progress", tone: "warning" };
  if (account.authStatus === "ready" && snapshot?.status === "needs_auth") return { text: "limits require sign-in", tone: "warning" };
  return {
    ready: { text: "sign-in confirmed", tone: "success" as Tone },
    needs_auth: { text: "sign-in required", tone: "warning" as Tone },
    unknown: { text: "sign-in not checked", tone: "muted" as Tone },
    error: { text: "sign-in error", tone: "danger" as Tone },
  }[account.authStatus];
}

// Every pressable keeps a 44px touch target: the drawn box plus symmetric hit slop that fills the difference.
export const TOUCH_TARGET = 44;
export function targetSlop(boxHeight: number, horizontal = 4): { top: number; bottom: number; left: number; right: number } {
  const vertical = Math.max(0, Math.ceil((TOUCH_TARGET - boxHeight) / 2));
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
