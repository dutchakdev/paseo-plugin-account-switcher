# Verification

Last checked: **2026-10-27**. These results describe observed checks, not a guarantee
that every provider version or account lifecycle has been validated.

## Automated checks

On **2026-10-08**, the subscription-ID fix passed `npm run check` on Linux with
the pinned 0.8.0 SDK: build, typecheck, and **215/215 tests** in 24 files. The
full suite ran outside the filesystem sandbox because sandboxed fixture
subprocesses returned empty output. New regressions cover host-assigned IDs,
one observation across polling and pagination, retries, and disposal while
setup is pending.

Using the **0.11.1** client SDK against a running **0.11.1** daemon reproduced
the old subscription-ID rejection. The fixed client runtime then discovered
51 supported agents, reported no discovery error, retained one observation
across a refresh, and released it on disposal. Composer registrations and
account RPCs were stubbed in this check; it did not switch accounts or start
provider sessions.

Later on **2026-10-08**, the launch-receipt fix passed `npm run check`: build,
typecheck, and **218/218 tests** in 24 files. On a running **0.11.1** daemon,
`paseo agent reload` logged only a refresh from persistence and started no
provider CLI, so applying an account failed with `ENOENT` on the receipt. New
regressions cover a receipt that arrives after reload returns, a launch that
never confirms, and the controller starting the CLI by listing agent commands;
the controller test fails without the fix.

On **2026-09-16**, clean source snapshots were installed with `npm ci --ignore-scripts --legacy-peer-deps`,
then checked with `npm run check`.

| Platform | Node.js | Build | Typecheck | Tests |
| --- | --- | --- | --- | --- |
| macOS | 22.23.0 | Passed | Passed | 209/209, 23 files |
| Linux | 22.22.2 | Passed | Passed | 209/209, 23 files |

The test setup removes inherited provider environment settings before loading
fixtures. Injecting synthetic authentication overrides reproduces the old
environment-dependent failures; with the setup enabled all tests pass. Production
authentication checks are unchanged.

Coverage includes profile isolation, shared history, startup confirmation,
switching and rollback, sign-in reservations and cancellation, stale responses,
quota parsing and identity changes, concurrency, retry delays, cache recovery,
modal ownership, and client cleanup. Real synthetic subprocesses verify process
group cleanup after cancellation and parent crashes, including descendants that
ignore TERM. Tests do not require provider accounts or send model messages.

The standalone launcher includes full license texts for its three bundled
dependencies. Build rejects unreviewed dependency versions or changed license
texts. Rebuilding from a different working directory produced identical output.

The GitHub Actions workflow is configured for Node 22 on macOS and Linux.
`actionlint` passed locally. A hosted Actions run remains separate from these
local and SSH-based results.

## Development SDK 0.11.4, Paseo usage and failover — 2026-10-27

- The development SDK (`@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol`)
  moved from 0.8.0 to **0.11.4**, the oldest supported Paseo. Typechecking against it
  shows the plugin uses only API that 0.11 has. The entries below that say the SDK
  is pinned to 0.8.0 describe the pin at their dates.
- The launcher bundles `defineRpc` from `@getpaseo/plugin`, so its license was
  reviewed again. `licenses/paseo-0.8.0.txt` became `licenses/paseo-0.11.4.txt`
  with no change to the text; the commit that moved the pin records the upstream
  `v0.11.4` LICENSE as identical to the one reviewed for 0.8.0. `scripts/build.mjs`
  accepts only `@getpaseo/plugin` 0.11.4 with that file, and the notices cite the
  `v0.11.4` commit. The build still fails for any other bundled version or a
  changed license text.
- `npm run check` on macOS (arm64) with Node.js **22.23.0**, TypeScript **7.0.2**
  and Vitest **5.0.5** passed: the launcher build (522,796 bytes, three third-party
  licenses, `server/launcher-artifact.ts` unchanged by the rebuild), typecheck with
  no errors, and **429/429 tests** in 38 files.
- `node scripts/release.mjs check` passed. `npm pack` produced a 55-file tarball
  and `node scripts/check-package.mjs` reported it as expected: required files,
  the manifest without build commands, no install command in either overview, and
  the shrinkwrap. The tarball was removed afterwards.
