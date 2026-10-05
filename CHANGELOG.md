# Changelog

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
