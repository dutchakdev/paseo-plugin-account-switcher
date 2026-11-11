import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// Component functions are called directly: the host-only modules are stand-ins, and RPCs are recorded by contract name.
const calls = vi.hoisted(() => [] as { name: string; input: unknown }[]);
vi.mock("react-native", () => ({ View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable", TextInput: "TextInput", Platform: { OS: "web" }, Linking: {} }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: { name: string }) => async (input: unknown) => { calls.push({ name: contract.name, input }); return {}; } }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsSelect: "SettingsSelect" }));

const { AutoFailoverSetting } = await import("../client/accounts");
const { SettingsSelect } = await import("@getpaseo/plugin/client/ui");

const theme = { colors: { foreground: "#000", foregroundMuted: "#666", border: "#ccc", surface0: "#fff", surface2: "#eee" } } as never;
type SegmentedProps = { label: string; value: string; disabled?: boolean; options: { value: string; label: string }[]; onValueChange(value: string): void };

function find(node: unknown, type: unknown): ReactElement<SegmentedProps> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, type); if (found) return found; } return undefined; }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<{ children?: unknown }>;
  return element.type === type ? element as unknown as ReactElement<SegmentedProps> : find(element.props.children, type);
}

describe("the Accounts setting for a limit that runs out during a chat", () => {
  it("offers a switch by default and can switch automatically instead, per provider", async () => {
    calls.length = 0;
    const run = vi.fn((action: () => Promise<unknown>) => { void action(); });
    const control = find(AutoFailoverSetting({ theme, provider: "claude", enabled: false, disabled: false, run }), SettingsSelect)!;
    expect(control.props.label).toBe("When a limit runs out during a chat");
    expect(control.props.options.map(option => option.label)).toEqual(["Offer a switch", "Switch automatically"]);
    expect(control.props.options.find(option => option.value === control.props.value)?.label).toBe("Offer a switch");
    control.props.onValueChange(control.props.options[1].value);
    await vi.waitFor(() => expect(calls).toEqual([{ name: "accounts.auto-failover", input: { provider: "claude", enabled: true } }]));
    expect(run).toHaveBeenCalledOnce();
  });
  it("shows the saved choice and turns it off again", async () => {
    calls.length = 0;
    const control = find(AutoFailoverSetting({ theme, provider: "codex", enabled: true, disabled: true, run: (action) => { void action(); } }), SettingsSelect)!;
    expect(control.props.options.find(option => option.value === control.props.value)?.label).toBe("Switch automatically");
    expect(control.props.disabled).toBe(true);
    control.props.onValueChange(control.props.options[0].value);
    await vi.waitFor(() => expect(calls).toEqual([{ name: "accounts.auto-failover", input: { provider: "codex", enabled: false } }]));
  });
});
