import { describe, expect, it } from "vitest";
import { blocker, launchOrder, room } from "../server/selection";
import type { UsageSnapshot, UsageWindow } from "../shared/contracts";

const now = Date.parse("2026-10-27T12:00:00Z");
const later = "2026-10-27T15:00:00Z", earlier = "2026-10-27T11:00:00Z";
const window = (usedPercent: number | null, resetsAt: string | null = later, scope: UsageWindow["scope"] = "account"): UsageWindow =>
  ({ id: "w", label: "5 hours", usedPercent, windowDurationMins: 300, resetsAt, scope });
const snapshot = (accountId: string, windows: UsageWindow[], extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  accountId, provider: "codex", status: "ok", plan: null, windows,
  fetchedAt: earlier, checkedAt: earlier, nextRetryAt: null, error: null, ...extra,
});
const ready = (id: string) => ({ id, authStatus: "ready", loginToken: null });

describe("what proves an account would fail a new agent", () => {
  it("treats a window used up until a future reset as exhausted", () => {
    expect(blocker(snapshot("a", [window(40), window(100)]), null, now)).toBe("exhausted");
    expect(blocker(snapshot("a", [window(100)], { status: "stale" }), null, now)).toBe("exhausted");
  });
  it("counts only limits that stop the whole account", () => {
    expect(blocker(snapshot("a", [window(100, later, "model")]), null, now)).toBeNull();
    expect(blocker(snapshot("a", [window(100, later, "spend")]), null, now)).toBeNull();
    // Readings cached before scopes existed carry none; they prove nothing until the next reading.
    expect(blocker(snapshot("a", [{ ...window(100), scope: undefined }]), null, now)).toBeNull();
    expect(room(snapshot("a", [window(100, later, "model"), window(30)]), now)).toBe(70);
  });
  it("needs a known future reset: within a window, use only grows until it resets", () => {
    expect(blocker(snapshot("a", [window(100, null)]), null, now)).toBeNull();
  });
  it("takes the provider's own verdict from a fresh reading only", () => {
    expect(blocker(snapshot("a", [window(10)], { usageAllowed: false }), null, now)).toBe("exhausted");
    expect(blocker(snapshot("a", [window(10)], { usageAllowed: false, status: "stale" }), null, now)).toBeNull();
    expect(blocker(snapshot("a", [window(10)], { usageAllowed: true }), null, now)).toBeNull();
  });
  it("does not call an account exhausted once the reset has passed or without data", () => {
    expect(blocker(snapshot("a", [window(100, earlier)]), null, now)).toBeNull();
    expect(blocker(snapshot("a", [window(null)]), null, now)).toBeNull();
    expect(blocker(undefined, "gpt-6.1-sol", now)).toBeNull();
  });
  // A free ChatGPT plan answers `model_not_found` for a model only paid plans offer.
  it("blocks a plan that does not offer the agent's model, only when both are known", () => {
    const free = snapshot("a", [window(0)], { models: ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"] });
    expect(blocker(free, "gpt-6.1-sol", now)).toBe("model");
    expect(blocker(free, "gpt-6-luna", now)).toBeNull();
    expect(blocker(free, null, now)).toBeNull();
    expect(blocker(snapshot("a", [window(0)], { models: null }), "gpt-6.1-sol", now)).toBeNull();
    // A plan can change; a stale list no longer proves what it offers.
    expect(blocker({ ...free, status: "stale" }, "gpt-6.1-sol", now)).toBeNull();
  });
  it("measures room by the tightest window still in effect", () => {
    expect(room(snapshot("a", [window(20), window(70)]), now)).toBe(30);
    expect(room(snapshot("a", [window(95, earlier), window(10)]), now)).toBe(90);
    expect(room(snapshot("a", [window(null)]), now)).toBeNull();
    expect(room(undefined, now)).toBeNull();
  });
});

describe("the order in which a new agent tries accounts", () => {
  const accounts = [ready("default"), ready("roomy"), ready("tight"), ready("unknown")];
  const usage = [
    snapshot("default", [window(10)]), snapshot("roomy", [window(15)]),
    snapshot("tight", [window(80)]), snapshot("unknown", [window(null)]),
  ];
  it("keeps the default first while nothing shows it would fail", () => {
    expect(launchOrder({ defaultId: "default", accounts, usage, model: null, now })[0]).toBe("default");
  });
  it("moves past an exhausted default to the account with the most room, then unknown ones, default last", () => {
    const out = [snapshot("default", [window(100)]), ...usage.slice(1)];
    expect(launchOrder({ defaultId: "default", accounts, usage: out, model: null, now })).toEqual(["roomy", "tight", "unknown", "default"]);
  });
  it("skips accounts whose plan lacks the agent's model", () => {
    const models = [snapshot("default", [window(0)], { models: ["gpt-6-luna"] }), snapshot("roomy", [window(0)], { models: ["gpt-6.1-sol"] })];
    expect(launchOrder({ defaultId: "default", accounts: accounts.slice(0, 2), usage: models, model: "gpt-6.1-sol", now })).toEqual(["roomy", "default"]);
  });
  it("ignores a model no account lists, such as an alias Paseo resolves later", () => {
    const models = [snapshot("default", [window(0)], { models: ["gpt-6-luna"] }), snapshot("roomy", [window(0)], { models: ["gpt-6.1-sol"] })];
    expect(launchOrder({ defaultId: "default", accounts: accounts.slice(0, 2), usage: models, model: "default", now })).toEqual(["default", "roomy"]);
  });
  it("offers only signed-in accounts without a sign-in in progress as replacements", () => {
    const pool = [ready("default"), { id: "signing-in", authStatus: "ready", loginToken: "t" }, { id: "signed-out", authStatus: "needs_auth", loginToken: null }, ready("spare")];
    expect(launchOrder({ defaultId: "default", accounts: pool, usage: [], model: null, now })).toEqual(["default", "spare"]);
  });
});
