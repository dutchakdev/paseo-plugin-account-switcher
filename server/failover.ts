import type { UsageSnapshot } from "../shared/contracts";
import { blocker, defaultBlocker, fullUntilReset, launchOrder, type SelectionAccount } from "./selection";

export type FailoverDecision =
  | { kind: "offer"; fromId: string; toId: string; resetsAt: string | null }
  | { kind: "none"; fromId: string; resetsAt: string | null };

/** What to do after an agent's turn failed on `currentId`. Paseo does not say why a turn failed, so the only evidence
 * is the plugin's own readings: null unless they show the account is used up (a full account-wide window until a future
 * reset, or the provider's own "not allowed"). A plan that lacks the model is not a limit and gives null as well.
 * Readings are taken as given; the caller refreshes them first. `resetsAt` is the latest end of the full windows:
 * the account stays blocked until the last of them resets; null when the evidence carries none.
 * The replacement is the first account a new agent would try instead. */
export function failoverCandidates(input: { currentId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number; excludedIds?: ReadonlySet<string> }): string[] | null {
  const { currentId, usage, now } = input;
  const evidence = { defaultId: currentId, accounts: input.accounts, usage, model: input.model, now };
  if (defaultBlocker(evidence) !== "exhausted") return null;
  const knownModel = input.accounts.some(account => usage.find(snapshot => snapshot.accountId === account.id)?.models?.includes(input.model ?? ""));
  const model = knownModel ? input.model : null;
  return launchOrder(evidence).filter(id => {
    if (id === currentId) return false;
    if (!input.excludedIds?.has(id)) return true;
    // A visited account may be used again after its own reset. Still exclude one whose reading proves it exhausted or
    // whose plan cannot run this model; launchOrder has already removed those from the candidate list.
    const snapshot = usage.find(item => item.accountId === id);
    const hasRoomEvidence = !!snapshot && (snapshot.usageAllowed === true || snapshot.windows.some(window => window.scope === "account" && window.usedPercent !== null && !fullUntilReset(window, now)));
    return !!snapshot && (snapshot.status === "ok" || snapshot.status === "stale") && hasRoomEvidence && blocker(snapshot, model, now) === null;
  });
}

export function failoverDecision(input: { currentId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number; excludedIds?: ReadonlySet<string> }): FailoverDecision | null {
  const { currentId, usage, now } = input;
  const evidence = { defaultId: currentId, accounts: input.accounts, usage, model: input.model, now };
  if (defaultBlocker(evidence) !== "exhausted") return null;
  const resets = (usage.find(item => item.accountId === currentId)?.windows ?? [])
    .filter(window => fullUntilReset(window, now))
    .map(window => window.resetsAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const resetsAt = resets[0] ?? null;
  const toId = failoverCandidates(input)?.[0];
  return toId ? { kind: "offer", fromId: currentId, toId, resetsAt } : { kind: "none", fromId: currentId, resetsAt };
}

/** The time at which an account can become usable again. An account with several full windows is blocked until the
 * last one resets. A provider verdict without a reset time cannot be scheduled, so it returns null. */
export function accountResetAt(snapshot: UsageSnapshot | undefined, now: number): string | null {
  if (!snapshot) return null;
  const resets = snapshot.windows.filter(window => fullUntilReset(window, now)).map(window => window.resetsAt!).sort((a, b) => Date.parse(b) - Date.parse(a));
  return resets[0] ?? null;
}

/** The next known reset across the accounts in a provider. The earliest account that becomes usable resumes the chat;
 * within one account the latest full window still wins. */
export function nextResetAt(accounts: readonly SelectionAccount[], usage: readonly UsageSnapshot[], now: number): string | null {
  return accounts.map(account => accountResetAt(usage.find(snapshot => snapshot.accountId === account.id), now)).filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

/** Whether the account's paid extra usage still has room: a spend window under 100%. Claude then keeps answering past
 * a full 5-hour window, so a completed turn on such an account did not run out. */
export function extraUsageLeft(snapshot: UsageSnapshot | undefined): boolean {
  return !!snapshot?.windows.some(window => window.scope === "spend" && window.usedPercent !== null && window.usedPercent < 100);
}

/** Whether the last reading of an account, read from the cache, gives reason to read it again after a turn that completed:
 * a full account-wide window until a later reset, or the provider's "not allowed" however old, unless paid extra usage
 * still has room. Claude reports a turn its limit stopped as completed, so this keeps every ordinary completed turn from
 * costing a provider request. */
export function mayBeUsedUp(cached: UsageSnapshot | undefined, now: number): boolean {
  return !!cached && !extraUsageLeft(cached) && (cached.usageAllowed === false || cached.windows.some(window => fullUntilReset(window, now)));
}

type Switch = { turnKey: string; fromId: string; toId: string; at: number };

/** Keeps duplicate lifecycle reports from starting the same automatic switch twice. The rotation itself is tracked by the
 * failover coordinator: it can visit every account, then waits for the next reset instead of imposing an hourly cap. */
export class AutoFailoverGuard {
  private readonly switches = new Map<string, Switch[]>();

  private recent(agentId: string): Switch[] {
    return this.switches.get(agentId) ?? [];
  }

  allow(agentId: string, turnKey: string, fromId: string, toId: string, now: number): boolean {
    void now;
    if (fromId === toId) return false;
    return !this.recent(agentId).some(item => item.turnKey === turnKey);
  }

  /** Whether this turn already had its automatic switch: a turn reported again must not be offered or switched twice. */
  hasTurn(agentId: string, turnKey: string, now: number): boolean {
    void now;
    return this.recent(agentId).some(item => item.turnKey === turnKey);
  }

  record(agentId: string, turnKey: string, fromId: string, toId: string, now: number): void {
    this.switches.set(agentId, [...this.recent(agentId), { turnKey, fromId, toId, at: now }].slice(-256));
  }
}
