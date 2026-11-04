import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { PaseoApi } from "./paseo-api";
import type { Provider } from "../shared/contracts";
import type { AccountStore, Registry } from "./store";
import { atomicWrite } from "./files";
import { LAUNCHER_SOURCE } from "./launcher-artifact";
import { assertSubscriptionEnvironment } from "./profiles";
import { CURSOR_MAC_PRELOAD } from "./cursor-macos";

const providers = ["claude", "codex", "cursor"] as const;
const COMMAND_DRIFT = "Provider commands changed outside the plugin. Enable integration again to apply accounts.";
export const NO_PROVIDER_CLI = "Provider CLI not found. Install Claude Code, Codex, or Cursor, or configure its command in Paseo.";
export const launcherPath = (root: string, provider: Provider): string => join(root, "bin", `${provider}-launcher`);
export async function writeLaunchers(store: AccountStore): Promise<void> {
  for (const provider of providers) await atomicWrite(launcherPath(store.root, provider), LAUNCHER_SOURCE, 0o700);
  if (process.platform === "darwin") await atomicWrite(join(store.root, "bin", "cursor-macos-preload.cjs"), CURSOR_MAC_PRELOAD);
}

function commandArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === "string") || !value[0]) throw new Error("The CLI command must be a nonempty array of arguments.");
  return [...value];
}
function owned(command: string[] | null, wrapper: string): boolean { return command?.length === 1 && command[0] === wrapper; }
function sameProviders(left: readonly Provider[], right: readonly Provider[]): boolean { return left.length === right.length && left.every(provider => right.includes(provider)); }
/** Resolves a provider command to an executable path, or null when no executable exists. */
async function resolveCommand(command: string[], wrappers: string[]): Promise<string[] | null> {
  if (command.some(part => wrappers.includes(part))) throw new Error("A recursive launcher command was detected. Restore the original CLI.");
  const candidates = isAbsolute(command[0]) || command[0].includes("/") ? [resolve(command[0])] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, command[0]));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if (wrappers.includes(candidate) || wrappers.includes(resolved)) throw new Error("recursion");
      return [candidate, ...command.slice(1)];
    } catch (error) { if ((error as Error).message === "recursion") throw new Error("A recursive launcher command was detected. Restore the original CLI."); }
  }
  return null;
}

export async function prepareRuntime(paseo: PaseoApi, store: AccountStore): Promise<void> {
  await discoverCommands(paseo, store);
}

function disableIntegration(state: Registry, error: string): void {
  state.integration = { ...state.integration, enabled: false, error };
  for (const binding of state.bindings) {
    const awaitingReceipt = binding.launchToken !== null && binding.currentAccountId === null;
    binding.launchToken = null;
    if (binding.status === "switching" || awaitingReceipt) {
      binding.currentAccountId = null; binding.status = "error"; binding.error = error;
    }
  }
}

export async function reconcileIntegration(paseo: PaseoApi, store: AccountStore): Promise<void> {
  const registry = await store.read();
  let ownership: Provider[];
  try {
    const { config } = await paseo.config.get();
    for (const provider of providers) {
      // A provider without a CLI never launches, so its settings cannot affect the other.
      if (!registry.available[provider]) continue;
      assertSubscriptionEnvironment(provider, process.env);
      const environment = config.providers[provider]?.env;
      assertSubscriptionEnvironment(provider, environment && typeof environment === "object" ? environment as Record<string, unknown> : {});
    }
    ownership = providers.filter(provider => owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider)));
  } catch {
    const message = "Could not verify Paseo provider commands. Check the configuration and authentication overrides, then enable integration again.";
    await store.change(state => { disableIntegration(state, message); });
    throw new Error(message);
  }
  // Restoring the wrapper paths alone cannot authorize old launch receipts.
  // Only explicit installIntegration enables a disabled registry again.
  if (ownership.length && sameProviders(ownership, registry.integration.providers)) return;
  await store.change(state => {
    if (state.integration.enabled || ownership.length || state.bindings.some(binding => binding.launchToken !== null)) disableIntegration(state, COMMAND_DRIFT);
  });
}

async function discoverCommands(paseo: PaseoApi, store: AccountStore) {
  try { return await discoverRuntime(paseo, store); }
  catch (error) {
    await store.change(state => { disableIntegration(state, "Could not verify provider commands or authentication. Check the integration settings."); });
    throw error;
  }
}

