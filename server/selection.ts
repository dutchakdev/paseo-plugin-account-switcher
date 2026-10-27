import type { UsageSnapshot, UsageWindow } from "../shared/contracts";

export type SelectionAccount = { id: string; authStatus: string; loginToken?: string | null };
export type Blocker = "exhausted" | "model";

const inEffect = (window: UsageWindow, now: number) => !window.resetsAt || Date.parse(window.resetsAt) > now;

/** Why an account would certainly fail a new agent, from provider-reported data only; null when nothing proves it. */
export function blocker(snapshot: UsageSnapshot | undefined, model: string | null, now: number): Blocker | null {
  if (!snapshot) return null;
  if (model && snapshot.models && !snapshot.models.includes(model)) return "model";
  if (snapshot.status !== "ok" && snapshot.status !== "stale") return null;
  return snapshot.windows.some(window => window.usedPercent !== null && window.usedPercent >= 100 && inEffect(window, now)) ? "exhausted" : null;
}

/** Percent left in the tightest window still in effect, or null without data. */
export function room(snapshot: UsageSnapshot | undefined, now: number): number | null {
  const left = (snapshot?.windows ?? []).filter(window => window.usedPercent !== null && inEffect(window, now)).map(window => 100 - window.usedPercent!);
  return left.length ? Math.max(0, Math.min(...left)) : null;
}

/** Accounts a new agent tries, in order. The default leads unless provider data shows it would fail;
 * then signed-in accounts follow by room, unknown room last, and the default stays as the last resort. */
export function launchOrder(input: { defaultId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number }): string[] {
  const { defaultId, accounts, usage, model, now } = input;
  const snapshotOf = (id: string) => usage.find(item => item.accountId === id);
  const spares = accounts
    .filter(account => account.id !== defaultId && !account.loginToken && account.authStatus === "ready" && !blocker(snapshotOf(account.id), model, now))
    .map((account, index) => ({ id: account.id, index, room: room(snapshotOf(account.id), now) }))
    .sort((a, b) => (b.room ?? -1) - (a.room ?? -1) || a.index - b.index)
    .map(account => account.id);
  return blocker(snapshotOf(defaultId), model, now) ? [...spares, defaultId] : [defaultId, ...spares];
}