- New tests cover the session environment (`tests/session-env.test.ts`), the
  usage source's discovery, keys and report mapping (`tests/paseo-usage.test.ts`),
  the failover decision and its hourly guard (`tests/failover.test.ts`), the hooks
  that wire them (`tests/server-hooks.test.ts`), screen registration on stand-in
  apps with and without the new API (`tests/ui-screens.test.ts`), and the failover
  row and its setting (`tests/failover-row.test.ts`, `tests/ui-failover-row.test.ts`,
  `tests/ui-failover-setting.test.ts`). They use stand-in daemon and app objects; no
  Paseo daemon or app was started for them.
- The 0.13 entry below says the plugin listens only to `agent.created`. It now also
  listens to `agent.turn_ended` for failover, and reads only `agent`, `turnId` and
  `outcome` from it, not the `timeline` that 0.13 leaves empty.
- Not yet checked live: an agent on a managed account showing that account in
  Paseo's usage popover, the Usage view listing the managed accounts, and a
  used-up reading producing the failover row and its switch. They are listed under
  Remaining live acceptance.

## Final review fixes to failover — 2026-10-27

- `npm run check` on macOS (arm64) with Node.js **22.23.0**, TypeScript **7.0.2**
  and Vitest **5.0.5** passed: the launcher build (522,832 bytes, three
  third-party licenses), typecheck with no errors, and **468/468 tests** in 38
  files. `node scripts/release.mjs check` passed.
- Paseo facts behind the fixes, read in the Paseo source at tags v0.11.0 and
  v0.13.0: the Claude provider's `appendResultEvents` turns every result of
  subtype `success` into `turn_completed`, an API error with `is_error` set
  included; `finalizeForegroundTurn` sets an agent with a terminal error to
  `error` before the stream event that becomes `agent.turn_ended` is dispatched.
- New tests: a completed Claude turn checked only when the cached reading shows
  the account used up (no refresh otherwise) and not while Claude's extra usage
  (the parser's `extra_usage` spend window) has room, one row per exhaustion
  rather than per turn, Codex completed turns still ignored, an automatic switch after a completed Claude turn without
  **Continue.**, the cached-reading prefilter and the stale and
  `usageAllowed: false` cases of `failoverDecision` (`tests/failover.test.ts`,
  `tests/server-hooks.test.ts`); an unconfirmed launch confirmed by its receipt
  through `accountOf`, also for an agent a failed turn left in `error` (the hook
  test runs the real controller), with no row and a clear refusal without one
  (`tests/controller.test.ts`, `tests/server-hooks.test.ts`); stale offers,
  `switchTo` putting the selection back after a refusal, and `SwitchRefusal`
  against other errors, also for `failover.apply`'s checks before the switch (`tests/switching.test.ts`, `tests/server-hooks.test.ts`,
  `tests/ui-failover-row.test.ts`, `tests/failover-row.test.ts`). They use
  stand-in daemon and app objects; no Paseo daemon or app was started.
- Not checked live: a Claude turn on a really used-up account, and an agent
  started with no app open. Both are listed under Remaining live acceptance.

## Paseo 0.14 compatibility — 2026-10-27

- The manifest accepts `0.11.* || 0.12.* || 0.13.* || 0.14.*`; development SDK
  dependencies remain pinned to 0.8.0.
- Paseo **0.14.0-beta.1**'s own `assertPluginCompatibility` rejected the previous
  range for 0.14.0-beta.1, 0.14.0, and 0.14.9, so 0.7.0 cannot load on 0.14. The new
  range was accepted for 0.11.0-beta.1, 0.11.4, 0.12.0, 0.13.2, 0.14.0-beta.1, 0.14.0,
  and 0.14.9, and rejected for 0.10.3, 0.15.0-beta.1, and 0.15.0. Checks against
  future version numbers validate the range, not those runtimes.
- 0.14 changes only the server half of the plugin SDK: `agent.session_open`
  requests gain `title`, `labels`, `tools`, and `mcpServers`, `defineAgentTool`
  lets a plugin give agents tools of its own, and providers get a
  `session.can_stop_runtime` request. The client entries are unchanged. The
  plugin's `agent.session_open` hook changes only `env` and spreads the rest of the
  request. That matters on 0.14: Paseo checks each hook's result against a strict
  schema in which the new fields are required, and refuses the session open when a
  read-only field changed. Each plugin's hook sees only its own `tools` and
  `mcpServers`, starting empty; Paseo merges them across plugins afterwards.
