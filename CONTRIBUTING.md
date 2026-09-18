# Contributing

Account Switcher is a TypeScript plugin for Paseo 0.8.x and 0.9.x, including beta releases, with a React Native client and a Node.js daemon component. Changes should preserve explicit account selection, profile isolation, and honest limits data.

## Development setup

Use **Node.js 22.12.0 or newer** and npm. From the repository root:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run typecheck
npm test
```

Run the build first on a fresh checkout: it generates `server/launcher-artifact.ts`, which is imported by the server and some tests. Rebuild whenever launcher code or one of its dependencies changes. Do not edit or commit the generated artifact.

Tests use temporary directories, synthetic credentials, and mock or synthetic provider processes. They do not require signing in to a real subscription. Installation and live UI testing additionally need Paseo and both official provider CLIs on the daemon host; see [installation](docs/installation.md).

The test configuration clears inherited provider authentication variables inside the test processes; fixtures supply their own explicit values. This keeps a developer's shell credentials from changing test outcomes without weakening the production authentication checks.

Run a focused test while developing:

```sh
npm test -- tests/switching.test.ts
```

Before submitting, run the build, typecheck, and full test suite above.

`npm run check` runs those three checks in that order.

## Find the relevant code

| Path | Responsibility |
| --- | --- |
| `index.client.tsx`, `client/` | Accounts, sign-in, limits UI, composer chip, and modal state |
| `index.server.ts`, `server/controller.ts` | RPCs and coordination of account operations |
| `server/profiles.ts`, `server/integration.ts` | Profile preparation and provider command ownership |
| `server/switching.ts`, `server/launcher-main.ts` | Prepared selection, native reload, startup confirmation, rollback |
| `server/login.ts`, `server/login-process.ts` | Official CLI sign-in and process lifecycle |
| `server/usage/` | Limits collectors, identity verification, cache, and scheduler |
| `shared/contracts.ts` | Public RPC schemas and shared types |
| `tests/` | Behavioral regressions and synthetic process fixtures |

The [architecture guide](docs/architecture.md) explains how these parts fit together. Use the [public Paseo plugin reference](https://paseo.sh/docs/plugins/reference) and installed SDK declarations when changing integration code. SDK development dependencies stay pinned to 0.8.0 so typechecking preserves the oldest supported API.

## Change guidelines

- Keep runtime modules in `client/`, `server/`, or `shared/`, apart from the two entry files. Client code must not import server or Node modules.
- Use public Paseo APIs. Keep browser globals inside `client/web.ts`; use React Native primitives, host UI components, and theme colors elsewhere.
- Preserve the single-scroll modal, compact layouts, keyboard access, and touch targets of at least 44 pixels. Product copy is English; displayed dates use the device's local time zone.
- Keep the current account distinct from a pending selection. Never apply a selection automatically, silently assume a successful startup, or fall back to a different account after an isolation failure.
- Preserve identity checks, stale-data handling, all provider windows, and unknown values. A passed reset time does not prove zero usage.
- Keep credentials, authorization URLs/codes, and raw provider output out of fixtures, logs, screenshots, and public reports. Use synthetic values for tests.
- Add a behavioral regression for a bug: exercise the failure, race, or boundary through the relevant API. Prefer this to assertions about source text or incidental rendering details.
- Update user documentation when behavior, setup, or recovery changes.

## Live validation

Use a development daemon and accounts you are authorized to use. Run the checks before loading changes, then reload the plugin rather than restarting the daemon:

```sh
paseo plugin reload account-switcher --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

Confirm the intended host and `running` status. For UI changes, check a desktop dialog and compact/mobile sheet in light and dark themes. For lifecycle changes, exercise failure and cancellation as well as success. Finish or cancel sign-ins before reload.

Report automated checks separately from live results. A mock reload is not evidence of real multi-account switching; a running plugin is not evidence of UI acceptance. [Verification notes](docs/verification.md) record that distinction.

## Issues and pull requests

For a bug, include reproduction steps, expected and actual behavior, daemon OS, client type, Node/Paseo/provider CLI versions, and sanitized errors. Omit private identities, paths, authentication links, and secrets.

For a feature, describe the user problem and desired behavior. Pull requests should explain the resulting behavior, relevant tests, documentation changes, and any remaining live-validation limits. Keep changes focused so they can be reviewed independently.
