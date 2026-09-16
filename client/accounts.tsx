import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { addAccount, cancelLogin, checkLogin, refreshUsage, removeAccount, renameAccount, setDefaultAccount, setIntegration, startLogin,
  type Account, type AccountState, type LoginSession, type Provider, type UsageSnapshot } from "../shared/contracts";
import { body, Button, Field, heading, IconButton, InlineAction, muted, Notice, QuotaSummary, row, Segmented, StatusDot, toneColor } from "./components";
import { useAccountsData, useAction, useNow } from "./data";
import { accountStatus, errorMessage, providerName } from "./format";
import { accountAvailable, addOrResumeLogin, type LoginMode } from "./login";
import { SignInDialog, type SignInTarget } from "./sign-in";
import { closeSignInTarget, visibleSignInTarget } from "./sign-in-state";

export type AccountsProps = PluginSurfaceProps & { onChanged(): void; runtimeError?: string | null };
type SignInActions = { onStarted(account: Account, session: LoginSession): void; onResume(account: Account, sessionId: string): void };

const loginModes = [{ value: "device", label: "Device code" }, { value: "browser", label: "In browser" }] as const;
const providers = [{ value: "claude", label: providerName.claude }, { value: "codex", label: providerName.codex }] as const;

function AccountCard({ account, state, snapshot, now, theme, layout, host, onChanged, onStarted, onResume }: AccountsProps & SignInActions & {
  account: Account; state: AccountState; snapshot: UsageSnapshot | undefined; now: number;
}) {
  const rename = useRpc(renameAccount);
  const remove = useRpc(removeAccount);
  const setDefault = useRpc(setDefaultAccount);
  const login = useRpc(startLogin);
  const cancel = useRpc(cancelLogin);
  const check = useRpc(checkLogin);
  const refresh = useRpc(refreshUsage);
  const action = useAction(host.id, onChanged);
  const [panel, setPanel] = useState<"none" | "menu" | "rename" | "remove">("none");
  const [label, setLabel] = useState(account.label);
  const [notice, setNotice] = useState<string | null>(null);
  const isDefault = state.defaults[account.provider] === account.id;
  const inUse = state.bindings.filter((binding) => binding.currentAccountId === account.id).length;
  const pending = state.bindings.filter((binding) => binding.pendingAccountId === account.id).length;
  const managed = account.source === "managed";
  const loginSession = account.login;
  const status = accountStatus(account, snapshot);
  const busy = action.isPending;
  const needsLogin = managed && !loginSession && !accountAvailable(account);
  const beginLogin = (mode?: LoginMode) => action.run(async () => {
    setNotice(null); setPanel("none");
    const result = await login({ accountId: account.id, ...(mode ? { mode } : {}) });
    onStarted(account, result);
  });
  const loginButtons = (variant: "primary" | "secondary") => account.provider === "codex" ? <>
    <Button theme={theme} variant={variant} disabled={busy} onPress={() => beginLogin("device")}>{needsLogin ? "Sign in with code" : "Sign in again with code"}</Button>
    <Button theme={theme} disabled={busy} onPress={() => beginLogin("browser")}>{needsLogin ? "In browser" : "Sign in again in browser"}</Button>
  </> : <Button theme={theme} variant={variant} disabled={busy} onPress={() => beginLogin()}>{needsLogin ? "Sign in" : "Sign in again"}</Button>;
  const meta = [
    account.email ?? (managed ? "separate profile" : "system CLI"),
    isDefault ? "default for new agents" : null,
    inUse ? `agents: ${inUse}` : null,
    pending ? `pending: ${pending}` : null,
  ].filter(Boolean).join(" · ");
  return <View accessibilityLabel={`Account ${account.label}`} style={{ borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: layout.compact ? 10 : 12, gap: 10, minWidth: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text selectable numberOfLines={1} style={heading(theme)}>{account.label}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <StatusDot theme={theme} tone={status.tone} />
          <Text style={{ ...muted(theme), color: status.tone === "muted" || status.tone === "success" ? theme.colors.foregroundMuted : toneColor(theme, status.tone) }}>{status.text}</Text>
          <Text selectable numberOfLines={1} style={{ ...muted(theme), flexShrink: 1 }}>· {meta}</Text>
        </View>
      </View>
      <View style={{ ...row, justifyContent: "flex-end" }}>
        {loginSession ? <>
          {"sessionId" in loginSession ? <Button theme={theme} variant="primary" onPress={() => onResume(account, loginSession.sessionId)}>Continue sign-in</Button> : null}
          <Button theme={theme} disabled={busy} onPress={() => action.run(async () => { await cancel({ accountId: account.id, ...("sessionId" in loginSession ? { sessionId: loginSession.sessionId } : {}) }); setNotice("Sign-in canceled. You can start again."); })}>Cancel sign-in</Button>
        </> : needsLogin ? loginButtons("primary") : null}
        <IconButton theme={theme} icon="MoreHorizontal" label={`Actions for ${account.label}`} active={panel !== "none"} onPress={() => setPanel(panel === "none" ? "menu" : "none")} />
      </View>
    </View>
    {loginSession ? <Notice theme={theme} tone="warning">
      {"sessionId" in loginSession ? "Finish signing in in your browser. Status and limits will update automatically." : "A sign-in from an older version is still open. Cancel it, then sign in again to use the browser flow."}
    </Notice> : null}
    {panel === "menu" ? <View style={{ ...row, paddingTop: 2 }}>
      <Button theme={theme} variant="ghost" disabled={busy || Boolean(loginSession)} onPress={() => action.run(() => refresh({ accountId: account.id }))}>Refresh limits</Button>
      <Button theme={theme} variant="ghost" disabled={busy} onPress={() => action.run(async () => {
        const result = await check({ accountId: account.id });
        setNotice(result.authStatus === "ready" ? "Sign-in confirmed. You can now select this account for agents." : "Sign-in is not confirmed yet. Finish signing in in your browser, then check again.");
      })}>Check sign-in</Button>
      {isDefault
        ? <Button theme={theme} variant="ghost" disabled={busy} onPress={() => action.run(() => setDefault({ provider: account.provider, accountId: null }))}>Clear default</Button>
        : <Button theme={theme} variant="ghost" disabled={busy || !accountAvailable(account)} onPress={() => action.run(() => setDefault({ provider: account.provider, accountId: account.id }))}>Default for new agents</Button>}
      {managed && !needsLogin && !loginSession ? loginButtons("secondary") : null}
      {managed ? <>
        <Button theme={theme} variant="ghost" disabled={busy} onPress={() => { setLabel(account.label); setPanel("rename"); }}>Rename</Button>
        <Button theme={theme} variant="danger" disabled={busy || Boolean(loginSession)} onPress={() => setPanel("remove")}>Remove</Button>
      </> : null}
    </View> : null}
    {panel === "rename" ? <View style={row}>
      <Field theme={theme} value={label} onChangeText={setLabel} maxLength={80} accessibilityLabel={`New name for ${account.label}`} placeholder="Account name" autoCapitalize="sentences" autoFocus
        onSubmitEditing={() => label.trim() && action.run(async () => { await rename({ accountId: account.id, label: label.trim() }); setPanel("none"); })} />
      <Button theme={theme} variant="primary" disabled={busy || !label.trim()} onPress={() => action.run(async () => { await rename({ accountId: account.id, label: label.trim() }); setPanel("none"); })}>Save</Button>
      <Button theme={theme} variant="ghost" disabled={busy} onPress={() => setPanel("none")}>Cancel</Button>
    </View> : null}
    {panel === "remove" ? <View style={{ gap: 8 }}>
      <Notice theme={theme} tone="danger">Remove “{account.label}” and its saved sign-in? {inUse || pending ? "An agent is using this account or has it pending: choose another account first." : "You will need to sign in again if you add it later."}</Notice>
      <View style={row}>
        <Button theme={theme} variant="danger" disabled={busy || Boolean(loginSession) || inUse > 0 || pending > 0} onPress={() => action.run(() => remove({ accountId: account.id }))}>Yes, remove</Button>
        <Button theme={theme} variant="ghost" disabled={busy} onPress={() => setPanel("none")}>Keep account</Button>
      </View>
    </View> : null}
    {notice ? <Notice theme={theme}>{notice}</Notice> : null}
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    <QuotaSummary theme={theme} snapshot={snapshot} now={now} compact={layout.compact}
      onRefresh={loginSession ? undefined : () => action.run(() => refresh({ accountId: account.id }))} refreshing={busy} />
  </View>;
}

function AddAccountForm({ theme, host, onChanged, initialProvider, onClose, onStarted }: AccountsProps & Pick<SignInActions, "onStarted"> & { initialProvider: Provider; onClose(): void }) {
  const add = useRpc(addAccount);
  const login = useRpc(startLogin);
  const action = useAction(host.id, onChanged);
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<LoginMode>("device");
  // The account created by a failed first attempt; later submits only reopen its login.
  const [created, setCreated] = useState<Account | null>(null);
  const busy = action.isPending;
  const submit = () => (created || label.trim()) && action.run(async () => {
    let account = created;
    const session = await addOrResumeLogin({ provider, label: label.trim(), mode, created }, { add, start: login, onCreated: value => { account = value; setCreated(value); } });
    // Failed authorization startup keeps the created account available for retry.
    onClose();
    if (account) onStarted(account, session);
  });
  return <View style={{ gap: 10, padding: 12, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10 }}>
    <View style={row}>
      <Segmented<Provider> theme={theme} label="Provider" value={provider} options={providers} onChange={setProvider} disabled={busy || Boolean(created)} />
      {provider === "codex" ? <Segmented<LoginMode> theme={theme} label="ChatGPT sign-in method" value={mode} options={loginModes} onChange={setMode} disabled={busy} /> : null}
    </View>
    <View style={row}>
      {created ? <Text style={{ ...body(theme), flexGrow: 1, minWidth: 160 }}>Account “{created.label}” was added, but sign-in has not started.</Text>
        : <Field theme={theme} value={label} onChangeText={setLabel} maxLength={80} placeholder="Name, e.g. Personal" accessibilityLabel="New account name" autoFocus onSubmitEditing={submit} />}
      <Button theme={theme} variant="primary" disabled={busy || (!created && !label.trim())} onPress={submit}>{busy ? "Starting sign-in…" : created ? "Retry sign-in" : "Add and sign in"}</Button>
      <Button theme={theme} variant="ghost" disabled={busy} onPress={onClose}>{created ? "Close" : "Cancel"}</Button>
    </View>
    <Text style={muted(theme)}>{created ? "The account is already listed below. You can also start sign-in from its card." : provider === "codex" ? mode === "device" ? "Open the sign-in link on any device and enter the code shown here." : "Browser sign-in must finish on the daemon’s computer. Use Device code for another device." : "Continue in your browser, or copy the sign-in link to another device."}</Text>
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
  </View>;
}

export function AccountsSurface(props: AccountsProps) {
  const { theme, layout, host, runtimeError, onChanged } = props;
  const { accounts, usage } = useAccountsData(host.id);
  const refresh = useRpc(refreshUsage);
  const integration = useRpc(setIntegration);
  const action = useAction(host.id, onChanged);
  const now = useNow();
  const [adding, setAdding] = useState<Provider | null>(null);
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const visibleSignIn = visibleSignInTarget(signIn, host.id);
  const onStarted = (account: Account, session: LoginSession) => setSignIn({ account, hostId: host.id, sessionId: session.id, initial: session, autoOpen: true });
  const onResume = (account: Account, sessionId: string) => setSignIn({ account, hostId: host.id, sessionId, autoOpen: false });
  const state = accounts.data;
  const enabled = state?.integration.enabled ?? false;
  const toggleIntegration = () => action.run(() => integration({ enabled: !enabled }));
  return <><ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 12, width: "100%", maxWidth: 960, alignSelf: "center", paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 22, fontWeight: "700" }}>Accounts</Text>
        {state ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={muted(theme)}>Accounts: {state.accounts.length} · switching {enabled ? "on" : "off"}</Text>
          {enabled ? <InlineAction theme={theme} disabled={action.isPending} onPress={toggleIntegration}>Disable</InlineAction> : null}
        </View> : <Text style={muted(theme)}>{accounts.isPending ? "Loading…" : "Data unavailable"}</Text>}
      </View>
      <IconButton theme={theme} icon="RefreshCw" label="Refresh all limits" disabled={action.isPending} onPress={() => action.run(() => refresh({}))} />
      <Button theme={theme} variant="primary" disabled={action.isPending} onPress={() => setAdding(adding ? null : "claude")}>{adding ? "Close" : "Add"}</Button>
    </View>
    {state && !enabled ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 200 }}><Notice theme={theme} tone="warning">Account switching in the composer is off: agents use the system CLI.</Notice></View>
      <Button theme={theme} disabled={action.isPending} onPress={toggleIntegration}>Enable</Button>
    </View> : null}
    {state?.integration.error ? <Notice theme={theme} tone="danger">{state.integration.error}</Notice> : null}
    {runtimeError ? <Notice theme={theme} tone="danger">{runtimeError}</Notice> : null}
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    {accounts.error ? <Notice theme={theme} tone="danger">Could not refresh accounts: {errorMessage(accounts.error)}</Notice> : null}
    {usage.error ? <Notice theme={theme} tone="danger">Could not refresh limits: {errorMessage(usage.error)}</Notice> : null}
    {adding ? <AddAccountForm key={adding} {...props} initialProvider={adding} onStarted={onStarted} onClose={() => setAdding(null)} /> : null}
    {state ? (["claude", "codex"] as const).map((provider) => {
      const group = state.accounts.filter((account) => account.provider === provider);
      return <View key={provider} style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingTop: 4 }}>
          <Text accessibilityRole="header" style={heading(theme)}>{providerName[provider]}</Text>
          <Text style={muted(theme)}>{group.length}</Text>
        </View>
        {group.map((account) => <AccountCard key={account.id} {...props} account={account} state={state} snapshot={usage.data?.accounts.find((item) => item.accountId === account.id)} now={now} onStarted={onStarted} onResume={onResume} />)}
        {!group.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={muted(theme)}>No accounts.</Text>
          <InlineAction theme={theme} onPress={() => setAdding(provider)}>Add</InlineAction>
        </View> : null}
      </View>;
    }) : null}
    {state ? <Text style={{ ...muted(theme), paddingTop: 4 }}>Limits refresh every minute while this panel is open and every 5 minutes in the background. The default account applies to new agents.</Text> : null}
  </ScrollView>{visibleSignIn ? <SignInDialog key={visibleSignIn.sessionId} {...props} target={visibleSignIn} onClose={() => setSignIn(current => closeSignInTarget(current, visibleSignIn, host.id))} /> : null}</>;
}
