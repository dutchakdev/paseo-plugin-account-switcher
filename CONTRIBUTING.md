# Contributing

Account Switcher is a TypeScript plugin for Paseo 0.11.x through 0.14.x, including beta releases after 0.11.0, with a React Native client and a Node.js daemon component. Changes should preserve explicit account selection, profile isolation, and honest limits data.

## Development setup

Use **Node.js 22.12.0 or newer** and npm. From the repository root:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run typecheck
npm test
```

Run the build first on a fresh checkout: it generates `server/launcher-artifact.ts`, which is imported by the server and some tests. Rebuild whenever launcher code or one of its dependencies changes. Do not edit or commit the generated artifact.

Tests use temporary directories, synthetic credentials, and mock or synthetic provider processes. They do not require signing in to a real subscription. Installation and live UI testing additionally need Paseo and an official provider CLI on the daemon host (both, to exercise both providers); see [installation](docs/installation.md).

The test configuration clears inherited provider authentication variables inside the test processes; fixtures supply their own explicit values. This keeps a developer's shell credentials from changing test outcomes without weakening the production authentication checks.

Run a focused test while developing:

```sh
npm test -- tests/switching.test.ts
```

Before submitting, run `npm run check`, which runs the build, typecheck, and full test suite in that order.

Typechecking runs TypeScript 7, the native compiler. Its npm package has no `tsserver`, no `lib` files and no JavaScript API, so an editor set to the workspace's TypeScript shows no types (use the editor's bundled TypeScript), and code that needs to transpile TypeScript, like `tests/login-process.test.ts`, uses esbuild's `transformSync`. `vite` is a direct development dependency because Vitest 5 requires it as a peer, and the `--legacy-peer-deps` install in CI skips peers under npm 11 (Node 24). The build refuses a bundled dependency whose license has not been reviewed: when Dependabot moves `zod` or `@iarna/toml`, compare the new `LICENSE` with the file in `licenses/` and update `scripts/build.mjs` and `THIRD_PARTY_NOTICES.md`.

## Changelog and releases

Versions follow [semantic versioning](https://semver.org). A pull request with a user-visible change adds an entry under `## Unreleased` at the top of `CHANGELOG.md`, in the `Added`, `Changed`, `Fixed`, or `Removed` group. The release notes are that section, so write entries for people who run the plugin.

To cut a release from an up-to-date `main`:

```sh
node scripts/release.mjs prepare minor   # or patch, major, premajor, preminor, prepatch, prerelease (beta id), or 1.2.3-beta.1
npm run check
```

`prepare` dates the Unreleased section, sets the version in `package.json` and `package-lock.json`, and prints the commit, push, and tag commands. Pushing the `v` tag starts the [Release workflow](.github/workflows/release.yml). It stops if the tag is not on `main`, does not match `package.json`, has no dated changelog section, or names a version older than the newest on npm. It then packs and checks the tarball, runs the test matrix, publishes that tarball to npm with provenance, and creates the GitHub release from the changelog section. Prereleases go to the `next` dist-tag and are marked as prereleases on GitHub.

Versions only move forward: the workflow refuses a version below the newest one on npm, prereleases included, so a fix for an older line ships as the next version.

If a run fails for a reason outside the tagged commit, such as npm settings or a flaky runner, fix it and run the workflow again from the same tag, with **Run workflow → Use workflow from → Tags** or `gh workflow run release.yml --ref vX.Y.Z`. A run started from a branch stops at once. A fix to the code needs a new version. A version already on npm is not published again, and the run only completes the GitHub release; npm can take a few minutes to list a new version, so wait before retrying right after a publish.

The plugin directory on paseo.sh pins an npm version, so a release is not finished until that pin moves. Its bot proposes new npm versions only at 05:17 and 17:17 UTC; do not wait for it. Right after npm lists the version, open the bump yourself in a fork of [getpaseo/plugins](https://github.com/getpaseo/plugins), changing only `plugins/dutchakdev/account-switcher.json` the way `bump.yml` does:

1. `artifact.version`, `artifact.resolved` and `artifact.integrity` from `npm view paseo-plugin-account-switcher@X.Y.Z dist`.
2. `repository.commit`: `git rev-parse 'vX.Y.Z^{commit}'`.
3. `reviewedAt`: the current UTC time to the second; leave `submittedAt`, `publishedAt`, categories and `listing` alone.
4. Commit, then run `node scripts/validate.ts --online --changed --base upstream/main` and `npm test` in the registry checkout, and open the pull request titled "Bump dutchakdev/account-switcher to X.Y.Z".

The listing changes once a reviewer approves it. The listing text comes from `OVERVIEW.md` in the package; update it when setup or behavior changes, and keep install commands out of it: the directory rejects them, and so does `scripts/check-package.mjs`. Paseo Cafe expects the npm version to match `package.json` on `main`, so push the tag right after the release commit.

Publishing uses npm trusted publishing, so the repository stores no npm token. The package's trusted publisher on npmjs.com names repository `dutchakdev/paseo-plugin-account-switcher`, workflow `release.yml`, and environment `npm`. Keep that environment limited to `v*` tags in the repository settings, since npm does not check which ref a run started from.

`npm pack` and `npm publish` run `prepack`, which builds the launcher, temporarily removes the Git-only `build` commands from `paseo-plugin.json`, and writes `npm-shrinkwrap.json`; `postpack` restores the manifest and deletes the shrinkwrap. Paseo runs manifest build commands for npm installs too, but without development dependencies or a lockfile, so the published manifest must not carry them. The shrinkwrap is the production part of `package-lock.json`: npm publishes it and honors it when Paseo installs the plugin, while `package-lock.json` is neither published nor read there. The Paseo plugin directory requires that lock for packages with runtime dependencies, and `scripts/check-package.mjs` rejects a tarball without it. The shrinkwrap stays out of Git, because npm would prefer it to `package-lock.json` for development installs. If packing is interrupted, run `node scripts/pack-manifest.mjs restore` and `node scripts/shrinkwrap.mjs remove`.

Server and client code must not import `@getpaseo/client` or `@getpaseo/protocol` directly, even for types: they are development dependencies and are absent from an npm installation. Name those types through `@getpaseo/plugin/server` or `@getpaseo/plugin/client`, as `server/paseo-api.ts` does.

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

The [architecture guide](docs/architecture.md) explains how these parts fit together. Use the [public Paseo plugin reference](https://paseo.sh/docs/plugins/reference) and installed SDK declarations when changing integration code. SDK development dependencies stay pinned to 0.11.4, the oldest supported Paseo, so typechecking keeps the plugin on the 0.11 API, which every supported release still provides.

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
