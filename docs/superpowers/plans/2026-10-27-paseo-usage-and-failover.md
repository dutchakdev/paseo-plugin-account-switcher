# Paseo usage, failover and screen API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paseo's own usage UI shows every account and each agent's real one; a failed turn on an exhausted limit offers a switch (automatic only as an opt-in); screens use the current API with the deprecated one as fallback.

**Architecture:** Pure functions in `server/` and `shared/` decide (session env, usage discovery and report mapping, failover decision); `index.server.ts` and `index.client.tsx` only wire them to Paseo hooks, RPCs and renderers. Existing pieces are reused: `selection.ts` for "exhausted" and candidate order, the switch service for applying, `timeline.append` for chat rows.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Vitest 5, zod 4, Paseo plugin SDK 0.11.4 (dev), React Native client.

**Spec:** `docs/superpowers/specs/2026-10-27-paseo-usage-and-failover.md`

## Global Constraints

- Supported Paseo stays `0.11.* || 0.12.* || 0.13.* || 0.14.*`; use no API newer than 0.11 without a runtime feature check.
- Dev SDK `@getpaseo/{client,plugin,protocol}` pinned exactly to `0.11.4`.
- Usage source: `id: "account-switcher"`, `label: "Account Switcher"`, input `{ accountId: string }`; keys match `/^[A-Za-z0-9._-]{1,128}$/`.
- Failover row: kind `account-failover`, version `1`; follow-up prompt exactly `Continue.`.
- Auto failover: off by default, per provider; at most one automatic switch per failed turn, three per agent per rolling hour, never back to an account left within that hour.
- The composer chip and the Accounts screen keep their current behavior.
- Every check: `npm run check` (build, typecheck, tests) passes; no secrets or emails in logs, keys or row data beyond the account labels already shown.

## Review Focus

1. A Claude `identityKey` with characters outside the key alphabet (`:`) — must be rewritten, never passed through (Task 4 test).
2. An agent on the system account, or with integration disabled — no session env change, no failover (Tasks 3 and 6 tests).
3. A failed turn whose account is not exhausted (network error, tool failure) — no row (Task 5 test).
4. A failover click after the agent started another turn or got a pending permission — the switch service refuses; the row shows the reason instead of hanging (Task 6 test).
5. Auto failover ping-pong between two exhausted accounts — the hourly guard stops it (Task 5 test).

---

### Task 1: SDK 0.11.4 and its license review

**Files:**
- Modify: `package.json`, `package-lock.json` (dev SDK to `0.11.4`)
- Modify: `scripts/build.mjs` (`reviewedLicenses["@getpaseo/plugin"]` → `{ version: "0.11.4", file: "paseo-0.11.4.txt" }`)
- Create: `licenses/paseo-0.11.4.txt`; delete `licenses/paseo-0.8.0.txt`
- Modify: `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md` (every "0.8.0" SDK mention)

**Interfaces:** Produces: SDK 0.11.4 types (`addScreen`, `addSidebarHeaderItem`, `registerUsageSource`, `@getpaseo/plugin/server/usage`) for later tasks.

