import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { cancelLogin, checkLogin, refreshUsage, removeAccount, renameAccount, setDefaultAccount, startLogin,
  type Account, type AccountState, type LoginSession, type UsageSnapshot } from "../shared/contracts";
import type { AccountsProps } from "./accounts";
import { accountRemovalBlockers, signInFeedback } from "./account-state";
import { body, Button, Field, heading, muted, Notice, QuotaSummary, row, StatusDot, toneColor } from "./components";
import { useAction } from "./data";
import { accountStatus, errorMessage } from "./format";
import { accountAvailable, type LoginMode } from "./login";

export type SignInActions = { onStarted(account: Account, session: LoginSession): void; onResume(account: Account, sessionId: string): void };

export function AccountCard({ account, state, snapshot, checksOff, now, theme, layout, host, onChanged, onStarted, onResume }: AccountsProps & SignInActions & {
  account: Account; state: AccountState; snapshot: UsageSnapshot | undefined; checksOff: boolean; now: number;
}) {
  const rename = useRpc(renameAccount);
  const remove = useRpc(removeAccount);
  const setDefault = useRpc(setDefaultAccount);
  const login = useRpc(startLogin);
  const cancel = useRpc(cancelLogin);
  const check = useRpc(checkLogin);
  const refresh = useRpc(refreshUsage);
  const action = useAction(host.id, onChanged);
  const [panel, setPanel] = useState<"none" | "manage" | "rename" | "remove">("none");
  const [label, setLabel] = useState(account.label);
  const [notice, setNotice] = useState<ReturnType<typeof signInFeedback> | null>(null);
  useEffect(() => setNotice(null), [account.authStatus]);
  const isDefault = state.defaults[account.provider] === account.id;
  const inUse = state.bindings.filter(binding => binding.currentAccountId === account.id).length;
  const pending = state.bindings.filter(binding => binding.pendingAccountId === account.id).length;
  const managed = account.source === "managed";
  const loginSession = account.login;
  const status = accountStatus(account, snapshot);
  const busy = action.isPending;
  const needsLogin = managed && !loginSession && (account.authStatus === "needs_auth" || snapshot?.status === "needs_auth");
  const blockers = accountRemovalBlockers(account, state);
  const beginLogin = (mode?: LoginMode) => action.run(async () => {
    setNotice(null);
    const result = await login({ accountId: account.id, ...(mode ? { mode } : {}) });
    setPanel("none");
    onStarted(account, result);
  });
  const checkSignIn = () => action.run(async () => {
    setNotice(null);
    setNotice(signInFeedback(await check({ accountId: account.id })));
  });
  const changeDefault = (value: boolean) => action.run(() => setDefault({ provider: account.provider, accountId: value ? account.id : null }));
  const saveName = () => {
    if (busy || !label.trim()) return;
    action.run(async () => { await rename({ accountId: account.id, label: label.trim() }); setPanel("none"); });
  };
  const loginButtons = () => account.provider === "codex" ? <>
    <Button theme={theme} variant="primary" disabled={busy} onPress={() => beginLogin("device")}>Sign in with code</Button>
    <Button theme={theme} disabled={busy} onPress={() => beginLogin("browser")}>Use browser</Button>
  </> : <Button theme={theme} variant="primary" disabled={busy} onPress={() => beginLogin()}>Sign in</Button>;
  const meta = [account.email, !managed ? "Host CLI" : null, inUse ? `${inUse} agent${inUse === 1 ? "" : "s"}` : null, pending ? `${pending} pending` : null].filter(Boolean).join(" · ");
  const recovery = !loginSession && account.authStatus !== "ready" && (!snapshot?.error || snapshot.status === "needs_auth") ? signInFeedback(account) : null;
  const visibleNotice = notice?.tone === "success" || !snapshot?.error || snapshot.status === "needs_auth" ? notice || recovery : null;
  return <SettingsCard><View accessibilityLabel={`Account ${account.label}`} style={{ padding: layout.compact ? 12 : 16, gap: 10, minWidth: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 4 }}>
        <View style={row}>
          <Text selectable numberOfLines={1} style={{ ...heading(theme), flexShrink: 1 }}>{account.label}</Text>
          {isDefault ? <Text style={{ ...muted(theme), paddingHorizontal: 6, borderRadius: 4, backgroundColor: theme.colors.surface2 }}>Default</Text> : null}
        </View>
        <View style={{ ...row, gap: 6 }}>
          <StatusDot theme={theme} tone={status.tone} />
          <Text style={{ ...muted(theme), color: status.tone === "muted" || status.tone === "success" ? theme.colors.foregroundMuted : toneColor(theme, status.tone) }}>{status.text}</Text>
        </View>
        {meta ? <Text selectable style={muted(theme)}>{meta}</Text> : null}
      </View>
      <View style={{ ...row, gap: 4 }}>
        <Button theme={theme} variant="ghost" onPress={() => { setNotice(null); setPanel("manage"); }} label={`Manage ${account.label}`}>Manage</Button>
        {managed ? <Button theme={theme} variant="danger" disabled={busy} onPress={() => { setNotice(null); setPanel("remove"); }} label={`Remove ${account.label}`}>Remove</Button> : null}
      </View>
    </View>
    {loginSession ? <View style={{ gap: 6 }}>
      <Notice theme={theme} tone="warning">{"sessionId" in loginSession ? "Sign-in is open. Continue to finish, or cancel to start again." : "Cancel the previous terminal sign-in before starting again."}</Notice>
      <View style={row}>
        {"sessionId" in loginSession ? <Button theme={theme} variant="primary" disabled={busy} onPress={() => onResume(account, loginSession.sessionId)}>Continue sign-in</Button> : null}
        <Button theme={theme} disabled={busy} onPress={() => action.run(async () => {
          await cancel({ accountId: account.id, ...("sessionId" in loginSession ? { sessionId: loginSession.sessionId } : {}) });
          setNotice({ text: "Sign-in canceled.", tone: "muted" });
        })}>Cancel sign-in</Button>
      </View>
    </View> : needsLogin ? <View style={row}>{loginButtons()}</View>
      : account.authStatus !== "ready" ? <View style={row}><Button theme={theme} disabled={busy} onPress={checkSignIn}>{busy ? "Checking…" : "Check sign-in"}</Button></View> : null}
    {panel === "none" && visibleNotice ? <Notice theme={theme} tone={visibleNotice.tone}>{visibleNotice.text}</Notice> : null}
    {panel === "none" && action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    <QuotaSummary theme={theme} snapshot={snapshot} now={now} compact={layout.compact} hideAuth={Boolean(needsLogin || recovery || notice)}
      onRefresh={loginSession || checksOff ? undefined : () => action.run(() => refresh({ accountId: account.id }))} refreshing={busy} />
    {panel !== "none" ? <Modal title={panel === "remove" ? `Remove “${account.label}”?` : panel === "rename" ? "Rename account" : account.label} open onOpenChange={open => { if (!open) setPanel("none"); }}>
      <Modal.Content>
        {panel === "manage" ? <>
          <SettingsCard>
            <SettingsSwitch label="Default for new agents" hint="Existing chats keep their account." value={isDefault} disabled={busy || (!isDefault && !accountAvailable(account))} onValueChange={changeDefault} />
            <SettingsAction label="Sign-in" actionLabel={busy ? "Checking…" : "Check"} disabled={busy || Boolean(loginSession)} onPress={checkSignIn} />
            <SettingsAction label="Limits" actionLabel="Refresh" disabled={busy || checksOff || Boolean(loginSession)} onPress={() => action.run(() => refresh({ accountId: account.id }))} />
            {managed ? <SettingsAction label="Account name" actionLabel="Rename" disabled={busy} onPress={() => { setLabel(account.label); setNotice(null); setPanel("rename"); }} /> : null}
          </SettingsCard>
          {managed && !loginSession && !needsLogin ? <View style={{ gap: 6 }}><Text style={muted(theme)}>Sign in again</Text><View style={row}>{loginButtons()}</View></View> : null}
          {!managed ? <Text style={muted(theme)}>Uses this host’s CLI sign-in. Manage it in the CLI; it cannot be removed here.</Text> : null}
          {managed ? <Button theme={theme} variant="danger" disabled={busy} onPress={() => { setNotice(null); setPanel("remove"); }}>Remove account</Button> : null}
        </> : panel === "rename" ? <View style={{ gap: 12 }}>
          <Field theme={theme} value={label} onChangeText={setLabel} maxLength={80} accessibilityLabel={`New name for ${account.label}`} placeholder="Account name" autoCapitalize="sentences" autoFocus onSubmitEditing={saveName} />
          <View style={row}><Button theme={theme} variant="primary" disabled={busy || !label.trim()} onPress={saveName}>Save</Button><Button theme={theme} variant="ghost" disabled={busy} onPress={() => setPanel("manage")}>Cancel</Button></View>
        </View> : <>
          <Text style={body(theme)}>This removes the saved sign-in from Paseo. You can add the account again later.</Text>
          {blockers.map(message => <Notice key={message} theme={theme} tone="warning">{message}</Notice>)}
          {isDefault ? <Button theme={theme} disabled={busy} onPress={() => changeDefault(false)}>Clear default</Button> : null}
          <View style={row}>
            <Button theme={theme} variant="danger" disabled={busy || blockers.length > 0} onPress={() => action.run(() => remove({ accountId: account.id }))}>{busy ? "Removing…" : "Remove account"}</Button>
            <Button theme={theme} variant="ghost" disabled={busy} onPress={() => setPanel("none")}>Cancel</Button>
          </View>
        </>}
        {notice ? <Notice theme={theme} tone={notice.tone}>{notice.text}</Notice> : null}
        {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
      </Modal.Content>
    </Modal> : null}
  </View></SettingsCard>;
}
