import { lstat, mkdir, readFile, realpath, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import TOML from "@iarna/toml";
import type { Provider } from "../shared/contracts";
import { atomicWrite, isMissing } from "./files";

const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_PROFILE", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_API_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION"];
AUTH_ENV.push("CLAUDE_CODE_OAUTH_REFRESH_TOKEN","CLAUDE_CODE_OAUTH_SCOPES","CLAUDE_CODE_OAUTH_CLIENT_ID","CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR","CLAUDE_CODE_HOST_CREDS_FILE","ANTHROPIC_CUSTOM_HEADERS");
AUTH_ENV.push("CLAUDE_BG_AUTH_SNAPSHOT_PATH","GATEWAY_TOKEN_FILE_DESCRIPTOR","WEBSOCKET_AUTH_FILE_DESCRIPTOR","SESSION_INGRESS_TOKEN_FILE","ANTHROPIC_UNIX_SOCKET","CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST","CLAUDE_CODE_HOST_AUTH_ENV_VAR");

export function assertSubscriptionEnvironment(provider: Provider, environment: Record<string, unknown>): void {
  const conflicting = AUTH_ENV.some(key => {
    // Claude's supported credential namespace is handled separately by discovery.
    if (key === "CLAUDE_SECURESTORAGE_CONFIG_DIR") return false;
    const codexKey = key.startsWith("OPENAI_") || key.startsWith("CODEX_");
    if ((provider === "codex") !== codexKey) return false;
    const value = environment[key];
    if (value === undefined || value === null || value === "") return false;
    if (key.startsWith("CLAUDE_CODE_USE_") && /^(0|false)$/i.test(String(value))) return false;
    return true;
  });
  if (conflicting) throw new Error(`${provider === "claude" ? "Claude" : "Codex"} authentication overrides in environment variables are incompatible with subscription accounts. Remove them from the provider settings and daemon environment.`);
}
const AUTH_CONFIG_KEYS = /(^|\.)(model_provider|model_providers|chatgpt_base_url|forced_login_method|forced_chatgpt_workspace_id|cli_auth_credentials_store|sqlite_home|codex_home)(\.|$)/;
function assertClaudeSettings(settings: Record<string, unknown>) {
  if (settings.apiKeyHelper || Object.keys(settings.env ?? {}).some(key => [...AUTH_ENV,"CLAUDE_CONFIG_DIR","CODEX_HOME"].includes(key))) throw new Error("Claude settings contain authentication overrides.");
}
function assertCodexSettings(config: Record<string, unknown>) {
  if (config.model_provider && config.model_provider !== "openai" || config.chatgpt_base_url || config.forced_chatgpt_workspace_id || config.forced_login_method && config.forced_login_method !== "chatgpt") throw new Error("Codex settings override the provider or authentication.");
  const openai = (config.model_providers as Record<string,Record<string,unknown>>|undefined)?.openai;
  if (openai && ["base_url","env_key","experimental_bearer_token","http_headers","env_http_headers"].some(key=>openai[key]) || openai?.requires_openai_auth === false) throw new Error("Codex settings override OpenAI authentication.");
  for (const profile of Object.values(config.profiles ?? {})) if (profile && typeof profile === "object") assertCodexSettings(profile as Record<string,unknown>);
}

export async function assertManagedCommand(provider:Provider,args:string[]):Promise<void> {
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(provider==="codex") {
      const value=arg==="-c"||arg==="--config"?args[++i]:arg.startsWith("--config=")?arg.slice(9):arg.startsWith("-c")&&arg.length>2?arg.slice(2):null;
      if(value && AUTH_CONFIG_KEYS.test(value.split("=")[0].trim().replaceAll('"',''))) throw new Error("CLI arguments override account isolation.");
      if(arg==="--oss"||arg==="--local-provider"||arg.startsWith("--local-provider=")) throw new Error("This profile only supports a ChatGPT subscription.");
    } else if(arg==="--settings"||arg.startsWith("--settings=")) {
      const value=arg==="--settings"?args[++i]:arg.slice(11);
      if(!value)throw new Error("Claude settings are empty.");
      const text=value.trim().startsWith("{")?value:await readFile(value,"utf8");
      assertClaudeSettings(JSON.parse(text));
    }
  }
}

