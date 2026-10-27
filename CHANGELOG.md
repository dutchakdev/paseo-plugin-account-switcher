# Changelog

## 0.8.0 - 2026-10-27

### Added

- Paseo's Usage view lists your signed-in accounts under the source **Account Switcher**, with each plan and limit window. It shows the readings the plugin already has and sends no provider request; a limit the provider names without any reading is left out, as in Paseo's own cards. The **Current CLI** accounts are not listed again, since Paseo's own cards show them. Accounts that need sign-in or are in the middle of one are left out. Known limitation: after you open the usage details of an agent on a managed account, Paseo's own Claude or Codex card for that login can appear next to the Account Switcher card, and the plugin cannot merge cards of different sources.
- When a turn stops because its account's limit is used up, the chat shows a row: *Work's limit is used up until 18:00.* and a button, **Switch to Second and continue**, or *No other account has room.* The plugin decides this from the account's limits, read again after the turn, never from the error text, so other failures add nothing. Codex reports such a turn as failed. Claude reports it as completed, so a completed Claude turn is read again only when the plugin's last reading already shows the account used up, and an ordinary turn costs no provider request; while the account's paid extra usage has room, which lets Claude answer past a full 5-hour window, a completed turn adds nothing. Each time an account runs out, the chat gets one row, not one per turn. The button switches with the usual checks (the agent is idle, no permission request is pending), sends the agent **Continue.**, and the row reports the outcome or the reason the switch failed. An offer that is out of date, because the chat moved to another account since or already runs on the offered one, is refused with that reason. A switch refused before the reload leaves no selection behind, and an unexpected error shows *The switch failed; the plugin log has details.* instead of its text. Agents on **Current CLI** are included, and so are agents started while no app was open, once the launcher's startup receipt confirms their account. Nothing is offered while account switching is off for the provider.
- **When a limit runs out during a chat**, a setting under each provider with more than one account in Accounts: **Offer a switch** (the default) or **Switch automatically**. Automatic switching happens once per turn, at most three times an hour for a chat, and never back to an account the chat left within that hour; otherwise the chat shows the usual offer. After a completed Claude turn it does not send **Continue.**, since the turn may really have finished; the row says *Your next message runs on Second.*

### Changed

- Accounts is registered with Paseo's screen API (`addScreen`, `addSidebarHeaderItem`) where the app has it, and with the older surface API where it does not. It looks and behaves the same.
- The development SDK is Paseo 0.11.4, the oldest supported release, instead of 0.8.0, so the typecheck now covers only the API that every supported Paseo has. The bundled launcher includes the reviewed 0.11.4 license text.

### Fixed

- Paseo's usage popover for an agent on a managed account showed the limits of the default login. The plugin now puts the account's profile directory in the agent's session environment, so the popover shows the account the agent runs on. This applies while account switching is on for the provider; agents on **Current CLI** are unchanged.

## 0.7.1 - 2026-10-27

### Changed

- Supports Paseo 0.14, including its betas. The manifest range adds `0.14.*`; Paseo 0.14 rejected the previous range, so the plugin would not install or load there.

## 0.7.0 - 2026-10-27

### Added

- The chat records the account in a quiet line: after an applied switch (*Account switched from Work to Second*), and when a new agent did not start on the default, with the reason. The lines are best effort and do not survive a daemon restart.
- `/account name` switches a chat's account from the message field, and `/account default` returns it to the provider's default. Names match without regard to case, and a unique beginning is enough; an account named Default wins over the keyword. The switch applies at once when the agent is idle; while it responds, or when the account's plan lacks the agent's model, the switcher opens with the account selected. `/account` alone opens the switcher.
- The Command Center (⌘K) offers **Make “name” the Claude default** or **the Codex default** for every signed-in account that is not already the default.
- A new agent no longer starts on a default account that would fail. When the latest readings show the default has used up an account-wide limit that resets later, Codex reports that ordinary usage is not allowed, its plan lacks the Codex model chosen for the agent, or the default needs sign-in, the agent starts on the signed-in account of the same provider with the largest percentage left. Limits of a single model and extra paid usage do not count. With every account ruled out, it starts on the default as before. A choice made for the chat still wins. To keep the default binding for a provider, choose **Always use the default** under it in Accounts.
- Limit windows record whether they stop the whole account, one model, or extra paid usage, and Codex readings keep the provider's `ordinaryUsageAllowed` verdict.

### Fixed

- Apply and `/account` apply only the account the user selected. If another client changed the selection in the meantime, the switch is refused instead of applying that other account.

## 0.6.0 - 2026-10-26

### Added

