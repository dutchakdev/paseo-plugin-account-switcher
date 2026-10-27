import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { FailoverRow } from "../shared/failover";

// No React renderer here: the row is called as a function, with a stand-in for its two hooks that keeps their values
// between calls the way one mounted component would. Host-only modules are stand-ins too.
const hooks = vi.hoisted(() => {
  let slots: unknown[] = [], index = 0;
  return {
    mount() { slots = []; index = 0; },
    render() { index = 0; },
    useState<T>(initial: T) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot] as T, (next: T) => { slots[slot] = next; }] as const;
    },
    useRef<T>(initial: T) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot] as { current: T };
    },
  };
});
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: hooks.useState, useRef: hooks.useRef }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", TextInput: "TextInput" }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));

const { createFailoverRow } = await import("../client/failover-row");
const { Button } = await import("../client/components");
const { applyFailover } = await import("../shared/contracts");

const theme = { colors: { foreground: "#000", foregroundMuted: "#666", border: "#ccc", surface2: "#eee", accent: "#00f", accentForeground: "#fff", statusDanger: "#f00" } } as never;
const rowId = "account-failover-agent-1-turn-7";
const offered: FailoverRow = { rowId, state: "offered", from: "Work", to: "Second", toId: "second", resetsAt: null, error: null };
type Node = ReactElement<{ children?: unknown; disabled?: boolean; onPress?: () => void }>;

function elements(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}
const text = (tree: unknown) => elements(tree).flatMap(element => [element.props.children].flat()).filter(child => typeof child === "string").join(" | ");
const button = (tree: unknown) => elements(tree).find(element => element.type === Button);

function mount(rpc: (contract: unknown, input: unknown) => Promise<unknown>) {
  hooks.mount();
  const View = createFailoverRow(rpc as never);
  return (data: FailoverRow) => { hooks.render(); return View({ theme, agentId: "agent-1", item: { type: "plugin", kind: "account-failover", version: 1, data } } as never); };
}

afterEach(() => vi.restoreAllMocks());

describe("the failover row's button", () => {
  it("applies the offered switch through the plugin's RPC, once, and shows it pending", async () => {
    let settle!: () => void;
    const rpc = vi.fn(() => new Promise<unknown>(resolve => { settle = () => resolve({}); }));
    const render = mount(rpc);
    const first = render(offered);
    expect(text(first)).toContain("Work's limit is used up.");
    expect(button(first)?.props.children).toBe("Switch to Second and continue");
    button(first)!.props.onPress!();
    expect(rpc).toHaveBeenCalledExactlyOnceWith(applyFailover, { agentId: "agent-1", accountId: "second", rowId });
    const pending = render(offered);
    expect(button(pending)?.props).toMatchObject({ disabled: true, children: "Switching…" });
    // A second press, even through the element rendered before the first, starts nothing.
    button(first)!.props.onPress!();
    button(pending)!.props.onPress!();
    expect(rpc).toHaveBeenCalledOnce();
    settle();
    await vi.waitFor(() => expect(button(render(offered))?.props).toMatchObject({ disabled: false, children: "Switch to Second and continue" }));
  });
  it("shows a refusal only while the row still offers the switch", async () => {
    const rpc = vi.fn(async () => { throw new Error("Wait for the agent to finish its response."); });
    const render = mount(rpc);
    button(render(offered))!.props.onPress!();
    await vi.waitFor(() => expect(text(render(offered))).toContain("Wait for the agent to finish its response."));
    // Once the daemon has rewritten the row, the row's own sentence carries the reason, once.
    const failed = render({ ...offered, state: "failed", error: "Wait for the agent to finish its response." });
    expect(button(failed)).toBeUndefined();
    expect(text(failed)).toBe("Could not switch to Second: Wait for the agent to finish its response.");
  });
  it("tells the RPC which account the offer moves the agent from, so an out-of-date offer is refused", () => {
    const rpc = vi.fn(async () => ({}));
    button(mount(rpc)({ ...offered, fromId: "work" }))!.props.onPress!();
    expect(rpc).toHaveBeenCalledExactlyOnceWith(applyFailover, { agentId: "agent-1", accountId: "second", rowId, fromId: "work" });
  });
  it("has no button once the switch is no longer on offer", () => {
    const render = mount(vi.fn());
    for (const state of ["none", "switching", "switched", "auto", "failed"] as const) expect(button(render({ ...offered, state }))).toBeUndefined();
  });
});