export function buildAccountEnv(provider: Provider, home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of AUTH_ENV) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"]) delete env[key];
  if (provider === "claude") env.CLAUDE_CONFIG_DIR = home;
  else env.CODEX_HOME = home;
  return env;
}

async function linkDirectory(home: string, sourceHome: string, name: string, create: boolean): Promise<void> {
  const source = join(sourceHome, name), target = join(home, name);
  if (create) await mkdir(source, { recursive: true, mode: 0o700 });
  try { await lstat(source); } catch (error) { if (isMissing(error)) return; throw error; }
  try {
    if (await realpath(target) !== await realpath(source)) throw new Error(`Profile directory conflict: ${name}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await symlink(source, target);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function writeChanged(path: string, text: string): Promise<void> {
  if (await readOptional(path) !== text) await atomicWrite(path, text);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function prepareProfile({ provider, home, sourceHome, sourceEnvironment=process.env }: { provider: Provider; home: string; sourceHome: string;sourceEnvironment?:NodeJS.ProcessEnv }): Promise<void> {
  if (resolve(home) === resolve(sourceHome)) return;
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (provider === "codex") {
    for (const name of ["sessions", "archived_sessions", "thread-writer-locks", ".tmp"]) await linkDirectory(home, sourceHome, name, true);
    for (const name of ["skills", "rules", "memories", "plugins", "vendor_imports"]) await linkDirectory(home, sourceHome, name, false);
    const text = await readOptional(join(sourceHome, "config.toml"));
    const config = text === null ? {} : TOML.parse(text);
    assertCodexSettings(config);
    config.cli_auth_credentials_store = "file";
    config.sqlite_home = typeof config.sqlite_home === "string" ? resolve(sourceHome,config.sqlite_home) : sourceHome;
    await writeChanged(join(home, "config.toml"), TOML.stringify(config));
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      const text = await readOptional(join(sourceHome, name));
      if (text !== null) await writeChanged(join(home, name), text); else await rm(join(home,name),{force:true});
    }
  } else {
    for (const name of ["projects", "file-history"]) await linkDirectory(home, sourceHome, name, true);
    for (const name of ["skills", "commands", "agents", "plugins", "rules", "CLAUDE.md"]) await linkDirectory(home, sourceHome, name, false);
    const text = await readOptional(join(sourceHome, "settings.json"));
    if (text !== null) {
      const settings = JSON.parse(text);
      assertClaudeSettings(settings);
      await writeChanged(join(home, "settings.json"), JSON.stringify(settings, null, 2));
    } else await rm(join(home,"settings.json"),{force:true});
    // Claude keeps account metadata in this file too. Copy only user settings,
    // never oauthAccount or other login fields, and avoid writes when unchanged.
    const sourceConfig = (await readOptional(join(sourceHome,".config.json")))
      ?? (await readOptional(join(sourceHome === join(homedir(),".claude") && !sourceEnvironment.CLAUDE_CONFIG_DIR ? homedir() : sourceHome,".claude.json")));
    if (sourceConfig !== null) {
      const shared = JSON.parse(sourceConfig);
      const legacy = await readOptional(join(home,".config.json"));
      const target = join(home, legacy === null ? ".claude.json" : ".config.json");
      const before = legacy ?? await readOptional(target);
      const own = before === null ? {} : JSON.parse(before);
      const original = JSON.stringify(own);
      for (const key of ["mcpServers","hasCompletedOnboarding","theme","preferredNotifChannel","verbose","editorMode"]) {
        if (Object.hasOwn(shared,key)) own[key]=shared[key];
        else delete own[key];
      }
      // Project records contain trust decisions, session history and usage for
      // this profile. Inherit ordinary MCP configuration only; local values win.
      if (record(shared.projects)) {
        const projects = record(own.projects) ? own.projects : {};
        own.projects = Object.fromEntries([...new Set([...Object.keys(shared.projects), ...Object.keys(projects)])].map(path => {
          const sharedProject = shared.projects[path];
          const settings = record(sharedProject) ? Object.fromEntries(["mcpServers", "mcpContextUris"].filter(key => Object.hasOwn(sharedProject, key)).map(key => [key, sharedProject[key]])) : {};
          return [path, { ...settings, ...(record(projects[path]) ? projects[path] : {}) }];
        }));
      }
      if (JSON.stringify(own)!==original) await atomicWrite(target,JSON.stringify(own,null,2));
    }
  }
}