- With the SDK swapped to **0.14.0-beta.1** in a scratch copy, typecheck passed
  with no errors and **308/308 tests** passed. The build step is skipped there for
  the reason recorded under 0.12.
- With the pinned 0.8.0 SDK, `npm run check` passed: launcher build, typecheck, and
  **308/308 tests**.
- An isolated **0.14.0-beta.1** daemon with an empty home directory installed the
  plugin from source as `running` and logged `Plugin ready`, alongside Machine
  Status, Mermaid, and Secure Input. A Claude Haiku agent created through that
  daemon replied normally. Integration stayed disabled and no account was switched,
  so this verifies loading, not switching or UI in a 0.14 client.

## Paseo 0.13 compatibility — 2026-10-22

- The manifest accepts `^0.8.0 || 0.9.* || 0.10.* || 0.11.* || 0.12.* || 0.13.*`;
  development SDK dependencies remain pinned to 0.8.0.
- Paseo **0.13.0-beta.1**'s own `assertPluginCompatibility` rejected the previous
  range for 0.13.0-beta.1, 0.13.0, and 0.13.9, so 0.3.2 cannot load on 0.13. The new
  range was accepted for 0.8.0, 0.10.3, 0.11.4, 0.12.0, 0.13.0-beta.1, 0.13.0, and
  0.13.9, and rejected for 0.7.2, 0.14.0-beta.1, and 0.14.0. Checks against future
  version numbers validate the range, not those runtimes.
- 0.13 changes the plugin SDK. Two entries touch this plugin's surface:
  `@getpaseo/plugin/client/react-native` is deprecated in favor of `client/ui`, and
  `agent.turn_ended` events now carry an empty `timeline`. The deprecated entry is a
  re-export of `client/ui` in the SDK, and the 0.13 app resolves both specifiers to
  the same runtime, so the plugin keeps the old import: older apps have no `Icon`,
  `Modal` or `TextInput` in `client/ui`. The plugin listens only to
  `agent.created`, not to turn-ended events.
- With the SDK swapped to **0.13.0-beta.1** in a scratch copy, typecheck passed
  with no errors and **239/239 tests** passed. The build step is skipped there for
  the reason recorded under 0.12.
- With the pinned 0.8.0 SDK, `npm run check` passed: launcher build, typecheck, and
  **239/239 tests**.
- An isolated **0.13.0-beta.1** daemon with an empty home directory installed the
  plugin from source as `running` and logged `Plugin ready`, alongside Machine
  Status, Mermaid, and Secure Input. A Claude Haiku agent created through that
  daemon replied normally. Integration stayed disabled and no account was switched,
  so this verifies loading, not switching or UI in a 0.13 client.

## Paseo 0.12 compatibility — 2026-10-17

- The manifest accepts `^0.8.0 || 0.9.* || 0.10.* || 0.11.* || 0.12.*`; development
  SDK dependencies remain pinned to 0.8.0.
- Paseo **0.12.0-beta.1**'s own `assertPluginCompatibility` rejected the previous
  range for 0.12.0-beta.1, 0.12.0, and 0.12.9, so 0.3.1 cannot load on 0.12. The new
  range was accepted for 0.8.0, 0.9.2, 0.10.3, 0.11.0-beta.3, 0.11.4, 0.12.0-beta.1,
  0.12.0, and 0.12.9, and rejected for 0.7.2, 0.13.0-beta.1, and 0.13.0. Checks
  against future version numbers validate the range, not those runtimes.
- The 0.12.0-beta.1 changelog lists only plugin fixes. Its plugin SDK declarations
  are identical to 0.11.4; the client SDK adds an optional `background` field.
- With the SDK swapped to **0.12.0-beta.1** in a scratch copy, typecheck passed and
  **239/239 tests** passed. The build step is skipped there, because it refuses an
  unreviewed bundled `@getpaseo/plugin` version by design. A test mock typed only
  for the 0.8.0 SDK failed typecheck against 0.11.4 and 0.12; it now casts.
- With the pinned 0.8.0 SDK, `npm run check` passed: launcher build, typecheck, and
  **239/239 tests**.
- An isolated **0.12.0-beta.1** daemon with an empty home directory installed the
  plugin from source as `running` and logged `Plugin ready`, alongside Machine
  Status, Mermaid, and Secure Input. A Claude Haiku agent created through that
  daemon replied normally. Integration stayed disabled and no account was switched,
  so this verifies loading, not switching or UI in a 0.12 client.

