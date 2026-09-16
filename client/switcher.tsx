import { useAgent, usePaseo, useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { applySwitch, prepareSwitch, refreshUsage } from "../shared/contracts";
import { body, Button, heading, InlineAction, muted, Notice, QuotaSummary, row, StatusDot, tabular } from "./components";
import { useAccountsData, useAction, useNow } from "./data";
import { currentAccount, currentAccountName, errorMessage, idleForSwitch, providerName, supportedProvider, usageSummary } from "./format";
import { accountAvailable } from "./login";

type SwitcherCallbacks = { onChanged(): void; openAccounts(): void; runtimeError?: string | null };
/** Modal body: the host's Modal.Content owns padding, vertical scrolling and sheet gestures. */
export function AgentSwitcher({ theme, host, agentId, onChanged, openAccounts, close, runtimeError }: PluginHostProps & SwitcherCallbacks & {
  agentId: string; close(): void;
}) {
  const selected = useAgent(agentId, ({ status, provider, attentionReason }) => ({ status, provider, attentionReason }));
  const paseo = usePaseo();
  const cache = useQueryClient();
  const agent = useMemo(() => paseo.agents.ref(agentId), [paseo, agentId]);
  const agentKey = useMemo(() => ["account-switcher", host.id, "agent", agentId] as const, [host.id, agentId]);
  const live = useQuery({ queryKey: agentKey, queryFn: async () => (await agent.refresh())?.agent ?? null, refetchInterval: 5_000, retry: 1 });
  useEffect(() => agent.subscribe((update) => {
    cache.setQueryData(agentKey, update.kind === "upsert" ? update.agent : null);
  }), [agent, cache, agentKey]);
  const { accounts, usage } = useAccountsData(host.id);
  const prepare = useRpc(prepareSwitch);
  const apply = useRpc(applySwitch);
  const refresh = useRpc(refreshUsage);
  const action = useAction(host.id, onChanged);
  const now = useNow();
  const state = accounts.data;
  const provider = supportedProvider(selected?.provider ?? live.data?.provider ?? "");
  const binding = state?.bindings.find((item) => item.agentId === agentId);
  const current = state && provider ? currentAccount(state, agentId, provider) : undefined;
  const unconfirmed = Boolean(binding && binding.currentAccountId === null);
  const pending = state?.accounts.find((account) => account.id === binding?.pendingAccountId);
  const snapshot = usage.data?.accounts.find((item) => item.accountId === current?.id);
  const enabled = state?.integration.enabled ?? false;
  const idle = !live.error && idleForSwitch(live.data) && selected?.status === "idle" && selected.attentionReason !== "permission";
  const switching = binding?.status === "switching";
  const disabled = action.isPending || switching || !enabled;
  const candidates = state?.accounts.filter((account) => account.provider === provider) ?? [];
  const agentState = live.isPending ? { text: "checking agent status", tone: "muted" as const }
    : idle ? { text: "agent idle", tone: "success" as const } : { text: "agent busy · apply after the response", tone: "warning" as const };
  const leave = () => { close(); openAccounts(); };
  return <View style={{ gap: 12, minWidth: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={muted(theme)}>Agent account{provider ? ` · ${providerName[provider]}` : ""}</Text>
        <Text numberOfLines={1} style={heading(theme)}>{state && provider ? currentAccountName(state, agentId, provider) : accounts.isPending ? "Loading…" : "Unknown"}</Text>
      </View>
      <Button theme={theme} variant="ghost" onPress={leave}>All accounts</Button>
    </View>
    {runtimeError ? <Notice theme={theme} tone="danger">{runtimeError}</Notice> : null}
    {binding?.error ? <Notice theme={theme} tone="danger">{binding.error}</Notice> : null}
    {accounts.error ? <Notice theme={theme} tone="danger">{errorMessage(accounts.error)}</Notice> : null}
    {usage.error ? <Notice theme={theme} tone="danger">{errorMessage(usage.error)}</Notice> : null}
    {live.error ? <Notice theme={theme} tone="danger">Agent status unconfirmed: {errorMessage(live.error)}</Notice> : null}
    {!provider && !live.isPending ? <Notice theme={theme}>Account switching is available for Claude and Codex only.</Notice> : null}
    {state && !enabled ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}><Notice theme={theme} tone="warning">Account switching is disabled in Accounts.</Notice></View>
      <InlineAction theme={theme} onPress={leave}>Open</InlineAction>
    </View> : null}
    {unconfirmed
      ? <Notice theme={theme} tone="warning">Account not confirmed. Choose an account below and apply it when the agent is idle.</Notice>
      : provider ? <QuotaSummary theme={theme} snapshot={snapshot} now={now} compact
        onRefresh={current ? () => action.run(() => refresh({ accountId: current.id })) : undefined} refreshing={action.isPending} /> : null}
    {candidates.length ? <View style={{ gap: 6 }}>
      <Text style={{ ...muted(theme), fontWeight: "600" }}>Switch to</Text>
      {candidates.map((account) => {
        const actual = current?.id === account.id;
        const prepared = pending?.id === account.id;
        const available = accountAvailable(account);
        const blocked = disabled || actual || !available;
        const detail = account.login ? "sign-in in progress · finish in Accounts"
          : !available ? "sign-in required · check in Accounts"
          : usageSummary(usage.data?.accounts.find((item) => item.accountId === account.id), now);
        return <Pressable key={account.id} accessibilityRole="button" accessibilityLabel={`Prepare account ${account.label}`}
          accessibilityState={{ disabled: blocked, selected: prepared }} disabled={blocked}
          onPress={() => action.run(() => prepare({ agentId, accountId: account.id }))}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1,
            borderColor: prepared ? theme.colors.accent : theme.colors.border,
            backgroundColor: prepared ? theme.colors.surface2 : theme.colors.surface1, opacity: pressed ? 0.7 : !available ? 0.6 : 1 })}>
          <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: "center", justifyContent: "center",
            borderColor: prepared || actual ? theme.colors.accent : theme.colors.foregroundMuted }}>
            {prepared || actual ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.accent, opacity: actual && !prepared ? 0.45 : 1 }} /> : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ ...body(theme), fontWeight: "600" }}>{account.label}</Text>
            <Text numberOfLines={1} style={{ ...muted(theme), ...tabular }}>{detail}</Text>
          </View>
          {actual ? <Text style={muted(theme)}>current</Text> : prepared ? <Text style={{ ...muted(theme), color: theme.colors.foreground, fontWeight: "600" }}>pending</Text> : null}
        </Pressable>;
      })}
    </View> : null}
    {pending ? <View style={{ gap: 8 }}>
      <View style={row}>
        <Button theme={theme} variant="primary" disabled={disabled || !idle || !accountAvailable(pending)} onPress={() => action.run(async () => {
          // Recheck immediately before requesting the daemon's own idle guard.
          const latest = (await agent.refresh())?.agent;
          cache.setQueryData(agentKey, latest ?? null);
          if (!idleForSwitch(latest)) throw new Error("The agent is now busy. Wait for the turn to finish, then apply your selection again.");
          await apply({ agentId });
        })}>{switching || action.isPending ? "Please wait…" : `Apply “${pending.label}”`}</Button>
        <Button theme={theme} variant="ghost" disabled={action.isPending || switching} onPress={() => action.run(() => prepare({ agentId, accountId: null }))}>Cancel selection</Button>
      </View>
      <Text style={muted(theme)}>{pending.login ? "Finish signing in to this account first." : idle ? "The agent session will restart with this account and keep its history." : "Wait for the response and permission requests to finish, then apply."}</Text>
    </View> : null}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <StatusDot theme={theme} tone={agentState.tone} />
      <Text style={muted(theme)}>{agentState.text}{action.isPending && !pending ? " · saving selection…" : ""}</Text>
    </View>
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
  </View>;
}
