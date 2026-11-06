import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { AccountCard, type SignInActions } from "./account-card";
import { ScrollView, Text, View } from "react-native";
import { addAccount, cliName, missingCli, refreshUsage, setAutoFailover, setFallback, setIntegration, startLogin,
  type Account, type AccountState, type LoginSession, type Provider } from "../shared/contracts";
import { body, Button, Field, IconButton, InlineAction, muted, Notice, row, Segmented, type ThemeProps } from "./components";
import { useAccountsData, useAction, useNow } from "./data";
import { errorMessage, providerName } from "./format";
import { addOrResumeLogin, type LoginMode } from "./login";
import { SignInDialog, type SignInTarget } from "./sign-in";
import { closeSignInTarget, visibleSignInTarget } from "./sign-in-state";

export type AccountsProps = PluginSurfaceProps & { onChanged(): void; runtimeError?: string | null };

const loginModes = [{ value: "device", label: "Device code" }, { value: "browser", label: "In browser" }] as const;
const providers = [{ value: "claude", label: providerName.claude }, { value: "codex", label: providerName.codex }] as const;
type ProviderOption = (typeof providers)[number];

// A system account stands for a CLI the daemon does not have. Managed sign-ins stay listed so they can be removed.
function listed(account: Account, state: AccountState): boolean {
  return state.providers[account.provider].available || account.source === "managed";
}