- [ ] **Step 1:** `npm install --save-dev --save-exact @getpaseo/plugin@0.11.4 @getpaseo/client@0.11.4 @getpaseo/protocol@0.11.4`.
- [ ] **Step 2:** `npm run build` — expected FAIL: "Review and add a license for bundled dependency @getpaseo/plugin@0.11.4."
- [ ] **Step 3:** Obtain the 0.11.4 license text the same way `paseo-0.8.0.txt` was obtained (the package's `LICENSE` if it ships one, otherwise `LICENSE` at tag `v0.11.4` of getpaseo/paseo); diff it against `paseo-0.8.0.txt`. Identical apart from versions → save as `licenses/paseo-0.11.4.txt`, update `build.mjs` and `THIRD_PARTY_NOTICES.md`. Different → stop and report the difference.
- [ ] **Step 4:** `npm run check` — expected: build prints "3 third-party licenses included", typecheck 0 errors, all tests pass.
- [ ] **Step 5:** Commit `Pin the development SDK to Paseo 0.11, the oldest supported`.

### Task 2: Screens on the current API, the deprecated one as fallback (spec D)

**Files:**
- Create: `client/screens.ts`
- Modify: `index.client.tsx:33-39`
- Test: `tests/ui-screens.test.ts`

**Interfaces:**
- Produces: `registerAccountsScreen(client: PluginClientContext, Component: ComponentType<PluginScreenProps>): () => void` and `openAccounts(capabilities: { openScreen?: (input: { screenId: string }) => void; openSurface?: (id: string) => void }): void`.

- [ ] **Step 1:** Tests with stand-in clients: `uses addScreen and addSidebarHeaderItem when the app has them` (records `addScreen({ id: "accounts", title: "Accounts", ... })` and a header item `{ id: "accounts", title: "Accounts" }`, and no `addSurface` call); `falls back to addSurface and addSidebarItem on an app without addScreen` (records `addSurface("accounts", …)` and `addSidebarItem({ id: "accounts", title: "Accounts", icon: "Users", surface: "accounts" })`); `the returned cleanup removes both registrations`; `openAccounts prefers openScreen({ screenId: "accounts" }) and falls back to openSurface("accounts")`.
- [ ] **Step 2:** Run `npx vitest run tests/ui-screens.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement in `client/screens.ts`; the header item renders `SidebarRow` from `@getpaseo/plugin/client/ui` with icon `Users` and `active` when the current screen is `accounts`. Wire `index.client.tsx` (screen, sidebar, Command Center `onSelect`, `openAccounts` used by the runtime) through these two functions.
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** Commit `Register Accounts as a screen, keeping the surface API as fallback`.

### Task 3: Session env names the agent's profile (spec A)

**Files:**
- Create: `server/session-env.ts`
- Modify: `index.server.ts:58-72` (the `agent.session_open` hook)
- Test: `tests/session-env.test.ts`, extend `tests/server-hooks.test.ts`

**Interfaces:**
- Consumes: `Registry`, `StoredBinding`, `StoredAccount` from `server/store.ts`.
- Produces: `profileEnv(registry: Registry, agentId: string, provider: string): Record<string, string>` — `{ CLAUDE_CONFIG_DIR: home }` or `{ CODEX_HOME: home }` or `{}`.

- [ ] **Step 1:** Table tests: managed Claude binding → `{ CLAUDE_CONFIG_DIR: <home> }`; managed Codex → `{ CODEX_HOME: <home> }`; `launchAccountId` wins over `currentAccountId`; system account → `{}`; no binding → `{}`; integration disabled → `{}`; provider not `claude`/`codex` → `{}`; binding provider differing from the session's → `{}`. Hook test: the returned env carries the profile var and still lacks `PASEO_ACCOUNT_SWITCHER_MODEL`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `profileEnv`; in the hook, after the existing binding logic, read the registry and merge `profileEnv(...)` into the returned `env`.
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** Commit `Tell Paseo which profile an agent runs on, so its usage popover reads that account`.

### Task 4: Usage source for Paseo's Usage UI (spec B)

**Files:**
- Create: `server/paseo-usage.ts`
- Modify: `index.server.ts` (registration)
- Test: `tests/paseo-usage.test.ts`

**Interfaces:**
- Consumes: `UsageSnapshot`, `UsageWindow`, `cliName` from `shared/contracts.ts`; `Registry` from `server/store.ts`; `windowFromReportedDuration` from `@getpaseo/plugin/server/usage`.
- Produces: `usageKey(provider: Provider, identityKey: string): string`; `discoverAccounts(registry: Registry, scope: UsageScope): UsageAccount[]`; `usageReport(snapshot: UsageSnapshot | undefined): UsageReport`; `registerPaseoUsage(server: PluginServerContext, controller: AccountController): (() => void) | null` (null when the daemon lacks `registerUsageSource`).

- [ ] **Step 1:** Tests: `usageKey("codex", "<uuid>")` returns it unchanged; `usageKey("claude", "claude:<64 hex>")` returns `"claude-<64 hex>"`; any key failing `/^[A-Za-z0-9._-]{1,128}$/` is replaced by `hashAccountKey(identityKey)`. `discoverAccounts` global: lists signed-in managed accounts with an identity, label = account label, harness `Claude Code`/`Codex`, input `{ accountId }`; skips a managed account whose `identityKey` equals the system account's of the same provider; skips `needs_auth` and accounts with a `loginToken`; session scope → `[]`. `usageReport`: `ok` snapshot with a 5-hour account window (`windowDurationMins: 300`, `usedPercent: 40`) → `status: "available"`, `planLabel` = plan, one window with `usedPct` 40 and `summary: true`; a model window keeps its own scope id and is not `summary`; `detail` strings become `details`; `stale` still `available`; `needs_auth` → `{ status: "error", error: "Needs sign-in in Account Switcher." }`; missing/`unavailable` → `{ status: "error", error: "No usage data from the provider yet." }`. Use snapshot shapes from `tests/fixtures`/`tests/usage*.test.ts`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; `registerPaseoUsage` feature-detects `server.registerUsageSource`, `discover` reads the registry, `fetch` parses `{ accountId }` and maps the plugin's cached snapshot from `controller.usage.list(...)` (no new provider requests).
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** Commit `List managed accounts in Paseo's Usage view`.

### Task 5: Failover decision and guard (spec C, pure part)

**Files:**
- Create: `server/failover.ts`
- Test: `tests/failover.test.ts`

**Interfaces:**
- Consumes: `blocker`, `launchOrder`, `SelectionAccount` from `server/selection.ts`; `UsageSnapshot`.
- Produces:
  - `type FailoverDecision = { kind: "offer"; fromId: string; toId: string; resetsAt: string | null } | { kind: "none"; fromId: string; resetsAt: string | null }`
  - `failoverDecision(input: { currentId: string; accounts: readonly SelectionAccount[]; usage: readonly UsageSnapshot[]; model: string | null; now: number }): FailoverDecision | null` — null unless the current account's blocker is `"exhausted"`; `resetsAt` = earliest reset of its exhausted account-wide windows.
  - `class AutoFailoverGuard { allow(agentId: string, turnKey: string, fromId: string, toId: string, now: number): boolean; record(...same): void }` — one per turn key, three per agent per hour, never `toId` equal to an account this agent left within the hour.

- [ ] **Step 1:** Tests: exhausted current + spare with room → `offer` to the spare with most room; exhausted + no usable spare → `none`; current not exhausted (no data, 80% used, or full model-only window) → `null`; spare needing sign-in or with a login in progress is never offered; Codex spare whose plan lacks the model is skipped. Guard: second call for the same turn key → false; fourth switch within an hour → false; switch back to the account left 10 minutes ago → false; after 61 minutes → true.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement on top of `blocker`/`launchOrder` (candidate = first id of `launchOrder({ defaultId: currentId, ... })` other than `currentId`).
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** Commit `Decide when a failed turn ran out of its account's limit`.

### Task 6: Failover row, button, setting and hook (spec C, wiring)

**Files:**
- Create: `shared/failover.ts`, `client/failover-row.tsx`
- Modify: `server/store.ts` (registry `autoFailover: { claude: boolean; codex: boolean }`, default both false), `shared/contracts.ts` (`StateSchema.autoFailover`; RPCs `setAutoFailover` = `accounts.auto-failover` `{ provider, enabled } → {}` and `applyFailover` = `failover.apply` `{ agentId, accountId, rowId } → {}`), `index.server.ts` (`server.on("agent.turn_ended")` handler, both handlers), `index.client.tsx` (renderer), `client/accounts.tsx` (setting)
- Test: `tests/failover-row.test.ts`, extend `tests/server-hooks.test.ts`, `tests/store.test.ts`, a UI test next to the existing fallback one

**Interfaces:**
- Consumes: Task 5's `failoverDecision`, `AutoFailoverGuard`; the switch service's `prepare`/`apply`; `paseo.agents.ref(id).timeline.append` and `.send`.
- Produces: `FAILOVER_KIND = "account-failover"`, `FAILOVER_VERSION = 1`, `FailoverRowSchema` = `{ state: "offered" | "none" | "switching" | "switched" | "auto" | "failed"; from: string; to: string | null; toId: string | null; resetsAt: string | null; error: string | null }`, `failoverText(row, formatTime): string`.

- [ ] **Step 1:** Tests: `failoverText` — offered: `"Work's limit is used up until 18:00."`; none: that plus `" No other account has room."`; switched: `"Switched from Work to Second."`; auto: `"Switched automatically from Work to Second."`; failed: `"Could not switch to Second: <error>"`; schema round-trips through JSON. Store: a registry without `autoFailover` reads as both false. Hook: a failed turn on an exhausted managed account appends one `offered` row with button target; a completed or canceled turn appends nothing; integration disabled → nothing; with `autoFailover.claude` on, the switch is applied, `Continue.` is sent and the row reads `auto`; a refused apply (agent busy) turns the row into `failed` with the service's message. UI: the Accounts provider section shows "When a limit runs out during a chat" with options "Offer a switch" / "Switch automatically" calling `setAutoFailover`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Row id `account-failover-<agentId>-<turnId or event time>`; re-append the same id to update. `applyFailover` runs prepare + apply like `/account`, sends `Continue.`, re-appends the row as `switched` (no extra "switched" note), and on error re-appends it as `failed`. The renderer shows the text and, for `offered`, a button "Switch to {to} and continue" that calls `applyFailover` and shows the pending state.
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** Commit `Offer a switch when a turn runs out of its account's limit`.

### Task 7: Docs, release notes and live verification

**Files:**
- Modify: `README.md`, `OVERVIEW.md`, `OVERVIEW.zh-CN.md`, `docs/architecture.md`, `docs/verification.md`, `CHANGELOG.md` (`## Unreleased`: Added — Usage view, failover offer and setting; Changed — screen API, SDK pin)

- [ ] **Step 1:** Update user docs for: accounts in Paseo's Usage view, the per-agent popover, the failover row and its setting (default off), the fallback for older apps. OVERVIEW keeps install commands out.
- [ ] **Step 2:** `node scripts/release.mjs check`; `npm pack` + `node scripts/check-package.mjs <tgz>` — PASS.
- [ ] **Step 3:** Live, on the user's daemon after `paseo plugin reload account-switcher`: an agent on a managed account shows that account in Paseo's usage popover; the Usage modal lists managed accounts once; record results in `docs/verification.md`.
- [ ] **Step 4:** Commit `Document Paseo usage and failover`.
