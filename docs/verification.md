# Verification

Last checked: **2026-10-08**. These results describe observed checks, not a guarantee
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
  request, so the new fields, and the tools other plugins put there, pass through.
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

- Two distinct authenticated accounts for **each** provider, concurrent agents,
  and A → B → A within the same chat.
- Comparing every reported quota with the provider's own display, including
  inactive accounts.
- Full OAuth completion for Claude and Codex through the new dialog.
- Context preservation after real compaction, child sessions, and Claude rewind.
- A physical phone or native mobile client. A compact browser viewport does not
  establish native-device behavior.

## Known limits

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