## Paseo 0.11 compatibility — 2026-10-05

- The manifest accepts `^0.8.0 || 0.9.* || 0.10.* || 0.11.*`; development SDK
  dependencies remain pinned to 0.8.0.
- The published Paseo **0.11.0-beta.4** compatibility checker accepted 0.8.0,
  0.9.2, 0.10.0-beta.1, 0.10.3, 0.11.0-beta.1, 0.11.0-beta.3, 0.11.0-beta.4,
  0.11.0, 0.11.5, and 0.11.99 for both daemon and app checks. It rejected 0.7.2,
  0.12.0-beta.1, and 0.12.0. Checks against future version numbers validate the
  range, not those runtimes.
- The 0.11.0-beta.1 through beta.4 changelog lists only additions to the plugin
  SDK. With the SDK swapped to **0.11.0-beta.4** in a scratch copy, typecheck
  passed and **209/209 tests** passed. With the pinned 0.8.0 SDK, `npm run check`
  passed: launcher build, typecheck, and **209/209 tests**.
- The local **0.11.0-beta.3** daemon, which had refused the previous
  `^0.8.0 || 0.9.* || 0.10.*` manifest, reloaded the plugin as `running` and
  logged `Plugin ready`. This verifies loading, not UI interactions in a 0.11
  client.

## npm package — 2026-10-05

- `npm pack` produced `paseo-plugin-account-switcher-0.2.0.tgz` (39 files). Its
  manifest has no `build` commands and it contains `server/launcher-artifact.ts`;
  the working-tree manifest was restored afterwards.
- Paseo Cafe's registry static scanner, run locally against the extracted
  tarball and against a copy of the tracked Git files, reported **0 blocking
  findings** for both.
- Installed the way Paseo installs npm sources (`npm install --ignore-scripts
  --legacy-peer-deps --omit=dev`), the package loaded as `running` on an
  isolated **0.11.0-beta.3** daemon with an empty home directory. The first
  attempt failed on direct `@getpaseo/client` type imports, which the release
  removes. No agent or sign-in was started.
- This used a local tarball. Installing the published package by name remains
  to be checked after publication.

## Paseo 0.10 compatibility — 2026-09-28

- The manifest accepts `^0.8.0 || 0.9.* || 0.10.*`; development SDK dependencies
  remain pinned to 0.8.0.
- The published Paseo **0.10.0-beta.1** compatibility checker accepted 0.8.0,
  0.9.0-beta.1, 0.9.2, 0.10.0-beta.1, 0.10.0-beta.7, 0.10.0, 0.10.3, and 0.10.99
  for both daemon and app checks. It rejected 0.7.2, 0.11.0-beta.1, and 0.11.0.
  Checks against future version numbers validate the range, not those runtimes.
- With the SDK swapped to **0.10.0-beta.1** in a scratch copy, typecheck passed and
  **209/209 tests** passed. With the pinned 0.8.0 SDK, `npm run check` passed:
  launcher build, typecheck, and **209/209 tests**.
- The local **0.10.0-beta.1** daemon, which had refused the previous
  `^0.8.0 || 0.9.*` manifest, reloaded the plugin as `running` and logged
  `Plugin ready`. This verifies loading, not UI interactions in a 0.10 client.

## Paseo 0.9 compatibility — 2026-09-18

- The manifest accepts `^0.8.0 || 0.9.*`; development SDK dependencies remain
  pinned to 0.8.0.
- The published Paseo **0.9.0-beta.2** manifest reader and compatibility checker
  accepted 0.8.0, 0.9.0-beta.1, 0.9.0-beta.2, 0.9.0, 0.9.1, and 0.9.99 for both
  daemon and app checks. They rejected 0.7.2 and 0.10.0. Checks against future
  stable version numbers validate the range, not those future runtimes.
- On macOS, `npm run check` passed: launcher build, typecheck, and **209/209 tests**.
- An isolated **0.9.0-beta.2** daemon loaded the plugin as `running`, served its
  compiled client bundle, and handled an RPC with the expected missing-session
  error. Provider homes were empty; no agent or sign-in was started. This verifies
  loading and compilation, not UI interactions in a 0.9 client.
- Reload on the existing local **0.8.0** daemon returned `running`.

## Live checks — 2026-09-16

