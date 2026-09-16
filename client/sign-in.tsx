import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { cancelLogin, getLoginStatus, submitLoginCode } from "../shared/contracts";
import { body, Button, Disclosure, muted, Notice, row, tabular } from "./components";
import { accountsKey, usageKey, useAccountsData, useAction } from "./data";
import { errorMessage, providerName } from "./format";
import { performLoginLinkAction } from "./login";
import { openExternal, prefersCopiedLink } from "./web";
import { canCancelSignIn, signInQueryOptions, submitSignInCode, type SignInTarget } from "./sign-in-state";

export type { SignInTarget } from "./sign-in-state";

export function SignInDialog({ target, theme, host, onChanged, onClose }: PluginSurfaceProps & {
  target: SignInTarget; onChanged(): void; onClose(): void;
}) {
  const read = useRpc(getLoginStatus);
  const submit = useRpc(submitLoginCode);
  const cancel = useRpc(cancelLogin);
  const cache = useQueryClient();
  const { accounts } = useAccountsData(host.id);
  const action = useAction(host.id, onChanged);
  const session = useQuery(signInQueryOptions(target, read, action.isPending));
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const autoOpened = useRef(false);
  const copyFirst = prefersCopiedLink();
  const current = session.data;
  const finished = current?.status === "complete" || current?.status === "error";
  const canCancel = canCancelSignIn(current?.status, accounts.data?.accounts.find(account => account.id === target.account.id), target.sessionId);
  useEffect(() => {
    if (finished) {
      setCode("");
      void cache.invalidateQueries({ queryKey: accountsKey(host.id) });
      void cache.invalidateQueries({ queryKey: usageKey(host.id) });
      onChanged();
    }
  }, [finished, cache, host.id, onChanged]);
  useEffect(() => {
    if (!target.autoOpen || autoOpened.current || session.error || !current?.authorizationUrl || current.status !== "waiting") return;
    autoOpened.current = true;
    void performLoginLinkAction(current, copyFirst ? copyText : openExternal)
      .then(() => { if (copyFirst) setNotice("Sign-in link copied. Open it in your browser."); })
      .catch(error => setLinkError(errorMessage(error)));
  }, [current, target.autoOpen, session.error, copyFirst]);
  const linkAction = (kind: "open" | "copy") => action.run(async () => {
    if (!current) return;
    setNotice(null); setLinkError(null);
    await performLoginLinkAction(current, kind === "open" ? openExternal : copyText);
    if (kind === "copy") setNotice("Sign-in link copied.");
  });
  const submitCode = () => action.run(async () => {
    await submitSignInCode(cache, target, () => submit({ accountId: target.account.id, sessionId: target.sessionId, code: code.trim() }));
    setCode(""); setNotice(null);
  });
  return <Modal title={`Sign in to ${providerName[target.account.provider]}`} open onOpenChange={open => { if (!open) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: 16, gap: 12 }} style={{ backgroundColor: theme.colors.surface0 }}>
      <Text style={{ ...body(theme), fontWeight: "600" }}>{target.account.label}</Text>
      {session.isPending || current?.status === "starting" ? <Text style={body(theme)}>Preparing sign-in…</Text> : null}
      {current?.status === "waiting" ? <Text style={body(theme)}>{copyFirst ? "Copy the link and open it in your browser." : "Continue in your browser. If it did not open, use the link below."}</Text> : null}
      {current?.provider === "codex" && current.mode === "browser" && !finished ? <Notice theme={theme}>Using another device? Cancel and choose Device code.</Notice> : null}
      {current?.status === "verifying" ? <Text style={body(theme)}>Checking sign-in…</Text> : null}
      {current?.status === "complete" ? <Notice theme={theme} tone="success">Signed in. Your limits will refresh automatically.</Notice> : null}
      {current?.authorizationUrl && !finished ? <View style={{ gap: 8 }}>
        <View style={row}>
          {!copyFirst ? <Button theme={theme} variant="primary" disabled={action.isPending || Boolean(session.error)} onPress={() => linkAction("open")}>Open browser</Button> : null}
          <Button theme={theme} variant={copyFirst ? "primary" : "secondary"} disabled={action.isPending || Boolean(session.error)} onPress={() => linkAction("copy")}>Copy link</Button>
        </View>
        <Disclosure theme={theme} title="Show sign-in link" open={showLink} onToggle={() => setShowLink(!showLink)}>
          <Text selectable style={{ ...muted(theme), flexShrink: 1 }}>{current.authorizationUrl}</Text>
        </Disclosure>
      </View> : null}
      {current?.userCode && !finished ? <View style={{ gap: 6 }}>
        <Text style={body(theme)}>Enter this code on the sign-in page:</Text>
        <View style={row}>
          <Text selectable style={{ ...body(theme), ...tabular, fontSize: 20, fontWeight: "600" }}>{current.userCode}</Text>
          <Button theme={theme} disabled={action.isPending || Boolean(session.error)} onPress={() => action.run(async () => { await copyText(current.userCode!); setNotice("Code copied."); })}>Copy code</Button>
        </View>
      </View> : null}
      {current?.canSubmitCode && current.status === "waiting" ? <View style={{ gap: 8 }}>
        <Text style={body(theme)}>If the browser gives you an authorization code, paste it here.</Text>
        <TextInput accessibilityLabel="Authorization code" placeholder="Paste authorization code" placeholderTextColor={theme.colors.foregroundMuted}
          value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} secureTextEntry maxLength={2048}
          onSubmitEditing={() => { if (code.trim() && !action.isPending && !session.error) submitCode(); }}
          style={{ ...body(theme), minHeight: 44, padding: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1 }} />
        <Button theme={theme} variant="primary" disabled={!code.trim() || action.isPending || Boolean(session.error)} onPress={submitCode}>Finish sign-in</Button>
      </View> : null}
      {current?.error ? <Notice theme={theme} tone="danger">{current.error}</Notice> : null}
      {session.error ? <View style={{ gap: 8 }}>
        <Notice theme={theme} tone="danger">{errorMessage(session.error)} Retrying status shortly.</Notice>
        <Button theme={theme} disabled={session.isFetching || action.isPending} onPress={() => { void session.refetch(); }}>Retry status</Button>
      </View> : null}
      {linkError ? <Notice theme={theme} tone="danger">{linkError}</Notice> : null}
      {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
      {notice ? <Notice theme={theme}>{notice}</Notice> : null}
      <View style={row}>
        <Button theme={theme} variant="ghost" onPress={onClose}>{finished ? "Done" : "Close"}</Button>
        {canCancel ? <Button theme={theme} disabled={action.isPending} onPress={() => action.run(async () => {
          await cancel({ accountId: target.account.id, sessionId: target.sessionId }); onClose();
        })}>Cancel sign-in</Button> : null}
      </View>
    </Modal.Content>
  </Modal>;
}
