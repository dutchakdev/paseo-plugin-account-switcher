import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hashAccountKey, windowFromReportedDuration, type UsageAccount, type UsageDetail, type UsageReport, type UsageScope, type UsageWindow as PaseoWindow } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { cliName, type Provider, type UsageSnapshot, type UsageWindow } from "../shared/contracts";
import type { Registry } from "./store";

// Paseo's Usage view lists every source's accounts side by side. This source adds the managed accounts, from the limits the plugin already collects.
const SOURCE_ID = "account-switcher";
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// A store locator for `fetch`, never a credential.
const InputSchema = z.object({ accountId: z.string().min(1) });

/** The part of AccountController this source reads; the controller satisfies it. */
export interface UsageController {
  ready: Promise<void>;
  store: { read(): Promise<Pick<Registry, "accounts">> };
  usage: { list(): Promise<UsageSnapshot[]> };
}

/**
 * Paseo's stable key for an account: the Codex account ID as is, a Claude identity with its `provider:` prefix written `provider-`.
 * Anything Paseo would refuse (an email, a long or empty value) is replaced by a hash, so the key never exposes the identity.
 */
export function usageKey(provider: Provider, identityKey: string): string {
  const prefix = `${provider}:`;
  const key = identityKey.startsWith(prefix) ? `${provider}-${identityKey.slice(prefix.length)}` : identityKey;
  return KEY_PATTERN.test(key) ? key : hashAccountKey(identityKey);
}

/**
 * Managed accounts for the Usage view's global list. The system account is left to Paseo's built-in source, and so is any managed account signed in as that same login.
 * The session scope is also left to the built-in source: the account profile in an agent's environment (see session-env.ts) already points it at the right login.
 */
export function discoverAccounts(registry: Pick<Registry, "accounts">, scope: UsageScope): UsageAccount[] {
  if (scope.kind !== "global") return [];
  const systemIdentity = (provider: Provider) => registry.accounts.find(a => a.source === "system" && a.provider === provider)?.identityKey ?? null;
  const found = new Map<string, UsageAccount>();
  for (const account of registry.accounts) {
    // `loginToken` marks a sign-in still in progress. An `error` status is a failed check, so the last limits stay worth showing.
    if (account.source !== "managed" || account.authStatus === "needs_auth" || account.loginToken || !account.identityKey) continue;
    if (account.identityKey === systemIdentity(account.provider)) continue;
    const key = usageKey(account.provider, account.identityKey);
    // Two accounts signed in as one login are one account to Paseo, which wants unique keys.
    if (found.has(key)) continue;
    found.set(key, { key, label: account.label, harness: cliName[account.provider], input: { accountId: account.id } });
  }
  return [...found.values()];
}

function paseoWindow(window: UsageWindow): PaseoWindow {
  const model = window.scope === "model";
  const mapped = windowFromReportedDuration({
    durationSeconds: window.windowDurationMins === null ? null : window.windowDurationMins * 60,
    scope: model ? { id: window.id, label: window.label } : undefined,
    unknown: { id: window.id, label: window.label, shortLabel: "" },
    utilizationPct: window.usedPercent,
    resetsAt: window.resetsAt,
    summary: window.scope === "account",
  });
  if (!model) return mapped;
  // The plugin's model label already names the duration ("Weekly · sonnet"), so the helper's would repeat it.
  const { shortLabel: _repeated, ...rest } = mapped;
  return { ...rest, label: window.label };
}

export function usageReport(snapshot: UsageSnapshot | undefined): UsageReport {
  if (snapshot?.status === "needs_auth") return { status: "error", error: "Needs sign-in in Account Switcher." };
  if (!snapshot || snapshot.status === "unavailable") return { status: "error", error: "No usage data from the provider yet." };
  // A stale snapshot keeps the last good reading; the plugin's own view marks it, Paseo's has no place for that.
  const windows = snapshot.windows.map(paseoWindow);
  const details = snapshot.windows.flatMap((window, index): UsageDetail[] => {
    const text = window.detail?.trim();
    const shown = windows[index];
    return text && shown ? [{ id: shown.id, label: shown.label, value: text }] : [];
  });
  return { status: "available", ...(snapshot.plan ? { planLabel: snapshot.plan } : {}), windows, ...(details.length ? { details } : {}) };
}

/** Registers the source; false on a daemon without usage sources (Paseo before 0.11). */
export function registerPaseoUsage(server: PluginServerContext, controller: UsageController): boolean {
  if (typeof server.registerUsageSource !== "function") return false;
  server.registerUsageSource({
    id: SOURCE_ID,
    label: "Account Switcher",
    input: InputSchema,
    async discover(scope) {
      await controller.ready;
      return discoverAccounts(await controller.store.read(), scope);
    },
    // The plugin's cached snapshot: opening the Usage view never costs a provider request.
    async fetch(input) {
      const { accountId } = InputSchema.parse(input);
      const snapshots = await controller.usage.list();
      return usageReport(snapshots.find(snapshot => snapshot.accountId === accountId));
    },
  });
  return true;
}
