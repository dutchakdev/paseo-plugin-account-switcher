import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { createElement, type ComponentType } from "react";

const SCREEN_ID = "accounts";
const TITLE = "Accounts";
const ICON = "Users";

function AccountsSidebarRow({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return createElement(SidebarRow, { icon: ICON, active: currentScreen?.screenId === SCREEN_ID, onPress: () => openScreen({ screenId: SCREEN_ID }) });
}

// The screen API replaced surfaces in Paseo 0.11; both names exist through 0.14. Ask the app what it has, not its version.
// Each registration is decided on its own, so an app that has only half of the new API still gets both pieces.
export function registerAccountsScreen(client: PluginClientContext, Component: ComponentType<PluginScreenProps>): () => void {
  const removeScreen = typeof client.addScreen === "function"
    ? client.addScreen({ id: SCREEN_ID, title: TITLE, Component })
    // A surface has no params; the screen component still gets the empty ones it was typed for.
    : client.addSurface(SCREEN_ID, (props: PluginSurfaceProps) => createElement(Component, { ...props, params: {} }));
  const removeRow = typeof client.addSidebarHeaderItem === "function"
    ? client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: AccountsSidebarRow })
    : client.addSidebarItem({ id: SCREEN_ID, title: TITLE, icon: ICON, surface: SCREEN_ID });
  return () => { removeRow(); removeScreen(); };
}

// Called on the object, not on detached methods: the app's functions may rely on their receiver.
export function openAccounts(capabilities: { openScreen?: (input: { screenId: string }) => void; openSurface?: (id: string) => void }): void {
  if (typeof capabilities.openScreen === "function") capabilities.openScreen({ screenId: SCREEN_ID });
  else capabilities.openSurface?.(SCREEN_ID);
}
