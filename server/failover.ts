import type { UsageSnapshot } from "../shared/contracts";
import { binding, defaultBlocker, inEffect, launchOrder, type SelectionAccount } from "./selection";

export type FailoverDecision =
  | { kind: "offer"; fromId: string; toId: string; resetsAt: string | null }
  | { kind: "none"; fromId: string; resetsAt: string | null };

/** What to do after an agent's turn failed on `currentId`. Paseo does not say why a turn failed, so the only evidence
 * is the plugin's own readings: null unless they show the account is used up (a full account-wide window until a future
 * reset, or the provider's own "not allowed"). A plan that lacks the model is not a limit and gives null as well.
 * Readings are taken as given; the caller refreshes them first. `resetsAt` is the latest end of the full windows:
 * the account stays blocked until the last of them resets; null when the evidence carries none.
 * The replacement is the first account a new agent would try instead. */
export function failoverDecision(input: { currentId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number }): FailoverDecision | null {
  const { currentId, usage, now } = input;
  const evidence = { defaultId: currentId, accounts: input.accounts, usage, model: input.model, now };
  if (defaultBlocker(evidence) !== "exhausted") return null;
  const resets = (usage.find(item => item.accountId === currentId)?.windows ?? [])
    .filter(window => binding(window) && window.usedPercent !== null && window.usedPercent >= 100 && window.resetsAt !== null && inEffect(window, now))
    .map(window => window.resetsAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const resetsAt = resets[0] ?? null;
  const toId = launchOrder(evidence).find(id => id !== currentId);
  return toId ? { kind: "offer", fromId: currentId, toId, resetsAt } : { kind: "none", fromId: currentId, resetsAt };
}

const HOUR = 3_600_000, MAX_PER_HOUR = 3;
type Switch = { turnKey: string; fromId: string; toId: string; at: number };

/** Keeps automatic switching from looping, in memory: one switch per turn, three per agent in the last hour (rolling),
 * and never to an account the agent left in that hour. `allow` only asks; `record` registers a switch that happened. */
export class AutoFailoverGuard {
  private readonly switches = new Map<string, Switch[]>();

  private recent(agentId: string, now: number): Switch[] {
    return (this.switches.get(agentId) ?? []).filter(item => now - item.at < HOUR);
  }

  allow(agentId: string, turnKey: string, fromId: string, toId: string, now: number): boolean {
    if (fromId === toId) return false;
    const recent = this.recent(agentId, now);
    return recent.length < MAX_PER_HOUR && !recent.some(item => item.turnKey === turnKey || item.fromId === toId);
  }

  /** Whether this turn already had its automatic switch: a turn reported again must not be offered or switched twice. */
  hasTurn(agentId: string, turnKey: string, now: number): boolean {
    return this.recent(agentId, now).some(item => item.turnKey === turnKey);
  }

  record(agentId: string, turnKey: string, fromId: string, toId: string, now: number): void {
    this.switches.set(agentId, [...this.recent(agentId, now), { turnKey, fromId, toId, at: now }]);
  }
}
