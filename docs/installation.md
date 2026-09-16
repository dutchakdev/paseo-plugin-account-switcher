# Installation and maintenance

[Back to the README](../README.md)

## Before installing

Account Switcher runs on the machine hosting your Paseo daemon. Its UI appears in connected Paseo clients; credentials and provider processes stay on the daemon.

Use a macOS or Linux daemon, Paseo 0.8.x on both daemon and client, and Node.js **22.12.0 or newer**. Install the official `claude`, `codex`, and `paseo` CLIs for the daemon's operating-system user. Both provider CLIs must be discoverable through the daemon's PATH or their configured Paseo provider commands.

Existing CLI subscription sign-ins appear as **Current CLI** accounts. You can add isolated accounts through Paseo after installation. API keys, alternate API providers, and conflicting authentication or endpoint overrides are unsupported; the plugin reports them instead of assuming which account they represent.

Enable **Settings → Plugins → Enable plugins** on the target host. Paseo plugins are trusted, unsandboxed code. Installing this plugin and its dependencies grants them the daemon user's access, including files, processes, credentials, and network services.

## Install a local checkout

Place the repository on the daemon machine. From that checkout:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run typecheck
npm test
paseo plugin install "$PWD" --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

The build generates the native-provider launcher; it must run before typechecking or testing a fresh checkout. Paseo compiles the plugin's client and server entries when loading it.

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

For remote sign-in, use **Device code** for Codex. Codex's **Browser** mode needs a browser on the daemon computer because its callback uses localhost. Claude's manual authorization-code flow can be completed from another device.

## Git installations

Paseo also accepts a Git source through `paseo plugin add`. Supply the actual repository source you intend to trust. The manifest declares the required preparation steps:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
```

Paseo runs these on the daemon host before activating a Git installation or update. A preparation failure leaves the installed version intact. Branch sources track updates; tags and commits remain pinned. See the [Paseo CLI reference](https://paseo.sh/docs/plugins/v0.8/reference#cli-reference) for source and revision syntax.

## Update

Finish or cancel active sign-ins first: reloading the plugin stops its background sign-in processes.

For a **directory installation**, update the existing checkout, then run:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run typecheck
npm test
paseo plugin reload account-switcher --host 127.0.0.1:6767
paseo plugin ls account-switcher --host 127.0.0.1:6767
```

For a **Git installation**, ask Paseo to fetch and prepare the configured source:

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

Removal preserves a directory source, but removes Paseo's managed checkout for a Git source. In either case, Account Switcher's separate data directory remains. To remove a managed profile and its credentials, delete it through Accounts **before** removing the plugin. Shared provider history is retained. See [stored data](architecture.md#stored-data) for the paths and deletion boundary.

To resume after disabling, enable the plugin, confirm it is running, then select **Enable** in Accounts:

```sh
paseo plugin enable account-switcher --host 127.0.0.1:6767
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Accounts is missing | Confirm the selected host, Paseo 0.8.x on the app and daemon, the global plugin switch, and `running` status. |
| Provider CLI not found | Check both CLI installations and the daemon user's PATH or configured provider commands. A terminal shell's PATH can differ from a background daemon's. |
| Authentication override error | Check provider settings, CLI arguments, and the daemon environment for API keys, custom endpoints, or alternate providers. Use subscription authentication for this plugin. Do not paste secret values into a report. |
| Provider commands changed | Something else replaced a launcher. Review that configuration change, then explicitly select **Enable** again if you want Account Switcher to own provider launches. |
| Sign-in link does not open | In the desktop app, use **Copy link** and your usual browser. Elsewhere, use **Open browser** or **Copy link**. **Show sign-in link** provides selectable text when clipboard access fails. |
| Codex browser sign-in stalls remotely | Cancel and choose **Device code**, or finish Browser sign-in on the daemon computer. |
| Device sign-in is unavailable | Check the provider's device-code sign-in setting and CLI support, or use Browser sign-in on the daemon computer. |
| Sign-in status temporarily fails | The dialog retries status automatically. Use **Retry status** to retry immediately. If a stopped or interrupted attempt remains reserved, use **Cancel sign-in** before starting again. |
| Apply is disabled | Wait for the response and any permission request to finish; verify the selected account is signed in and has no active sign-in. |
| Account not confirmed | Select the intended account and apply it again while idle. Check the native agent status if reload still fails. |
| Limits are stale or unavailable | Read the account error, freshness, and retry time. **Refresh** respects backoff; expired authentication needs sign-in. Unreported values are not inferred. |
| Delete is blocked | Clear the account's default and pending selections, and switch all bound agents away. Archived agents also retain bindings. |

For loading failures:

```sh
paseo plugin ls account-switcher --host 127.0.0.1:6767
paseo plugin logs account-switcher --host 127.0.0.1:6767
```

One recovery case needs manual diagnosis: a new agent that fails before registering in Paseo can leave an unconfirmed account reservation. The plugin does not release a potentially occupied profile merely because time has passed. Bindings for normally deleted agents are removed only after checking the complete agent list; archived bindings remain for resume.

When reporting a problem, include versions, sanitized errors, and reproduction steps. Remove account identities, authorization links, one-time codes, tokens, and local paths you do not want to publish.
