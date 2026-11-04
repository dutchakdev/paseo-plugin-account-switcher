import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsageService, readCredentialVersion, type QuotaAccount } from "../server/usage";
import { collectCursorUsage } from "../server/usage/cursor";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function account(id: string): Promise<QuotaAccount> {
  const home = await mkdtemp(join(tmpdir(), "cursor-usage-")); roots.push(home);
  await mkdir(join(home, "cursor"));
  await writeFile(join(home, "cursor", "auth.json"), JSON.stringify({ accessToken: `token-${id}` }));
  const value: QuotaAccount = { id, provider: "cursor", home, command: ["cursor-agent"], env: {}, identityKey: `identity-${id}`, generation: 1, requireIdentityVerification: true };
  value.credentialVersion = value.identityCredentialVersion = await readCredentialVersion(value);
  return value;
}

it("reads each isolated account's own pools and its reported balance fallback", async () => {
  const first = await account("first"), second = await account("second");
  const fetchUsage = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string>).Authorization;
    const body = token === "Bearer token-first"
      ? { billingCycleEnd: "2026-12-01T00:00:00Z", planUsage: { totalPercentUsed: 0, autoPercentUsed: 20, apiPercentUsed: "35" } }
      : { billingCycleEnd: 1796083200, planUsage: { totalSpend: 300, remaining: 700, limit: 1000 } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchUsage);
  const service = createUsageService({ getAccounts: async () => [first, second] });
  try {
    const [a, b] = await service.refresh();
    expect(a).toMatchObject({ accountId: first.id, status: "ok", windows: [
      { label: "Total", usedPercent: 0, resetsAt: "2026-12-01T00:00:00.000Z" },
      { label: "Cursor", usedPercent: 20 }, { label: "Third Party", usedPercent: 35 },
    ] });
    expect(b).toMatchObject({ accountId: second.id, status: "ok", windows: [{ label: "Plan usage", usedPercent: 30, detail: "$3.00 used · $7.00 remaining · $10.00 limit" }] });
    expect(fetchUsage.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization).sort()).toEqual(["Bearer token-first", "Bearer token-second"]);
  } finally { await service.close(); }
});

it("does not use missing, rejected, or changed credentials for a usage reading", async () => {
  const a = await account("a"), path = join(a.home, "cursor", "auth.json");
  const fetchUsage = vi.fn(async () => new Response("", { status: 401 })); vi.stubGlobal("fetch", fetchUsage);
  await expect(collectCursorUsage(a)).rejects.toMatchObject({ status: "needs_auth" });
  await writeFile(path, JSON.stringify({ accessToken: "replacement" }));
  await expect(collectCursorUsage(a)).rejects.toMatchObject({ status: "unavailable" });
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  await rm(path);
  await expect(collectCursorUsage(a)).rejects.toMatchObject({ status: "needs_auth" });
});
