# Paseo usage, failover on an exhausted limit, and the screen API

Status: design, 2026-10-27. Scope approved by the owner: Paseo's usage UI shows
every account and the right one per agent; a chat offer to switch when a turn
fails on an exhausted limit, automatic only as an opt-in; screens on the current
API with the deprecated one as fallback. The plugin's own composer chip and
Accounts screen stay as they are.

## Facts this design rests on

Checked in Paseo's code and SDK packages, not assumed:

- Supported Paseo is 0.11 to 0.14. `server.registerUsageSource` exists from 0.11,
  and `@getpaseo/plugin/server/usage` is a host module from 0.11.0
  (`plugin-sdk-specifiers.js`), so a server bundle can import it without a
  runtime dependency.
- Paseo's built-in Claude usage source resolves an agent's login from that
  session's launch env: `CLAUDE_CONFIG_DIR` selects the Keychain service
  `Claude Code-credentials-<first 8 sha256 hex of the NFC dir>`. The Codex one
  reads `CODEX_HOME/auth.json`. The launcher sets these inside its own process,
  so today Paseo sees the default login for every agent.
- A managed profile's CLI runs with `CLAUDE_CONFIG_DIR=<home>`
  (`buildAccountEnv`), so its credentials sit exactly where the built-in source
  would look. The launcher overrides `CLAUDE_CONFIG_DIR`/`CODEX_HOME` for a
  managed account and passes the env through untouched for the system account.
- Built-in keys: Claude `${account.uuid}.${organization.uuid}`; Codex the
  ChatGPT account id. The plugin's Codex `identityKey` is that account id; its
  Claude `identityKey` is `claude:<sha256 of [email, orgId]>`.
- `addSurface`/`addSidebarItem` are deprecated aliases, still in the SDK types
  and runtime through 0.14.0-beta.1.