- The plugin directory shows the plugin icon on the listing. The manifest declares it as `assets/icon.png`, moved from `docs/assets/`, and the package check fails when the tarball lacks the icon the manifest names.

### Changed

- Requires Paseo 0.11 or newer, on the daemon and in the app. Paseo 0.8 to 0.10 and the 0.11.0 betas refuse a manifest with an `icon` field. Those versions can stay on 0.5.0: `paseo plugin install dutchakdev/paseo-plugin-account-switcher --ref v0.5.0`.

## 0.5.0 - 2026-10-26

### Added

- A Simplified Chinese overview, which the Paseo plugin directory shows to readers who choose Chinese.
- A plugin icon for listings, in `docs/assets/icon.png`.
- Before **Apply** on a Codex chat, the switcher warns when the selected account's plan does not offer the agent's model, which would make the next message fail with `model_not_found`, and lists the models that plan offers. The plugin reads each Codex account's models together with its limits.

### Fixed

- A Claude account left idle no longer shows **Sign in again** while its sign-in is confirmed. Its access token had expired with no Claude session to renew it, so the limits request was refused. Before a limits check, the plugin now lets the official CLI renew an expired token with `claude -p /usage --no-session-persistence`, at most every 10 minutes per account; it sends no model message and saves no session.

### Changed

- The package description names what the plugin does, which the plugin directory shows as its summary. The overview also lists the monthly credit and spend limits added in 0.4.0, and says that a failed switch restores the previous account.

## 0.4.0 - 2026-10-24

### Added

- Codex accounts on usage-based workspace plans, such as `enterprise_cbp_usage_based`, show their monthly credit allowance as a limit, for example "75% left" and "3,765 of 5,000 credits left".
- Claude enterprise seats show their monthly spend allowance as a limit, for example "Monthly spend" with "$487.50 of $500.00 left".

## 0.3.4 - 2026-10-22

### Changed

- The npm package ships `npm-shrinkwrap.json`, which fixes the exact version, source and integrity of its one runtime dependency, `@iarna/toml`. npm installs the same tree on every host, and the Paseo plugin directory can list the release.

## 0.3.3 - 2026-10-22

### Changed

- Supports Paseo 0.13, including its betas. The manifest range adds `0.13.*`; Paseo 0.13 rejected the previous range, so the plugin would not install or load there.

## 0.3.2 - 2026-10-17

### Changed

- Supports Paseo 0.12, including its betas. The manifest range adds `0.12.*`; Paseo 0.12 rejected the previous range, so the plugin would not install or load there.

## 0.3.1 - 2026-10-15

The first npm release since 0.2.0, so it also ships the changes listed under 0.3.0.

### Changed

- The npm package includes `OVERVIEW.md`, which the Paseo plugin directory shows on the plugin's page.
- npm releases are published from GitHub Actions with provenance, so you can trace a package version to the commit and workflow that built it.

## 0.3.0 - 2026-10-15

### Changed

- Claude Code and Codex are each optional: the plugin needs only one of their CLIs on the
  daemon. A missing provider is shown as unavailable instead of failing every request, its
  authentication settings no longer block the other provider, and enabling integration
  installs launchers only for providers whose CLI was found.

### Fixed

- Agent account switchers on Paseo 0.11.1: let the host assign subscription IDs,
  keep one directory observation across refreshes and pagination, and release it
  when the plugin stops.
- Account switches on Paseo 0.11.1: start the reloaded provider CLI, which the host
  now launches on first use, and wait briefly for its launch receipt instead of
  failing with `ENOENT` on `receipts/<agent>.json`.

## 0.2.0 - 2026-10-05

### Added

- Support for Paseo 0.10.x and 0.11.x, including beta releases.
- npm distribution as `paseo-plugin-account-switcher` for Paseo 0.9 and newer. The
  package ships the generated launcher and needs no build on the daemon host.

### Fixed

- Loading from an npm installation, where development dependencies are absent:
  `@getpaseo/client` types are now named through the plugin SDK entries.

## 0.1.0

### Added

- Separate Claude and ChatGPT/Codex profiles, per-agent selection, and defaults.
- Manual switching within an existing chat, with startup confirmation and rollback.
- Quota monitoring for active and inactive accounts, freshness indicators, reset
  times, and provider retry delays.
- An English Accounts screen and a composer modal for desktop and compact layouts.
- Browser and device-code sign-in through the official CLIs without terminal tabs;
  desktop link copying and manual Claude authorization-code submission.
- Isolated credentials with shared settings, skills, MCP configuration, and history.
- Build, typecheck, and regression checks for macOS and Linux.

This is a pre-release. See [verification](docs/verification.md) for tested behavior
and the remaining live multi-account checks.
