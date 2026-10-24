# Changelog

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