- Paseo does not normalize provider limit errors (no limit code on a failed
  turn's outcome). The plugin already decides "exhausted" from fresh readings
  (`server/selection.ts`).
- Corrected after the final review: a limit stop does not always arrive as a
  failed turn. The Claude Agent SDK ends a turn that hit an API error, a limit
  included, with a `result` of subtype `success` and `is_error: true`, and
  Paseo's Claude provider maps every `success` result to `turn_completed`
  (`appendResultEvents` in `packages/server/src/server/agent/providers/claude/agent.ts`:
  v0.11.0 line 4625, v0.13.0 line 4844; the review found the same in
  0.14.0-beta.1). Codex reports `status: "failed"`, so `turn_failed`.

## A. Session env: Paseo's per-agent popover reads the real account

In `agent.session_open`, for an agent whose binding names a managed account
(`launchAccountId ?? currentAccountId`) while integration is enabled, set
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` to that account's home. The system account
and unbound agents keep the env as Paseo built it. The hook keeps removing the
model hint. The value is launch-only and re-derived on every open, so a switch
(which reloads the agent) moves it with the binding.

Risk: Paseo itself may read `CLAUDE_CONFIG_DIR` for other things (settings,
session files). A managed home links the shared directories to the source home,
so those reads see the same files. Verified on a live agent before release.

## B. Usage source: every managed account in Paseo's Usage UI

`registerUsageSource` when the daemon has it (feature-detected):

- `id: "account-switcher"`, `label: "Account Switcher"`, input
  `{ accountId: string }` (a store locator, never a credential).
- `discover({ kind: "global" })`: managed accounts that are signed in and have an
  `identityKey`, minus any whose identity equals the system account's of the same
  provider (the built-in card already covers that login). Key: the Codex account
  id as is; for Claude the `identityKey` with `:` replaced by `-`. Label: the
  account's name; harness: "Claude Code" or "Codex".
- `discover({ kind: "session" })`: `[]`. With A in place the built-in source
  reports the session's account; reporting it here too would show it twice.
- Known limitation, kept after the final review: one account can still show
  twice. Paseo ids a report as `${source.id}:${key}`, and `mergeKnown` adds
  accounts found in agent sessions to the global list. With A, opening an
  agent's usage details lets the built-in Claude or Codex source discover the
  managed login, so the view can show "Claude · email" next to
  "Account Switcher · Work". A plugin cannot merge cards across sources; the
  source stays, and README, this section and `docs/verification.md` say so.
- `fetch({ accountId })`: the plugin's cached snapshot, mapped without new
  requests. `ok`/`stale` → `available` with `planLabel`, one window per reading
  (`windowFromReportedDuration`, duration from `windowDurationMins`, a `scope`
  for model windows), `detail` strings as `details`; account-wide windows marked
  `summary`. `needs_auth`/`unavailable` → `error` with a short fixed message.
  A reading with neither a percentage nor a detail is left out: Claude names
  some limits without data (found live), and Paseo's own sources skip them.

## C. Failover when a turn fails on an exhausted limit

Trigger: `agent.turn_ended` for a Claude or Codex agent with
`outcome.kind === "failed"`, or, for Claude only, `"completed"` (see the
corrected fact above). A completed Claude turn first passes a cheap prefilter
on the cached reading of the agent's account: an account-wide window at 100%
or more with a reset still ahead, or `usageAllowed === false`. Without that,
it ends with no provider request. It also ends, before and after the refresh,
while the reading has a spend-scope window with room left (`usedPercent`
under 100): with extra usage on, Claude keeps answering past a full 5-hour
window, paid from the monthly allowance. Failed turns and `blocker()` do not
look at spend windows. Evidence, not text: refresh the agent's
current account and ask `selection.ts` for its blocker. Only `"exhausted"`
continues; any other failure is left alone. Completed Codex turns and
canceled turns are ignored.

The agent's account is its binding's confirmed account, or, for a launch not
confirmed yet, the launch account once its receipt confirms it. That is the
Accounts list's receipt check, except that failover also accepts an agent in
`error`, the status Paseo sets after a failed turn before the hook runs; the
launcher wrote the receipt when it started the CLI. An agent without a
binding is on its provider's Current CLI account. Nothing confirmed, no row.

Candidate: `launchOrder` over the provider's other signed-in accounts that are
not exhausted and offer the agent's model (Codex). The plugin appends one chat
row per exhaustion, that is per agent, account and reset time while the plugin
runs, not one per turn (`timeline.append`, kind `account-failover`, version 1):

- with a candidate: "Work's limit is used up until 18:00." and a button
  **Switch to Second and continue**;
- without one: the same sentence and "No other account has room."

The button calls an RPC that applies the switch through the existing path
(identity check, idle, no pending permission, receipt) and, on success, sends
the agent "Continue." The row then reads "Switched from Work to Second." or the
failure reason. Rows are best effort, like the existing notes. The row carries
the account it moves from; an offer is refused once the agent runs on another
account or already on the offered one. A switch refused before it starts
leaves no selection behind, and only the switch service's own refusals reach
the row; any other error shows a generic sentence and goes to the log.

Automatic switching: a per-provider setting in Accounts, off by default. When
on, the same flow runs without the click and the row says it switched
automatically. After a completed Claude turn it does not send "Continue.",
since the turn may really have finished; the row adds "Your next message runs
on Second.". After a failed turn it sends "Continue." as the button does. Guard: at most one automatic switch per turn and three per
agent per hour; never back to an account it left within that hour.

## D. Screens

Register the Accounts screen with `addScreen` and its sidebar row with
`addSidebarHeaderItem` (`SidebarRow`) when the app has them, and the Command
Center item with `openScreen`. Fall back to `addSurface`/`addSidebarItem`/
`openSurface` when it does not. The dev SDK moves from 0.8.0 to 0.11.4, the
oldest supported Paseo, so typechecking proves the plugin uses only 0.11 API; the
launcher bundles `defineRpc` from it, so its license is reviewed like zod's.

## Agent slice

Not in this change. An agent tool that reports the remaining limits needs Paseo
0.14 (`defineAgentTool`) or a gate on the request shape; it is a follow-up.
Switching stays a human decision, so agents get no switching tool.

## Verification

- Pure functions with tests on captured readings: session env (A), discovery and
  report mapping (B), the failover decision and guard (C), registration fallback
  (D). Renderer data round-trips through its Zod schema.
- Typecheck with SDK 0.11.4; client bundle compiled by the installed daemon and
  loaded into stand-in 0.11 and 0.14 apps.
- Live: an agent on a managed account shows that account in Paseo's popover; the
  Usage modal lists the managed accounts (with the known duplicate of B once an
  agent's usage details were opened); a forced exhausted reading produces the
  row and the switch, for a failed Codex turn and a completed Claude one.
