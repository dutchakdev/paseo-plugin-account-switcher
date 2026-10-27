import type { PluginButtonIconProps, PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useSyncExternalStore } from "react";
import { applySwitch, listAccounts, listUsage, prepareSwitch } from "./shared/contracts";
import { FAILOVER_KIND, FAILOVER_VERSION, FailoverRowSchema } from "./shared/failover";
import { ACCOUNT_NOTE_KIND, ACCOUNT_NOTE_VERSION, AccountNoteSchema } from "./shared/timeline";
import { AccountsSurface } from "./client/accounts";
import { runAccountCommand } from "./client/command";
import { createFailoverRow } from "./client/failover-row";
import { AccountNoteRow } from "./client/note";
import { supportedProvider } from "./client/format";
import { createClientRuntime } from "./client/runtime";
import { openAccounts, registerAccountsScreen } from "./client/screens";
import { AgentSwitcher } from "./client/switcher";

export default function contribute(client: PluginClientContext) {
  const showAccounts = () => openAccounts(client);
  const runtime = createClientRuntime(client, AccountIcon);
  // Stable component identity keeps the host modal mounted across label updates.
  function AccountIcon(props: PluginButtonIconProps) {
    const target = useSyncExternalStore(runtime.subscribe, runtime.getModalTarget, runtime.getModalTarget);
    const runtimeError = useSyncExternalStore(runtime.subscribe, runtime.getError, runtime.getError);
    const open = props.context === "agent" && target?.agentId === props.agentId && target.workspaceId === props.workspaceId;
    return <>
      <Icon name="Users" size={props.size} color={props.color} />
      <Modal title="Account" icon={<Icon name="Users" size={18} color={props.theme.colors.foreground} />} open={open}
        onOpenChange={(next) => { if (!next && open && target) runtime.closeModal(target); }}>
        {open && target ? <Modal.Content style={{ backgroundColor: props.theme.colors.surface0 }}>
          <AgentSwitcher {...props} agentId={target.agentId} close={() => runtime.closeModal(target)}
            onChanged={runtime.refresh} runtimeError={runtimeError} openAccounts={showAccounts} />
        </Modal.Content> : null}
      </Modal>
    </>;
  }
  function Accounts(props: PluginScreenProps) {
    const runtimeError = useSyncExternalStore(runtime.subscribe, runtime.getError, runtime.getError);
    return <AccountsSurface {...props} onChanged={runtime.refresh} runtimeError={runtimeError} />;
  }
  const removeScreen = registerAccountsScreen(client, Accounts);
  const removeCommand = client.addCommandCenterItem({ id: "accounts", title: "Accounts and limits", icon: "Users", context: "global",
    keywords: ["accounts", "quota", "claude", "codex", "limits", "account"], onSelect: openAccounts });
  const removeSlash = client.addSlashCommand({ name: "account", description: "Switch this chat's account, or open the account switcher",
    argumentHint: "[account name | default]", context: "agent",
    async onSubmit({ args, agent, rpc, paseo }) {
      const target = { workspaceId: agent.workspaceId, agentId: agent.id };
      await runAccountCommand(supportedProvider(agent.provider), agent.id, args, {
        state: () => rpc(listAccounts, {}),
        usage: async () => (await rpc(listUsage, {})).accounts,
        agent: async () => (await paseo.agents.ref(agent.id).refresh())?.agent ?? null,
        prepare: (accountId) => rpc(prepareSwitch, { agentId: agent.id, accountId }),
        apply: (accountId) => rpc(applySwitch, { agentId: agent.id, accountId }),
        openSwitcher: () => runtime.openSwitcher(target),
      }).finally(runtime.refresh);
    } });
  const removeNote = client.addTimelineRenderer({ kind: ACCOUNT_NOTE_KIND, version: ACCOUNT_NOTE_VERSION, schema: AccountNoteSchema, Component: AccountNoteRow });
  // Created once, so the renderer keeps its identity; the RPC is called on the client, which may rely on its receiver.
  const FailoverRowView = createFailoverRow((contract, input) => client.rpc(contract, input));
  const removeFailover = client.addTimelineRenderer({ kind: FAILOVER_KIND, version: FAILOVER_VERSION, schema: FailoverRowSchema, Component: FailoverRowView });
  return () => { runtime.stop(); removeFailover(); removeNote(); removeSlash(); removeCommand(); removeScreen(); };
}
