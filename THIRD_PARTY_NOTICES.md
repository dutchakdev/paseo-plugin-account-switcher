# Third-party notices

The standalone provider launcher contains code from the following packages.
The list comes from esbuild's output metafile, counting only dependencies that
contribute code after tree shaking. Development-only packages are not included
in this launcher list.

| Package | Bundled version | License | Full text |
| --- | --- | --- | --- |
| `@getpaseo/plugin` | 0.8.0 | Apache-2.0, with the upstream third-party component exception | [Paseo license](licenses/paseo-0.8.0.txt) |
| `@iarna/toml` | 2.2.5 | ISC | [TOML license](licenses/iarna-toml-2.2.5.txt) |
| `zod` | 4.6.5 | MIT | [Zod license](licenses/zod-4.6.5.txt) |

`npm run build` preserves esbuild's legal comments and embeds each complete
license, including copyright and permission notices, directly in the standalone
launcher's comment header. The generated `server/launcher-artifact.ts` contains
that header inside `LAUNCHER_SOURCE`; the launchers written to the daemon's data
directory retain it. No network request is needed during the build.

These dependencies are bundled and minified by esbuild. Their source code is
otherwise unmodified. The emitted Paseo code comes from the SDK's `rpc`,
`settings`, and `attachments` modules.

## License sources

- **Paseo:** copyright 2025-present Mohamed Boudra. The published SDK package
  does not include a license file, so the complete file is copied from the
  matching upstream [`v0.8.0` release](https://github.com/getpaseo/paseo/blob/v0.8.0/LICENSE),
  commit [`b8e24677e12b226c7c38c1c3a40649daa9f1152f`](https://github.com/getpaseo/paseo/blob/b8e24677e12b226c7c38c1c3a40649daa9f1152f/LICENSE).
  It retains the upstream statement that third-party components keep their own
  licenses. That release has no separate root or plugin-package `NOTICE` file.
- **`@iarna/toml`:** copyright 2016 Rebecca Turner. The full text is copied
  byte for byte from `@iarna/toml@2.2.5/LICENSE` in the installed npm package.
- **Zod:** copyright 2025 Colin McDonnell. The full text is copied byte for byte
  from `zod@4.6.5/LICENSE` in the installed npm package.

## Updating dependencies

The build fails if an emitted package or version lacks a reviewed entry in
`scripts/build.mjs`. It also checks that the vendored TOML and Zod license texts
match the installed packages. When updating dependencies, inspect the new
license and attribution requirements, update `licenses/`, the reviewed versions
in the build script, and this document, then build and verify the launcher.

This document covers the bundled standalone launcher. Other packages installed
for development or supplied by Paseo remain subject to their own licenses.