async function discoverRuntime(paseo: PaseoApi, store: AccountStore) {
  const { config } = await paseo.config.get(); const registry = await store.read();
  const wrappers = providers.map(provider => launcherPath(store.root, provider));
  const commands = { ...registry.commands }, originals = { ...registry.originalCommands }, sourceHomes = { ...registry.sourceHomes };
  const sourceEnvironment: typeof registry.sourceEnvironment = { claude: {}, codex: {}, cursor: {} };
  const available = { claude: false, codex: false, cursor: false };
  const ownership: Provider[] = [];
  for (const provider of providers) {
    if (provider === "cursor" && ((process.platform !== "linux" && process.platform !== "darwin") || !config.providers.cursor || config.providers.cursor.enabled === false)) continue;
    const current = commandArray(config.providers[provider]?.command);
    if (owned(current, launcherPath(store.root, provider))) {
      ownership.push(provider);
      if (!commands[provider]) throw new Error("The launcher is active without the original CLI command; restore the configuration manually.");
      // Keep the recorded command when its CLI is gone: restoration still needs it.
      const resolved = await resolveCommand(commands[provider]!, wrappers);
      if (resolved) commands[provider] = resolved;
      available[provider] = resolved !== null;
    } else {
      originals[provider] = current;
      commands[provider] = await resolveCommand(current ?? (provider === "cursor" ? ["cursor-agent", "acp"] : [provider]), wrappers);
      available[provider] = commands[provider] !== null;
    }
    if (!available[provider]) { Object.assign(sourceEnvironment[provider], registry.sourceEnvironment[provider]); continue; }
    const environment = config.providers[provider]?.env;
    const configured = environment && typeof environment === "object" ? environment as Record<string, unknown> : {};
    assertSubscriptionEnvironment(provider, process.env);
    assertSubscriptionEnvironment(provider, configured);
    const keys = provider === "claude" ? ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const : provider === "cursor" ? ["XDG_CONFIG_HOME", "CURSOR_CONFIG_DIR"] as const : ["CODEX_HOME"] as const;
    for (const key of keys) {
      const value = configured[key] ?? process.env[key];
      // An explicitly empty override selects the default credential namespace.
      if(key==="CLAUDE_SECURESTORAGE_CONFIG_DIR"&&value===""){
        sourceEnvironment.claude.CLAUDE_SECURESTORAGE_CONFIG_DIR="";
        continue;
      }
      if (typeof value === "string" && value) {
        if (!isAbsolute(value)) throw new Error("The provider profile path must be absolute.");
        (sourceEnvironment[provider] as Record<string, string>)[key] = value;
      }
    }
    // Pin one shared session/settings home for probes, logins and every account launch.
    if (provider === "cursor") sourceEnvironment.cursor.CURSOR_CONFIG_DIR ||= join(homedir(),".cursor");
    if (provider === "cursor") {
      const store = configured.AGENT_CLI_CREDENTIAL_STORE ?? process.env.AGENT_CLI_CREDENTIAL_STORE;
      if (typeof store === "string") sourceEnvironment.cursor.AGENT_CLI_CREDENTIAL_STORE = store;
    }
    const value = provider === "claude" ? sourceEnvironment.claude.CLAUDE_CONFIG_DIR : provider === "cursor" ? sourceEnvironment.cursor.XDG_CONFIG_HOME : sourceEnvironment.codex.CODEX_HOME;
    sourceHomes[provider] = provider === "cursor" && process.platform === "darwin" ? homedir() : typeof value === "string" && isAbsolute(value) ? resolve(value) : join(homedir(), provider === "claude" ? ".claude" : provider === "cursor" ? ".config" : ".codex");
  }
  if (!available.claude && !available.codex && !available.cursor) throw new Error(NO_PROVIDER_CLI);
  await writeLaunchers(store);
  // The wrapper must see its originals before the daemon can run provider discovery.
  await store.change(state => {
    state.commands = commands; state.originalCommands = originals; state.sourceHomes = sourceHomes; state.sourceEnvironment = sourceEnvironment; state.available = available;
    if (!sameProviders(ownership, state.integration.providers) && (ownership.length || state.integration.enabled || state.bindings.some(binding => binding.launchToken !== null))) disableIntegration(state, COMMAND_DRIFT);
    for (const account of state.accounts) if (account.source === "system") account.home = sourceHomes[account.provider];
  });
  return config;
}

export async function installIntegration(paseo: PaseoApi, store: AccountStore): Promise<void> {
  const config = await discoverCommands(paseo, store), { available } = await store.read();
  // A provider without a CLI keeps its Paseo command. One whose launcher is already installed stays owned.
  const integrated = providers.filter(provider => available[provider] || owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider)));
  try {
    await paseo.config.patch({ providers: Object.fromEntries(integrated.map(provider => [provider, { ...config.providers[provider], command: [launcherPath(store.root, provider)] }])) });
    await store.change(state => { state.integration = { enabled: true, error: null, providers: integrated }; });
  } catch { throw new Error("Paseo did not apply provider integration. Check the configuration and try again."); }
}

export async function restoreIntegration(paseo: PaseoApi, store: AccountStore): Promise<void> {
  const { config } = await paseo.config.get(), registry = await store.read();
  const patch: Record<string, Record<string, unknown>> = {};
  for (const provider of providers) {
    if (!owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider))) continue;
    const command = registry.originalCommands[provider] ?? registry.commands[provider];
    if (!command?.length) throw new Error("The original CLI command is missing; automatic restoration is unavailable.");
    patch[provider] = { ...config.providers[provider], command };
  }
  try {
    if (Object.keys(patch).length) await paseo.config.patch({ providers: patch });
    await store.change(state => { state.integration = { ...state.integration, enabled: false, error: null }; });
  } catch { throw new Error("Paseo did not restore the original provider commands. Try again."); }
}
