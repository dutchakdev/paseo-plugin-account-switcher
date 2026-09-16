import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: { OS: "web" }, openURL: vi.fn<(url: string) => Promise<void>>() }));
vi.mock("react-native", () => ({ Platform: native.platform, Linking: { openURL: native.openURL } }));

import { openExternal, prefersCopiedLink } from "../client/web";

const url = "https://auth.openai.com/codex/device";
const browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.89 Safari/537.36";

afterEach(() => { vi.unstubAllGlobals(); native.platform.OS = "web"; native.openURL.mockReset(); });

describe("external sign-in link adapter", () => {
  it("requires copying on Electron and never opens an embedded child window", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("navigator", { userAgent: browserAgent.replace(" Safari/", " Electron/35.0.0 Safari/") });
    expect(prefersCopiedLink()).toBe(true);
    await expect(openExternal(url)).rejects.toThrow("Copy the sign-in link");
    expect(open).not.toHaveBeenCalled();
    expect(native.openURL).not.toHaveBeenCalled();
  });

  it("opens a new ordinary browser tab without exposing the opener", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    vi.stubGlobal("navigator", { userAgent: browserAgent });
    expect(prefersCopiedLink()).toBe(false);
    await expect(openExternal(url)).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
    expect(native.openURL).not.toHaveBeenCalled();
  });

  it.each(["ios", "android"])("uses the system linking API on %s without accessing browser globals", async platform => {
    native.platform.OS = platform;
    vi.stubGlobal("window", undefined); vi.stubGlobal("navigator", undefined);
    native.openURL.mockResolvedValueOnce();
    expect(prefersCopiedLink()).toBe(false);
    await expect(openExternal(url)).resolves.toBeUndefined();
    expect(native.openURL).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("preserves native failures so the dialog can offer its copy fallback", async () => {
    native.platform.OS = "ios";
    vi.stubGlobal("window", undefined); vi.stubGlobal("navigator", undefined);
    native.openURL.mockRejectedValueOnce(new Error("System browser unavailable"));
    await expect(openExternal(url)).rejects.toThrow("System browser unavailable");
  });
});
