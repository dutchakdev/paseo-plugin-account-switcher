# Installation and maintenance

[Back to the README](../README.md)

## Before installing

Account Switcher runs on the machine hosting your Paseo daemon. Its UI appears in connected Paseo clients; credentials and provider processes stay on the daemon.

Use a macOS or Linux daemon, Paseo **0.11.x through 0.14.x** on both daemon and client, and Node.js **22.12.0 or newer**. Beta releases are included: Paseo also checks a prerelease against its stable core version, so `0.14.0-beta.1` satisfies the manifest's `0.14.*` range. The exception is the 0.11.0 betas: they predate the manifest `icon` field and refuse the manifest. Paseo 0.8 to 0.10 refuse it too; they can stay on 0.5.0, the last release for them (see [Git installations](#git-installations)). See [Paseo's compatibility rules](https://paseo.sh/docs/plugins/reference#requirements).

Install the official `paseo` CLI and at least one of `claude` or `codex` for the daemon's operating-system user. Each provider CLI you want to use must be discoverable through the daemon's PATH or its configured Paseo provider command. A provider whose CLI is missing gets no launcher: Accounts says so and hides its **Current CLI** account. After installing it, reload the plugin, then select **Enable** in that provider's section if switching is already on for the other.

Existing CLI subscription sign-ins appear as **Current CLI** accounts. You can add isolated accounts through Paseo after installation. API keys, alternate API providers, and conflicting authentication or endpoint overrides are unsupported; the plugin reports them instead of assuming which account they represent.

Enable **Settings → Plugins → Enable plugins** on the target host. Paseo plugins are trusted, unsandboxed code. Installing this plugin and its dependencies grants them the daemon user's access, including files, processes, credentials, and network services.

## Plugin directory installations

On Paseo 0.11.0 or a later release, including 0.12, 0.13 and 0.14, install the reviewed version listed on [paseo.sh](https://paseo.sh/plugins/dutchakdev/account-switcher):

```sh
paseo plugin add dutchakdev/account-switcher --host 127.0.0.1:6767
```

The directory pins an npm version once a reviewer approves it, so a release reaches the directory after it reaches npm. `paseo plugin update account-switcher` moves to the newest approved version.

## npm installations

Install the published package:

```sh
paseo plugin install npm:paseo-plugin-account-switcher --host 127.0.0.1:6767
```

Paseo installs the package and its one runtime dependency, `@iarna/toml`, without lifecycle scripts or development dependencies. The package's `npm-shrinkwrap.json` fixes that dependency's exact version, source and integrity, so every host installs the same tree. The package already contains the generated launcher, and its manifest has no preparation steps, so nothing is built on the daemon host. `paseo plugin update account-switcher` moves to the newest published version.

## Git installations

`paseo plugin install` also accepts a Git source; use one you trust. From Paseo 0.11.0, a bare `owner/name` names a plugin directory entry, so prefix the repository with `git:`, as in `git:dutchakdev/paseo-plugin-account-switcher`. Earlier versions, including the 0.11.0 betas, read `dutchakdev/paseo-plugin-account-switcher` as a GitHub repository; they can install only up to 0.5.0, with `--ref v0.5.0`. The manifest declares the required preparation steps:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
```

Paseo runs these on the daemon host before activating a Git installation or update. A preparation failure leaves the installed version intact. On Paseo 0.9, a normal Git update follows the repository's default branch, even when the initial installation used a tag or commit. See the [Paseo CLI reference](https://paseo.sh/docs/plugins/reference#cli-reference) for source and revision syntax.

## Install a local checkout

Clone the repository onto the daemon machine. From that checkout:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
paseo plugin install "$PWD" --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

`npm run check` builds the native-provider launcher, then typechecks and tests; the build must come first on a fresh checkout. Paseo compiles the plugin's client and server entries when loading it.

Require **running** in the plugin list, then open **Accounts** on that host. Select **Enable** in Accounts to activate switching. This is separate from the daemon-wide plugin switch: it saves the original Claude and Codex commands and replaces them with account-aware launchers. It does not restart existing chats.

Keep one Account Switcher installation per daemon data directory. The registry and launchers use a fixed `account-switcher` directory; installing the same source under another runtime ID does not create an independent account store.

## Remote daemons

The source path passed to `plugin install` must exist **on the target daemon machine**. The command does not upload a local checkout. Prepare the source and run the dependency/build/check commands there, using the daemon's operating-system user.

Then install from that machine with a local host target, or select it through Paseo's supported SSH host syntax:

```sh
# Replace the user, host, and absolute path with those of the daemon machine.
paseo plugin install /absolute/path/on/daemon/account-switcher --host ssh://user@host
paseo plugin ls account-switcher --host ssh://user@host
```

Use the same `--host` value for subsequent management commands. If Accounts is available on several connected hosts, use its host picker to choose the intended daemon. Accounts, defaults, sign-ins, and limits belong to that host.

For remote sign-in, use **Device code** for Codex. Codex's **In browser** mode needs a browser on the daemon computer because its callback uses localhost. Claude's manual authorization-code flow can be completed from another device.

## Update

Finish or cancel active sign-ins first: reloading the plugin stops its background sign-in processes.

For a **local checkout**, update it, then run:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
paseo plugin reload account-switcher --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

For a **plugin directory, npm, or Git installation**, run `paseo plugin update`. Paseo shows the new revision and asks for approval; a Git update also runs the manifest's preparation steps:

```sh
paseo plugin update account-switcher --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

Use your installation's host throughout. A daemon restart is unnecessary. A failed source reload needs a source fix and another reload; inspect the plugin status and logs instead of assuming the old bundle remains active.

## Disable or remove

1. In **Accounts**, select **Disable** to restore the original provider commands.
2. Disable the plugin on the same daemon:

   ```sh
   paseo plugin disable account-switcher --host 127.0.0.1:6767
   ```

3. If you also want to remove its installation, run:

   ```sh
   paseo plugin remove account-switcher --host 127.0.0.1:6767
   ```

Integration restoration preserves other provider settings. If no explicit command existed originally, it restores the discovered official CLI's absolute path. Provider commands changed by something else are not overwritten during restoration.

Disabling integration leaves running chats alone; their next reload uses the system CLI. The switcher can show **Account not confirmed** until a subsequent startup is confirmed.

Removal leaves a local checkout in place but deletes Paseo's managed copy of a plugin directory, npm, or Git installation. In every case, Account Switcher's separate data directory remains. To delete a managed profile and its credentials, remove the account in Accounts **before** removing the plugin. Shared provider history is retained. See [stored data](architecture.md#stored-data) for the paths and deletion boundary.

To resume after disabling, enable the plugin, confirm it is running, then select **Enable** in Accounts:

```sh
paseo plugin enable account-switcher --host 127.0.0.1:6767
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Accounts is missing | Confirm the selected host, Paseo 0.11.x through 0.14.x (including beta releases after 0.11.0) on the app and daemon, the global plugin switch, and `running` status. |
| Provider CLI not found | Neither CLI was found. Check the installations and the daemon user's PATH or configured provider commands. A terminal shell's PATH can differ from a background daemon's. |
| A provider says its CLI was not found | That provider is skipped; the other keeps working. Install its CLI or configure its command, reload the plugin, then select **Enable** in its section. |
| Authentication override error | Check provider settings, CLI arguments, and the daemon environment for API keys, custom endpoints, or alternate providers. Use subscription authentication for this plugin. Do not paste secret values into a report. |
| Provider commands changed | Something else replaced a launcher. Review that configuration change, then explicitly select **Enable** again if you want Account Switcher to own provider launches. |
| Sign-in link does not open | In the desktop app, use **Copy link** and your usual browser. Elsewhere, use **Open browser** or **Copy link**. **Show sign-in link** provides selectable text when clipboard access fails. |
| Codex browser sign-in stalls remotely | Cancel and choose **Device code**, or finish **In browser** sign-in on the daemon computer. |
| Device sign-in is unavailable | Check the provider's device-code sign-in setting and CLI support, or use **In browser** sign-in on the daemon computer. |
| Sign-in status temporarily fails | The dialog retries status automatically. Use **Retry status** to retry immediately. If a stopped or interrupted attempt remains reserved, use **Cancel sign-in** before starting again. |
| Apply is disabled | Wait for the response and any permission request to finish; verify the selected account is signed in and has no active sign-in. |
| Account not confirmed | Select the intended account and apply it again while idle. Check the native agent status if reload still fails. |
| Limits are stale or unavailable | Read the account error, freshness, and retry time. **Refresh** respects backoff; expired authentication needs sign-in. Unreported values are not inferred. |
| Remove is blocked | Clear the account's default and pending selections, and switch all bound agents away. Archived agents also retain bindings. |

For loading failures:

```sh
paseo plugin ls account-switcher --host 127.0.0.1:6767
paseo plugin logs account-switcher --host 127.0.0.1:6767
```

One recovery case needs manual diagnosis: a new agent that fails before registering in Paseo can leave an unconfirmed account reservation. The plugin does not release a potentially occupied profile merely because time has passed. Bindings for normally deleted agents are removed only after checking the complete agent list; archived bindings remain for resume.

When reporting a problem, include versions, sanitized errors, and reproduction steps. Remove account identities, authorization links, one-time codes, tokens, and local paths you do not want to publish.
