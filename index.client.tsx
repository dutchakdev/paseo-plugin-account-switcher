import type { PluginButtonIconProps, PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useSyncExternalStore } from "react";
import { AccountsSurface } from "./client/accounts";
import { createClientRuntime } from "./client/runtime";
import { AgentSwitcher } from "./client/switcher";

export default function contribute(client: PluginClientContext) {
  const openAccounts = () => client.openSurface("accounts");
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
            onChanged={runtime.refresh} runtimeError={runtimeError} openAccounts={openAccounts} />
        </Modal.Content> : null}
      </Modal>
    </>;
  }
  function Accounts(props: PluginSurfaceProps) {
    const runtimeError = useSyncExternalStore(runtime.subscribe, runtime.getError, runtime.getError);
    return <AccountsSurface {...props} onChanged={runtime.refresh} runtimeError={runtimeError} />;
  }
  const removeSurface = client.addSurface("accounts", Accounts);
  const removeSidebar = client.addSidebarItem({ id: "accounts", title: "Accounts", icon: "Users", surface: "accounts" });
  const removeCommand = client.addCommandCenterItem({ id: "accounts", title: "Accounts and limits", icon: "Users", context: "global",
    keywords: ["accounts", "quota", "claude", "codex", "limits", "account"], onSelect: ({ openSurface }) => openSurface("accounts") });
  return () => { runtime.stop(); removeCommand(); removeSidebar(); removeSurface(); };
}
