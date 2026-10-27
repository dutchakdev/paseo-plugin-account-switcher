import type { UsageSnapshot, UsageWindow } from "../shared/contracts";

export type SelectionAccount = { id: string; authStatus: string; loginToken?: string | null };
export type Blocker = "exhausted" | "model";

// Only limits that stop every request of the account count; a model's own week or extra paid usage do not.
const binding = (window: UsageWindow) => window.scope === "account";
const inEffect = (window: UsageWindow, now: number) => !window.resetsAt || Date.parse(window.resetsAt) > now;

/** Why an account would certainly fail a new agent, from provider-reported data only; null when nothing proves it.
 * A full window proves it only with a known future reset: within a window, use only grows until the reset.
 * The provider's verdict and the plan's model list count only from a fresh reading, since both can change. */
export function blocker(snapshot: UsageSnapshot | undefined, model: string | null, now: number): Blocker | null {
  if (!snapshot) return null;
  const fresh = snapshot.status === "ok";
  if (fresh && model && snapshot.models && !snapshot.models.includes(model)) return "model";
  if (fresh && snapshot.usageAllowed === false) return "exhausted";
  if (snapshot.status !== "ok" && snapshot.status !== "stale") return null;
  return snapshot.windows.some(window => binding(window) && window.usedPercent !== null && window.usedPercent >= 100 && window.resetsAt !== null && inEffect(window, now)) ? "exhausted" : null;
}

/** Percent left in the tightest account-wide window still in effect, or null without data. */
export function room(snapshot: UsageSnapshot | undefined, now: number): number | null {
  const left = (snapshot?.windows ?? []).filter(window => binding(window) && window.usedPercent !== null && inEffect(window, now)).map(window => 100 - window.usedPercent!);
  return left.length ? Math.max(0, Math.min(...left)) : null;
}

/** Accounts a new agent tries, in order. The default leads unless provider data shows it would fail;
 * then signed-in accounts follow by room, unknown room last, and the default stays as the last resort. */
export function launchOrder(input: { defaultId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number }): string[] {
  const { defaultId, accounts, usage, now } = input;
  const snapshotOf = (id: string) => usage.find(item => item.accountId === id);
  // The hint is the requested model, before Paseo resolves aliases; one no account lists proves nothing.
  const known = accounts.some(account => snapshotOf(account.id)?.models?.includes(input.model ?? ""));
  const model = known ? input.model : null;
  const spares = accounts
    .filter(account => account.id !== defaultId && !account.loginToken && account.authStatus === "ready" && !blocker(snapshotOf(account.id), model, now))
    .map((account, index) => ({ id: account.id, index, room: room(snapshotOf(account.id), now) }))
    .sort((a, b) => (b.room ?? -1) - (a.room ?? -1) || a.index - b.index)
    .map(account => account.id);
  return blocker(snapshotOf(defaultId), model, now) ? [...spares, defaultId] : [defaultId, ...spares];
}

/** Why the default was passed over, with the same evidence `launchOrder` used. */
export function defaultBlocker(input: Parameters<typeof launchOrder>[0]): Blocker | null {
  const snapshotOf = (id: string) => input.usage.find(item => item.accountId === id);
  const known = input.accounts.some(account => snapshotOf(account.id)?.models?.includes(input.model ?? ""));
  return blocker(snapshotOf(input.defaultId), known ? input.model : null, input.now);
}
