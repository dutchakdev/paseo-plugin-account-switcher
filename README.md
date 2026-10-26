<img src="assets/icon.png" width="88" align="right" alt="">

# Account Switcher for Paseo

[![CI](https://github.com/dutchakdev/paseo-plugin-account-switcher/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dutchakdev/paseo-plugin-account-switcher/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/paseo-plugin-account-switcher)](https://www.npmjs.com/package/paseo-plugin-account-switcher)

Use several Claude and ChatGPT/Codex subscription accounts in Paseo. Choose an account for each agent, switch the account of an existing chat, and see the limits of every saved account.

Listed in the [Paseo plugin directory](https://paseo.sh/plugins/dutchakdev/account-switcher) and on [paseo.cafe](https://paseo.cafe/plugins/account-switcher/).

![Accounts in Paseo: two Claude accounts with their 5-hour and weekly limits and the start of a Codex account. Personal details are redacted.](docs/assets/accounts.png)

- **Sign in from Paseo.** Add an account, finish the official provider sign-in, and return to your chat.
- **Switch per agent.** The account chip opens a dialog on desktop or a bottom sheet on mobile. Changes apply only when you choose **Apply**.
- **Keep your setup.** Profiles separate credentials while sharing provider settings, skills, and session history.
- **Track account limits.** See used and remaining percentages, reset times, and freshness for every reported window.
- **Use a default.** Choose the account used by new agents for each provider.

## Requirements

- **Paseo 0.11.x through 0.13.x**, including beta releases after 0.11.0, on a **macOS or Linux** daemon and on the connected client.
- **Node.js 22.12.0 or newer**, with npm.
- The official **Paseo** CLI and at least one of **Claude Code** or **Codex** available to the daemon. A provider whose CLI is missing is skipped; after installing it, reload the plugin and select **Enable** in its section.
- Claude or ChatGPT subscription authentication. API keys and custom authentication/provider overrides are unsupported.

The interface is in English. Reset dates use the viewing device's local time zone. See [installation](docs/installation.md) for remote hosts and [verification](docs/verification.md) for the scope of recorded testing.

## Install

Paseo plugins are trusted, unsandboxed code with the daemon user's access to files, processes, credentials, and network. Account Switcher reads your Claude and Codex sign-ins to identify accounts and check their limits, and it sends no model messages. The commands below target the local daemon; for another host, see [remote daemons](docs/installation.md#remote-daemons).

On Paseo 0.11.0 or a later release, including 0.12 and 0.13, install the reviewed version from the plugin directory:

```sh
paseo plugin add dutchakdev/account-switcher
```

npm gets a new version before the directory approves it:

```sh
paseo plugin install npm:paseo-plugin-account-switcher
```

Paseo 0.8 to 0.10 and the 0.11.0 betas refuse the manifest's `icon` field. They can stay on 0.5.0, the last release for them, installed from GitHub. Paseo then runs the manifest's dependency and build steps on the daemon:

```sh
paseo plugin install dutchakdev/paseo-plugin-account-switcher --ref v0.5.0
```

To review or change the source first, install a [local checkout](docs/installation.md#install-a-local-checkout).

## First run

1. In Paseo, turn on **Settings → Plugins → Enable plugins**.
2. Check that `paseo plugin ls account-switcher` shows **running**, then open **Accounts** in the sidebar or **Accounts and limits** in the Command Center.
3. Accounts lists the sign-ins your daemon already uses as **Current CLI · Claude** and **Current CLI · Codex**. A provider without its CLI has no Current CLI entry.
4. Select **Enable** in Accounts. This is separate from Paseo's plugin switch: the plugin saves your original Claude and Codex commands and points Paseo at its launchers. It leaves running chats alone, and **Disable** restores the original commands.

## Add an account

Select **Add**, choose a provider, name the account, and select **Add and sign in**. The official CLI runs in the background; the plugin opens a sign-in dialog without creating a terminal or workspace.

| Where you use Paseo | How to open sign-in |
| --- | --- |
| Desktop app | The dialog tries to copy the link. Paste it into your usual browser; **Copy link** retries copying. |
| Web or native mobile client | The dialog tries to open the browser. **Open browser** and **Copy link** remain available. |

If clipboard access is unavailable, expand **Show sign-in link** and copy its selectable text.

- **Claude:** finish on the provider's page. If it gives you an authorization code, paste the **complete code, including the part after `#`**, into **Authorization code** and select **Finish sign-in**.
- **Codex, Device code:** enter the displayed code on the provider's page. Use it from a phone or another computer.
- **Codex, In browser:** finish in a browser on the **daemon's computer**, because the callback uses localhost. From another device, cancel and choose **Device code**.

After sign-in, the plugin verifies the account and refreshes its limits. To check again, use **Check sign-in** in the account's **⋯** menu. Enter passwords only on the provider's official page.

Closing the dialog leaves **Continue sign-in** on the account. **Cancel sign-in** stops the process before releasing the profile. While sign-in is active, the account cannot be applied, made the default, or deleted. A failed start leaves the account available for **Retry sign-in** without creating a duplicate. Plugin reloads stop pending sign-ins; start again afterward.

### Manage accounts

The **⋯** menu contains refresh, check sign-in, default, sign-in, rename, and remove actions. Account rows show identity, default status, and counts of current and pending agents.

Before signing in again, switch agents away from that profile. To remove a managed account, clear its default and all current or pending selections first. Removal asks for confirmation. **Archived agents retain their account binding for resume**; restore and switch them before removing the account. **Current CLI** accounts cannot be removed.

## Switch an existing chat

1. Select the account chip beside the message field to open **Account** over the current chat.
2. Under **Switch to**, choose a verified account from the **same provider**. The existing account stays marked **current**; the selected account is **pending**.
3. When the agent is idle and has no pending permission request, select **Apply “name”**.

<img src="docs/assets/account-dialog.png" width="420" alt="The Account dialog for a Claude agent: limits of its current account and the accounts it can switch to.">

You can select an account during a response, but it is **never applied automatically**. **Cancel selection** clears it. **All accounts** opens the full account list.

Apply reloads the agent through Paseo while preserving its native session ID. The plugin confirms the new account only after startup confirmation and successful reload. If a switch fails, it attempts to restore the previous account. **Account not confirmed** means the running account could not be established; select an account and apply again.

Plans differ in the models they offer. A free ChatGPT plan, for example, refuses a model that only paid plans have, and the agent's next message fails with `model_not_found`. For Codex, the plugin reads each account's models with its limits; when the selected account's plan does not offer the agent's model, the dialog says so before **Apply** and lists the models it does offer. Claude does not report its models this way, so the dialog shows no such warning for Claude.

Different agents can use different accounts in parallel. Avoid sending from another client during Apply: Paseo's native reload has no atomic lock against a concurrent message, which could be interrupted.

## Read limits

Each account shows all reported limit windows, including zero usage. Measured windows show used and remaining percentages and a reset countdown. Codex usage-based workspace plans show their monthly credit allowance as a limit, with the credits left; Claude enterprise seats show their monthly spend allowance the same way. Expand details for exact local reset times, durations, fetch/check timestamps, and windows without data.

- Checks run every **5 minutes** in the background and every **minute** while Accounts or the switcher is open.
- **Refresh** requests new data for one account; the header refresh action covers all accounts. Provider retry delays still apply.
- Color thresholds are **80%**, **95%**, and **100%** used. Missing data stays **No data**, never an invented zero.
- Failed requests can retain the last confirmed values as **stale**. Required sign-in, errors, and freshness remain visible.
- A passed reset time triggers a new check; it does not imply that usage is already zero.

Monitoring sends no model messages. The official CLIs own authentication and token refresh; a native Codex limits request may refresh its token. A Claude access token expires when no Claude session uses the account for several hours. Before a limits check finds it expired, the plugin runs `claude -p /usage --no-session-persistence` under that account, at most every 10 minutes. This local command lets the CLI renew the token, with no model message and no saved session. **Sign in again** appears only when the CLI cannot renew it. See [monitor details](server/usage/README.md) for scheduling, identity verification, and cache behavior.

## Update or remove

Plugin directory, npm, and Git installations update with `paseo plugin update account-switcher`, which shows the new revision and asks for approval.

Before disabling or removing the plugin, select **Disable** in Accounts to restore the original provider commands. Removal does not delete the separately stored account data. See [update and removal](docs/installation.md#update) for a local checkout, the full steps, and recovery.

## Scope

This project supports manual, same-provider switching with subscription accounts. Automatic account rotation, API-key authentication, and Claude-to-Codex transfers are outside its scope. Provider authentication and limit formats can change with CLI versions; unsupported data is shown as unavailable.

Automated tests cover the implementation with synthetic accounts and provider responses. They do not establish real A → B → A switching, compaction, child-session behavior, or rewind for your accounts. Recorded checks and remaining live verification are in [verification](docs/verification.md).

## Documentation and contributions

- [Installation, updates, and troubleshooting](docs/installation.md)
- [Architecture, profile isolation, and stored data](docs/architecture.md)
- [Contributing and running checks](CONTRIBUTING.md)
- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)

Licensed under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies.
