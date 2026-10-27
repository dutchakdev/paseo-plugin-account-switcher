import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemContribution, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { openAccounts, registerAccountsScreen } from "../client/screens";

// The package's own client/ui is an empty module: the app supplies SidebarRow.
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: function SidebarRowStub() { return null; } }));
const { SidebarRow } = await import("@getpaseo/plugin/client/ui");

const Accounts = () => null;
type Spies = ReturnType<typeof clientSpies>;

// Stand-in clients carry only the methods an app of that vintage has.
function clientSpies() {
  return {
    removeScreen: vi.fn(), removeHeader: vi.fn(), removeSurface: vi.fn(), removeSidebar: vi.fn(),
  };
}
function currentApp(spies: Spies) {
  return {
    addScreen: vi.fn(() => spies.removeScreen), addSidebarHeaderItem: vi.fn(() => spies.removeHeader),
    addSurface: vi.fn(() => spies.removeSurface), addSidebarItem: vi.fn(() => spies.removeSidebar),
  };
}
function olderApp(spies: Spies) {
  return { addSurface: vi.fn((_id: string, _Component: unknown) => spies.removeSurface), addSidebarItem: vi.fn(() => spies.removeSidebar) };
}
const asClient = (stand: object) => stand as unknown as PluginClientContext;
const sidebarProps = (currentScreen: PluginSidebarItemProps["currentScreen"], openScreen = vi.fn()) =>
  ({ currentScreen, openScreen, openPopover: vi.fn() }) as unknown as PluginSidebarItemProps;

describe("registerAccountsScreen", () => {
  it("uses addScreen and addSidebarHeaderItem when the app has them", () => {
    const spies = clientSpies(), app = currentApp(spies);
    registerAccountsScreen(asClient(app), Accounts);
    expect(app.addScreen).toHaveBeenCalledExactlyOnceWith({ id: "accounts", title: "Accounts", Component: Accounts });
    expect(app.addSidebarHeaderItem).toHaveBeenCalledExactlyOnceWith({ id: "accounts", title: "Accounts", Component: expect.any(Function) });
    expect(app.addSurface).not.toHaveBeenCalled();
    expect(app.addSidebarItem).not.toHaveBeenCalled();
  });

  it("falls back to addSurface and addSidebarItem on an app without addScreen", () => {
    const spies = clientSpies(), app = olderApp(spies);
    registerAccountsScreen(asClient(app), Accounts);
    expect(app.addSurface).toHaveBeenCalledExactlyOnceWith("accounts", expect.any(Function));
    expect(app.addSidebarItem).toHaveBeenCalledExactlyOnceWith({ id: "accounts", title: "Accounts", icon: "Users", surface: "accounts" });
  });

  it("decides the screen and the sidebar row separately", () => {
    const spies = clientSpies(), app = { addScreen: vi.fn(() => spies.removeScreen), addSidebarItem: vi.fn(() => spies.removeSidebar) };
    registerAccountsScreen(asClient(app), Accounts);
    expect(app.addScreen).toHaveBeenCalledOnce();
    expect(app.addSidebarItem).toHaveBeenCalledExactlyOnceWith({ id: "accounts", title: "Accounts", icon: "Users", surface: "accounts" });
  });

  it("the returned cleanup removes both registrations", () => {
    const current = clientSpies(), older = clientSpies();
    registerAccountsScreen(asClient(currentApp(current)), Accounts)();
    expect(current.removeScreen).toHaveBeenCalledOnce();
    expect(current.removeHeader).toHaveBeenCalledOnce();
    expect(current.removeSurface).not.toHaveBeenCalled();
    expect(current.removeSidebar).not.toHaveBeenCalled();
    registerAccountsScreen(asClient(olderApp(older)), Accounts)();
    expect(older.removeSurface).toHaveBeenCalledOnce();
    expect(older.removeSidebar).toHaveBeenCalledOnce();
    expect(older.removeScreen).not.toHaveBeenCalled();
    expect(older.removeHeader).not.toHaveBeenCalled();
  });

  it("hands the legacy surface the screen's empty params", () => {
    const app = olderApp(clientSpies()), Screen = vi.fn(() => null);
    registerAccountsScreen(asClient(app), Screen as unknown as (props: PluginScreenProps) => null);
    const Surface = app.addSurface.mock.calls[0][1] as (props: object) => { type: unknown; props: object };
    const element = Surface({ layout: { compact: true } });
    expect(element.type).toBe(Screen);
    expect(element.props).toEqual({ layout: { compact: true }, params: {} });
  });

  it("renders the sidebar row as Accounts with the Users icon, active only on its own screen", () => {
    const app = currentApp(clientSpies());
    registerAccountsScreen(asClient(app), Accounts);
    const Row = (app.addSidebarHeaderItem.mock.calls[0] as unknown as [PluginSidebarItemContribution])[0].Component as unknown as
      (props: PluginSidebarItemProps) => { type: unknown; props: { icon: string; active: boolean; onPress(): void } };
    const open = vi.fn();
    const onAccounts = Row(sidebarProps({ screenId: "accounts", params: {} }, open));
    expect(onAccounts.type).toBe(SidebarRow);
    expect(onAccounts.props).toMatchObject({ icon: "Users", active: true });
    expect(Row(sidebarProps({ screenId: "other", params: {} })).props.active).toBe(false);
    expect(Row(sidebarProps(null)).props.active).toBe(false);
    onAccounts.props.onPress();
    expect(open).toHaveBeenCalledExactlyOnceWith({ screenId: "accounts" });
  });
});

describe("openAccounts", () => {
  it("prefers openScreen({ screenId: \"accounts\" })", () => {
    const openScreen = vi.fn(), openSurface = vi.fn();
    openAccounts({ openScreen, openSurface });
    expect(openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "accounts" });
    expect(openSurface).not.toHaveBeenCalled();
  });

  it("falls back to openSurface(\"accounts\")", () => {
    const openSurface = vi.fn();
    openAccounts({ openSurface });
    expect(openSurface).toHaveBeenCalledExactlyOnceWith("accounts");
  });

  it("keeps the receiver when it calls the app's functions", () => {
    const app = { calls: 0, openScreen(this: { calls: number }) { this.calls++; } };
    openAccounts(app);
    expect(app.calls).toBe(1);
  });
});
