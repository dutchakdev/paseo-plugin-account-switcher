Account Switcher lets you use several Claude and ChatGPT/Codex subscription accounts in Paseo. You pick an account for each agent, switch the account of an existing chat, set a default per provider, and see each account's usage limits. Switching stays within one provider and is manual, unless you turn on automatic switching for when a limit runs out.

Limits cover every window the provider reports, such as 5-hour and weekly use, with reset times. Codex usage-based workspace plans show their monthly credits, and Claude enterprise seats show their monthly spend allowance.

## How it works

- Each account you add gets its own credential profile. Settings, skills, and session history stay shared with your existing CLI setup, so a profile is not a sandbox.
- Turn on **Account switching** in Accounts to point Paseo's Claude and Codex commands at the plugin's launchers, which start the official CLI under the agent's account. Turning it off restores the original commands; do this before removing the plugin.
- Open **Manage** to check sign-in, refresh limits, rename an added account, or make it the default. Each added account has a visible **Remove** button with confirmation and an explanation of any blockers. **Current CLI** entries use the host's own sign-in and cannot be removed here.
- A new agent starts on its provider's default account. When the latest readings show the default has used up an account-wide limit that resets later, Codex reports that ordinary usage is not allowed, its plan lacks the Codex model chosen for the agent, or the default needs sign-in, the agent starts on the signed-in account with the largest percentage left instead. Limits of a single model and extra paid usage do not count. With every account ruled out, it stays on the default. **Always use the default** under a provider in Accounts turns this off, so the default stays binding.
- A tool that creates agents can name the account to start on: an agent created with `PASEO_ACCOUNT_SWITCHER_ACCOUNT` in its environment, set to an account's name or ID, starts on that account whatever its limits. It is not created when that account cannot be used, or when **Always use the default** is on and that account is not the default.
- `/account name` in the message field switches the chat's account, or `/account default` its provider's default: at once when the agent is idle, otherwise in the switcher for **Apply**. The Command Center offers **Make “name” the default** for each signed-in account.
- A line in the chat records applied switches, and why a new agent did not start on the default. These lines are best effort and do not survive a daemon restart.
- Signed-in accounts also appear in Paseo's Usage view, and Paseo's usage popover for an agent on a managed account shows that account.
- Verified quota interruptions can switch accounts and continue the same session. Claude native structured errors (checked with CLI 2.1.321) and fresh exhausted-account readings must agree; ordinary completed turns do not trigger switching. Automatic mode refreshes candidate limits, chooses a distinct signed-in identity with known room, verifies the existing model/session after reload, and sends **Continue.** once. New activity, stop, permissions or changed context cancel pending recovery. Durable operation records prevent replay after reload; uncertain sends are not retried. Manual quota offers use the same checks. At most three quota-recovery attempts per hour, with no return to an identity left during that hour.
- The account chip in the composer opens the switcher for that chat. A chat changes account only through **Apply**, `/account name`, the switch button of the limit row, or automatic switching if you turn it on, and only while the agent is idle with no pending permission request; Paseo reloads the agent with its session intact. A switch refused before the reload changes nothing. For ordinary Apply, a failure after reload attempts to restore the previous account. Quota recovery canceled after reload leaves uncertainty visible for manual inspection, without an extra rollback reload.

## Setup

- Paseo 0.15.4 or newer on a macOS or Linux daemon, with Node.js 22.12 or newer.
- The official Paseo CLI and at least one of Claude Code or Codex on the daemon. A provider without its CLI shows as unavailable; after you install it, reload the plugin and select **Enable** in that provider's section.
- A Claude or ChatGPT subscription for each account. API keys are not supported. Adding an account runs the official CLI sign-in from Paseo.

## What it reads and sends

- It reads each account's stored sign-in: Codex's `auth.json`, and Claude's credentials from the macOS Keychain or the profile's `.credentials.json`. The Codex file identifies the ChatGPT account; the Claude access token authenticates the usage request, and the official CLI reports which Claude account is signed in. Tokens stay on the daemon. Paseo clients receive each account's email, plan, and limits.
- Claude limits come from a request to `api.anthropic.com` with the account's access token. When that token has expired, for example on an idle account, the plugin runs `claude -p /usage --no-session-persistence` under the account so the official CLI renews it, at most every 10 minutes. The command sends no model message and saves no session. Codex limits and the plan's model list come from the official `codex app-server`, which asks OpenAI and may refresh the account's token. Limit checks send no model messages.
- To list accounts in Paseo's Usage view, the plugin reports the limits it has already collected under the source name Account Switcher, without new provider requests. For an agent on a managed account, it adds that account's profile directory to the agent's session environment so Paseo's usage popover reads the right account.
- The only message the plugin sends to an agent is **Continue.**, after a switch made from the limit row, or by automatic switching after a verified quota interruption.
- Limits refresh every 5 minutes, and every minute while Accounts or the switcher is open. Missing values show as no data, and a failed refresh can keep the last values, marked stale. With **Check usage** off in the host's settings (Paseo 0.15 and newer), the plugin makes no limit requests and offers no switch when a limit runs out; Accounts says so.
- Removing a managed account deletes its profile and stored sign-in, including a Claude account's Keychain item on macOS. Shared session history stays.

## Limitations

- Apply reloads the agent through Paseo, which has no lock against a message sent from another client at the same moment. That message can be interrupted.
- Recovery needs current-turn evidence and fresh usage data. Unknown Claude JSONL formats, missing session/turn evidence or unavailable quota leave the agent idle for manual handling. Paseo 0.15.4 cannot atomically check idle/session and send across clients; final checks and non-interrupting delivery reduce but cannot eliminate that race.
- Paseo's Usage view can show one managed account twice: after you open the usage details of an agent on that account, Paseo's own Claude or Codex card for the login can appear next to the Account Switcher card. The plugin cannot merge cards of different sources.
- Plans differ in the models they offer: after a switch to a plan without the agent's model, its next message fails. For Codex, the switcher compares the agent's model with the models the account's plan offers and warns before **Apply**. Claude does not report its models, so there is no such check for Claude.
- Codex's **In browser** sign-in must finish on the daemon's computer. From another device, use **Device code**.
- Claude credentials in an inaccessible macOS Keychain show as **sign-in unavailable**. Unlock Keychain in the daemon's session, then check sign-in again. A daemon started from SSH may not share the desktop's access. If the official CLI cannot renew an expired token, sign in again.
- Providers can change their limit formats. Values the plugin cannot read show as no data.

## Other plugins by dutchakdev

- [Machine Status](https://paseo.sh/plugins/dutchakdev/machine-status): load, memory, disk, the ports and processes your agents started, and Docker on the daemon's Mac, with dev-cache cleanup and confirmed process stops.
- [Mermaid](https://paseo.sh/plugins/dutchakdev/mermaid): draws Mermaid flowcharts and sequence diagrams from chat messages and `.mmd` files, on desktop and mobile.
- [secure-input](https://paseo.sh/plugins/dutchakdev/secure-input): agents ask you for secrets through a form, and each value lands in a short-lived file the agent moves without reading it.
