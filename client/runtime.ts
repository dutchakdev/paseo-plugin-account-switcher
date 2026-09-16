import type { PaseoAgent } from "@getpaseo/client";
import type { PluginButtonIcon, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listAccounts, listUsage, type AccountState, type UsageSnapshot } from "../shared/contracts";
import { currentAccount, currentAccountName, errorMessage, supportedProvider, usageSummary } from "./format";

export type PillTarget = Readonly<{ workspaceId: string; agentId: string }>;

/**
 * One runtime per installation; teardown also guards late bootstrap/RPC results.
 * The action pill selects a modal target. Its stable custom icon hosts the SDK modal,
 * so the picker stays in the composer context without a separate workspace panel.
 */
export function createClientRuntime(client: PluginClientContext, icon: PluginButtonIcon) {
  const agents = new Map<string, PaseoAgent>();
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  const listeners = new Set<() => void>();
  const directoryChanges = new Set<string>();
  let state: AccountState | undefined;
  let usage: UsageSnapshot[] = [];
  let directoryError: string | null = null;
  let dataError: string | null = null;
  let stopped = false;
  let loadingDirectory = false;
  let loadingData = false;
  let queuedRefresh = false;
  let modalTarget: PillTarget | null = null;
  const subscriptionId = `account-switcher-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function notify() { for (const listener of listeners) listener(); }
  function closeModal(expected: PillTarget) {
    // A late dismissal from an older dialog must not close a newer target,
    // including a later opening for the same agent.
    if (modalTarget !== expected) return;
    modalTarget = null; notify();
  }
  function openModal(target: PillTarget) {
    const agent = agents.get(target.agentId);
    if (stopped || !agent || agent.archivedAt || agent.workspaceId !== target.workspaceId || !supportedProvider(agent.provider)) return;
    if (modalTarget?.agentId === target.agentId && modalTarget.workspaceId === target.workspaceId) return;
    modalTarget = { ...target }; notify();
  }
  function removePill(agentId: string) {
    if (modalTarget?.agentId === agentId) closeModal(modalTarget);
    pills.get(agentId)?.registration.remove(); pills.delete(agentId);
  }
  function updatePill(agent: PaseoAgent) {
    const provider = supportedProvider(agent.provider);
    const existing = pills.get(agent.id);
    if (!provider || !agent.workspaceId || agent.archivedAt) {
      removePill(agent.id); return;
    }
    const current = state ? currentAccount(state, agent.id, provider) : undefined;
    const binding = state?.bindings.find((item) => item.agentId === agent.id);
    const summary = usageSummary(usage.find((item) => item.accountId === current?.id));
    const label = !state ? "Account · loading…" : `${currentAccountName(state, agent.id, provider)} · ${summary}${binding?.pendingAccountId ? " →" : ""}${dataError ? " · error" : ""}`;
    const title = `${label}. Choose an account and view limits`;
    if (existing?.workspaceId === agent.workspaceId) { existing.registration.update({ title, label }); return; }
    removePill(agent.id);
    const target: PillTarget = { workspaceId: agent.workspaceId, agentId: agent.id };
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration: client.addComposerPill({
      id: `account-${agent.id}`, workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title, label, icon, behavior: { kind: "action", onPress: () => openModal(target) } },
    }) });
  }
  function updateAllPills() { for (const agent of agents.values()) updatePill(agent); }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (stopped) return;
    const id = update.kind === "upsert" ? update.agent.id : update.agentId;
    if (loadingDirectory) directoryChanges.add(id);
    if (update.kind === "upsert") { agents.set(id, update.agent); updatePill(update.agent); }
    else { agents.delete(id); removePill(id); }
  });

  async function refreshDirectory() {
    if (stopped || loadingDirectory) return;
    loadingDirectory = true;
    directoryChanges.clear();
    try {
      const listed = new Map<string, PaseoAgent>();
      let cursor: string | undefined;
      do {
        const result = await client.paseo.agents.list({ scope: "active", page: { limit: 100, ...(cursor ? { cursor } : {}) }, subscribe: { subscriptionId } });
        if (stopped) return;
        for (const entry of result.entries) listed.set(entry.agent.id, entry.agent);
        const next = result.pageInfo.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
        if (next && next === cursor) throw new Error("Could not load the next page of agents.");
        cursor = next;
      } while (cursor);
      for (const [id, agent] of listed) if (!directoryChanges.has(id)) agents.set(id, agent);
      for (const id of agents.keys()) if (!listed.has(id) && !directoryChanges.has(id)) {
        agents.delete(id); removePill(id);
      }
      directoryError = null;
      updateAllPills();
    } catch (error) {
      if (!stopped) directoryError = `Could not refresh agent account switchers: ${errorMessage(error)}`;
    } finally { loadingDirectory = false; if (!stopped) notify(); }
  }

  async function refreshData() {
    if (stopped) return;
    if (loadingData) { queuedRefresh = true; return; }
    loadingData = true;
    try {
      // Read cached usage without renewing the visible-panel lease from a closed pill.
      const results = await Promise.allSettled([client.rpc(listAccounts, {}), client.rpc(listUsage, {})]);
      if (stopped) return;
      const [accountsResult, usageResult] = results;
      if (accountsResult.status === "fulfilled") state = accountsResult.value;
      if (usageResult.status === "fulfilled") usage = usageResult.value.accounts;
      dataError = accountsResult.status === "rejected" ? `Could not refresh accounts: ${errorMessage(accountsResult.reason)}`
        : usageResult.status === "rejected" ? `Could not refresh limits: ${errorMessage(usageResult.reason)}` : null;
      updateAllPills(); notify();
    } catch (error) {
      if (!stopped) { dataError = `Could not refresh account switchers: ${errorMessage(error)}`; notify(); }
    } finally {
      loadingData = false;
      if (queuedRefresh && !stopped) { queuedRefresh = false; void refreshData(); }
    }
  }

  void refreshDirectory();
  void refreshData();
  const timer = setInterval(() => { void refreshDirectory(); void refreshData(); }, 30_000);
  return {
    refresh() { void refreshDirectory(); void refreshData(); },
    getError: () => directoryError ?? dataError,
    getModalTarget: () => modalTarget,
    closeModal,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() {
      if (stopped) return;
      stopped = true; clearInterval(timer); unsubscribe();
      if (modalTarget) closeModal(modalTarget);
      listeners.clear();
      for (const { registration } of pills.values()) registration.remove();
      pills.clear(); agents.clear();
    },
  };
}