### macOS

Checked with Paseo **0.8.0**, Claude Code **2.1.263**, and Codex **0.153.4**:

- Plugin installation and reload returned `running`; logs showed normal lifecycle
  events without plugin errors.
- Claude and Codex returned quota windows for existing subscription identities.
  Missing windows, retained stale data, and subsequent refreshes were observed.
- The composer chip opened a centered modal at **1200×765** and a bottom sheet at
  **390×844**, in Light and Dark. Closing/reopening preserved the chat, and
  **All accounts** opened the account list without adding a new agent panel.
- Isolated temporary profiles obtained Claude authorization links, Codex device
  links/codes, and Codex browser links. Sign-in controls, manual Claude code input,
  cancellation, and removal were checked. No terminal or workspace was created.
- Temporary profiles were removed afterward. Browser error logs were empty;
  appearance and viewport settings were restored and the test proxy was stopped.

Provider consent and successful credential exchange were not completed live.
Clipboard/browser actions have regression tests; live checks inspected their
controls without changing the user's clipboard or opening authorization pages.
The desktop copy fallback was verified against Electron source and adapter tests,
not by completing a native desktop sign-in.

### Linux

Checked with an isolated Paseo **0.8.0** daemon, Claude Code **2.1.259**, and Codex
**0.153.0**:

- The plugin loaded as `running`; `accounts.list` and `usage.list` responded.
- Existing system profiles were discovered. Codex returned live limits; Claude
  reported that sign-in was required.
- No messages were sent to models. The existing working daemon was not restarted
  as part of this isolated check.

## Remaining live acceptance

- In a Paseo 0.11 or later app on a real daemon: an agent on a managed account
  shows that account in Paseo's usage popover, and the Usage view lists the
  managed accounts and none of the **Current CLI** accounts twice. After an
  agent's usage details are opened, expect the known duplicate described under
  Known limits. Paseo may also read `CLAUDE_CONFIG_DIR` for settings or session
  files; a managed home links those directories to the source home, so check
  that a chat on a managed account behaves as before.
- A Codex turn that fails on a really used-up account (or a forced reading)
  produces the failover row, the button switches and sends **Continue.**, and
  automatic switching does the same with the setting on. Include an agent on
  **Current CLI**.
- A Claude turn that hits its limit, which Paseo reports as completed, produces
  the row; with automatic switching on, the chat switches without **Continue.**
  and the row says where the next message runs. The SDK and provider mapping
  behind this was read in source, not observed on a live account.
- An agent started with no app open (a schedule or `paseo run`) gets the row
  once its launch receipt confirms its account.
- Two distinct authenticated accounts for **each** provider, concurrent agents,
  and A → B → A within the same chat.
- Comparing every reported quota with the provider's own display, including
  inactive accounts.
- Full OAuth completion for Claude and Codex through the new dialog.
- Context preservation after real compaction, child sessions, and Claude rewind.
- A physical phone or native mobile client. A compact browser viewport does not
  establish native-device behavior.

## Known limits

- Paseo's Usage view can show one managed account twice. Opening the usage
  details of an agent on a managed account lets Paseo's own Claude or Codex
  source find that login through the session environment, and Paseo adds it to
  the global list next to the Account Switcher card. Cards of different sources
  cannot be merged from a plugin.
- Failover needs the agent's account confirmed. An unconfirmed launch is
  confirmed from its receipt, and for failover also while the agent is `error`,
  which Paseo sets after a failed turn before the plugin's hook runs
  (`finalizeForegroundTurn`, v0.11.0 and v0.13.0). The Accounts list still
  confirms only an `idle` or `running` agent. An agent without a matching
  receipt gets no row.
- A new agent that fails before registering, without a startup receipt, can leave
  an unconfirmed reservation requiring manual diagnosis. Archived agents retain
  bindings for resume.
- Retry deadlines are held in memory and restart with the monitor. Last-success
  data persists but remains hidden until its identity is verified again.
- Old launch receipt files may remain, but consumed tokens cannot confirm a
  later launch.
- Browser popup or clipboard restrictions can block automatic sign-in actions.
  Explicit buttons and selectable link text remain available.
- Windows daemons are not supported. Linux deployments need a normal process
  supervisor/init that reaps child processes.

See [installation](installation.md) for setup and recovery, and
[architecture](architecture.md) for the runtime and data boundaries.