function AddAccountForm({ theme, host, onChanged, initialProvider, options, onClose, onStarted }: AccountsProps & Pick<SignInActions, "onStarted"> & { initialProvider: Provider; options: readonly ProviderOption[]; onClose(): void }) {
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
      <Segmented<Provider> theme={theme} label="Provider" value={provider} options={options} onChange={setProvider} disabled={busy || Boolean(created)} />
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

/** Whether a chat whose turn ran out of its account's limit offers a switch or makes it. `run` is the screen's action lock. */
export function AutoFailoverSetting({ theme, provider, enabled, disabled, run }: ThemeProps & {
  provider: Provider; enabled: boolean; disabled: boolean; run(action: () => Promise<unknown>): void;
}) {
  const save = useRpc(setAutoFailover);
  return <SettingsSelect label="When a limit runs out during a chat" value={enabled ? "auto" : "offer"} disabled={disabled}
    hint={enabled ? "Switches within this provider, up to 3 times per hour. Failed turns continue automatically." : "The chat offers another signed-in account."}
    onValueChange={value => run(() => save({ provider, enabled: value === "auto" }))}
    options={[{ value: "offer", label: "Offer a switch" }, { value: "auto", label: "Switch automatically" }]} />;
}

export function AccountsSurface(props: AccountsProps) {
  const { theme, layout, host, runtimeError, onChanged } = props;
  const { accounts, usage } = useAccountsData(host.id);
  const refresh = useRpc(refreshUsage);
  const integration = useRpc(setIntegration);
  const fallback = useRpc(setFallback);
  const action = useAction(host.id, onChanged);
  const now = useNow();
  const [adding, setAdding] = useState<Provider | null>(null);
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const visibleSignIn = visibleSignInTarget(signIn, host.id);
  const onStarted = (account: Account, session: LoginSession) => setSignIn({ account, hostId: host.id, sessionId: session.id, initial: session, autoOpen: true });
  const onResume = (account: Account, sessionId: string) => setSignIn({ account, hostId: host.id, sessionId, autoOpen: false });
  const state = accounts.data;
  const checksOff = usage.data?.checksOff === true;
  const enabled = state?.integration.enabled ?? false;
  const installed = providers.filter((option) => state?.providers[option.value].available ?? true);
  const enableIntegration = () => action.run(() => integration({ enabled: true }));
  return <><ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 12, width: "100%", maxWidth: 960, alignSelf: "center", paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 22, fontWeight: "700" }}>Accounts</Text>
        <Text style={muted(theme)}>{state ? `${state.accounts.filter(account => listed(account, state)).length} accounts on this host` : accounts.isPending ? "Loading…" : "Data unavailable"}</Text>
      </View>
      <IconButton theme={theme} icon="RefreshCw" label="Refresh all limits" disabled={action.isPending || checksOff} onPress={() => action.run(() => refresh({}))} />
      <Button theme={theme} variant="primary" disabled={action.isPending || (!adding && !installed.length)} onPress={() => setAdding(adding ? null : installed[0]?.value ?? null)}>{adding ? "Close" : "Add account"}</Button>
    </View>
    {state ? <SettingsCard><SettingsSwitch label="Account switching" value={enabled} disabled={action.isPending}
      hint={enabled ? "Choose an account from the chat composer. Running chats keep their account." : "Off. Agents use this host’s CLI sign-in."}
      onValueChange={value => action.run(() => integration({ enabled: value }))} /></SettingsCard> : null}
    {state?.integration.error ? <Notice theme={theme} tone="danger">{state.integration.error}</Notice> : null}
    {checksOff ? <Notice theme={theme} tone="warning">Check usage is off in this host's settings: limits stop updating, and a used-up account gets no switch offer.</Notice> : null}
    {runtimeError ? <Notice theme={theme} tone="danger">{runtimeError}</Notice> : null}
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    {accounts.error ? <Notice theme={theme} tone="danger">Could not refresh accounts: {errorMessage(accounts.error)}</Notice> : null}
    {usage.error ? <Notice theme={theme} tone="danger">Could not refresh limits: {errorMessage(usage.error)}</Notice> : null}
    {adding ? <AddAccountForm key={adding} {...props} initialProvider={adding} options={installed} onStarted={onStarted} onClose={() => setAdding(null)} /> : null}
    {state ? (["claude", "codex"] as const).map((provider) => {
      const status = state.providers[provider];
      const group = state.accounts.filter((account) => account.provider === provider && listed(account, state));
      return <SettingsSection key={provider} title={providerName[provider]}>
        {!status.available ? <Notice theme={theme}>{missingCli(provider)}</Notice>
          : enabled && !status.integrated ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <View style={{ flex: 1, minWidth: 200 }}><Notice theme={theme} tone="warning">Account switching is off for {cliName[provider]}: its agents use the system CLI.</Notice></View>
            <Button theme={theme} disabled={action.isPending} onPress={enableIntegration}>Enable</Button>
          </View> : null}
        {group.map((account) => <AccountCard key={account.id} {...props} account={account} state={state} snapshot={usage.data?.accounts.find((item) => item.accountId === account.id)} checksOff={checksOff} now={now} onStarted={onStarted} onResume={onResume} />)}
        {group.length > 1 ? <SettingsCard>
          {state.defaults[provider] ? <SettingsSelect label="When the default is unavailable" value={state.fallback[provider] ? "fallback" : "default"}
            hint="Applies to new agents. Existing chats keep their account." disabled={action.isPending}
            onValueChange={value => action.run(() => fallback({ provider, enabled: value === "fallback" }))}
            options={[{ value: "fallback", label: "Start on another account" }, { value: "default", label: "Always use the default" }]} /> : null}
          <AutoFailoverSetting theme={theme} provider={provider} enabled={state.autoFailover[provider]} disabled={action.isPending} run={action.run} />
        </SettingsCard> : null}
        {!group.length && status.available ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={muted(theme)}>No accounts.</Text>
          <InlineAction theme={theme} onPress={() => setAdding(provider)}>Add</InlineAction>
        </View> : null}
      </SettingsSection>;
    }) : null}
    {state ? <Text style={muted(theme)}>Limits update every minute here and every 5 minutes in the background.</Text> : null}
  </ScrollView>{visibleSignIn ? <SignInDialog key={visibleSignIn.sessionId} {...props} target={visibleSignIn} onClose={() => setSignIn(current => closeSignInTarget(current, visibleSignIn, host.id))} /> : null}</>;
}
