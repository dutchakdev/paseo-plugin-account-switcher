# Verification

Last checked: **2026-09-16**. These results describe observed checks, not a guarantee
that every provider version or account lifecycle has been validated.

## Automated checks

Clean source snapshots were installed with `npm ci --ignore-scripts --legacy-peer-deps`,
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

## Live checks

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
