import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Cursor's macOS file store currently uses these Node filesystem methods. Keep
// the redirect inside the CLI process, not in its shell or tool subprocesses.
export const CURSOR_MAC_PRELOAD = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const target = process.env.PASEO_CURSOR_AUTH_FILE;
if (!target) throw new Error('Missing Cursor credential profile');
const original = path.join(os.homedir(), '.cursor', 'auth.json');
const marker = process.env.PASEO_CURSOR_PRELOAD_MARKER;
const options = process.env.PASEO_CURSOR_ORIGINAL_NODE_OPTIONS;
delete process.env.PASEO_CURSOR_AUTH_FILE;
delete process.env.PASEO_CURSOR_PRELOAD_MARKER;
delete process.env.PASEO_CURSOR_ORIGINAL_NODE_OPTIONS;
if (options === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = options;
for (const name of ['readFile', 'writeFile', 'chmod', 'unlink']) {
  const method = fs.promises[name];
  fs.promises[name] = function(file, ...args) {
    return method.call(this, file === original ? target : file, ...args);
  };
}
if (marker) fs.writeFileSync(marker, String(process.pid), {mode: 0o600});
`;

export function cursorMacEnvironment(home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = dirname(dirname(dirname(home)));
  const preload = join(root, "bin", "cursor-macos-preload.cjs");
  const env: NodeJS.ProcessEnv = {
    AGENT_CLI_CREDENTIAL_STORE: "file",
    PASEO_CURSOR_AUTH_FILE: join(home, "cursor", "auth.json"),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
  };
  if (base.NODE_OPTIONS !== undefined) env.PASEO_CURSOR_ORIGINAL_NODE_OPTIONS = base.NODE_OPTIONS;
  return env;
}

// A configured wrapper must actually launch Node with the preload, rather than
// merely accepting NODE_OPTIONS. The marker must come from the main process.
export async function verifyCursorMacCommand(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-cursor-check-"));
  const marker = join(directory, "loaded");
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      const child = execFile(command[0], [...command.slice(1), "--version"], {
        env: { ...env, PASEO_CURSOR_PRELOAD_MARKER: marker }, timeout: 10_000, maxBuffer: 64 * 1024,
      }, error => error || !child.pid ? reject(new Error("Cursor preload check failed")) : resolve(child.pid));
    });
    if (await readFile(marker, "utf8") !== String(pid)) throw new Error("Cursor preload check failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function cursorMacMarker(): Promise<{path:string;cleanup:()=>Promise<void>}> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-cursor-launch-"));
  return {path:join(directory,"loaded"),cleanup:() => rm(directory,{recursive:true,force:true})};
}

export async function waitCursorMacMarker(path: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await readFile(path,"utf8") === String(pid)) return; } catch { /* The CLI has not loaded the preload yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Cursor preload was not loaded by the launched process");
}
