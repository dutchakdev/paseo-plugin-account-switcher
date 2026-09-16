import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { createLoginProcess, type LoginProcess } from "../server/login-process";

type Pids = { leader: number; supervisor: number; descendant?: number };
type Fixture = { root: string; cli: string; receipt: string; pids: string; env: NodeJS.ProcessEnv; login?: LoginProcess; owner?: ChildProcess; watchdog?: number };
const fixtures: Fixture[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function kill(pid: number) {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")); }
async function ready(fixture: Fixture): Promise<Pids> {
  return vi.waitFor(async () => {
    const pids = await readJson<Pids>(fixture.pids);
    expect(pids.descendant).toBeGreaterThan(0);
    return pids;
  }, { timeout: 5000, interval: 20 });
}
async function gone(pids: Pids) {
  await vi.waitFor(() => {
    expect(alive(pids.leader)).toBe(false);
    if (pids.descendant) expect(alive(pids.descendant)).toBe(false);
    expect(alive(pids.supervisor)).toBe(false);
  }, { timeout: 5000, interval: 20 });
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.owner?.pid && fixture.owner.exitCode === null && fixture.owner.signalCode === null) fixture.owner.kill("SIGKILL");
    await fixture.login?.stop().catch(() => {});
    if (fixture.watchdog && alive(fixture.watchdog)) kill(fixture.watchdog);
    const pids = await readJson<Pids>(fixture.pids).catch(() => undefined);
    if (pids) {
      if (process.platform !== "win32") kill(-pids.leader);
      for (const pid of [pids.descendant, pids.leader, pids.supervisor]) if (pid && alive(pid)) kill(pid);
      await gone(pids).catch(() => {});
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "account login process "));
  const value: Fixture = { root, cli: join(root, "fake cli.cjs"), receipt: join(root, "receipt.json"), pids: join(root, "pids.json"), env: { HOME: root, PATH: dirname(process.execPath) } };
  fixtures.push(value);
  await writeFile(value.cli, `
const fs=require('node:fs'),{spawn}=require('node:child_process');
const [mode,pidsPath]=process.argv.slice(2);
if(mode==='descendant'){
 process.on('SIGTERM',()=>{});
 process.send({ready:true,pid:process.pid});
 setInterval(()=>{},1000);
}else if(mode==='output'){
 process.stdout.write('fixture-sensitive-auth-url-and-code\\n');
 process.stderr.write('fixture-sensitive-token-and-error\\n');
}else{
 fs.writeFileSync(pidsPath,JSON.stringify({leader:process.pid,supervisor:process.ppid}));
 process.on('SIGTERM',()=>process.exit(0));
 const descendant=spawn(process.execPath,[__filename,'descendant'],{env:process.env,stdio:['ignore','ignore','ignore','ipc']});
 descendant.once('message',message=>{
  if(message.ready)fs.writeFileSync(pidsPath,JSON.stringify({leader:process.pid,supervisor:process.ppid,descendant:message.pid}));
 });
 setInterval(()=>{},1000);
}
`);
  return value;
}

describe("background login process supervisor", () => {
  it.skipIf(process.platform === "win32")("cancels the entire process group when a descendant ignores TERM", async () => {
    const value = await fixture();
    const exit = vi.fn();
    value.login = createLoginProcess({ command: [process.execPath, value.cli], args: ["group", value.pids], env: value.env, cwd: value.root,
      receiptPath: value.receipt, loginToken: "fixture-cancel-session", onData: () => {}, onExit: exit });
    await value.login.ready(); value.login.start();
    const pids = await ready(value);
    expect(alive(pids.leader)).toBe(true); expect(alive(pids.descendant!)).toBe(true);
    await value.login.stop();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1, true);
    await gone(pids);
    expect(await readJson(value.receipt)).toMatchObject({ loginToken: "fixture-cancel-session", exitCode: 1 });
  }, 15000);

  it.skipIf(process.platform === "win32")("cleans up and writes a matching receipt after its parent dies abruptly", async () => {
    const value = await fixture();
    // Load the same public API in a separate owner process, so SIGKILL exercises
    // real IPC disconnect rather than a simulated cancellation callback.
    const source = await readFile(new URL("../server/login-process.ts", import.meta.url), "utf8");
    const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const modulePath = join(value.root, "login-process.cjs");
    const ownerPath = join(value.root, "owner.cjs");
    await writeFile(modulePath, compiled);
    await writeFile(ownerPath, `
const {createLoginProcess}=require(${JSON.stringify(modulePath)});
const login=createLoginProcess({command:[process.execPath,${JSON.stringify(value.cli)}],args:['group',${JSON.stringify(value.pids)}],env:process.env,cwd:${JSON.stringify(value.root)},receiptPath:${JSON.stringify(value.receipt)},loginToken:'fixture-crash-session',onData(){},onExit(){}});
login.ready().then(()=>login.start());setInterval(()=>{},1000);
`);
    value.owner = spawn(process.execPath, [ownerPath], { cwd: value.root, env: value.env, stdio: "ignore" });
    const ownerClosed = new Promise<void>((resolve, reject) => { value.owner!.once("close", () => resolve()); value.owner!.once("error", reject); });
    const pids = await ready(value);
    value.owner.kill("SIGKILL");
    await ownerClosed;
    const receipt = await vi.waitFor(() => readJson(value.receipt), { timeout: 6000, interval: 20 });
    expect(receipt).toMatchObject({ loginToken: "fixture-crash-session", exitCode: 1 });
    await gone(pids);
  }, 15000);

  it("keeps native stdout and stderr out of its private completion receipt", async () => {
    const value = await fixture();
    const output: string[] = [];
    let finish!: (result: { code: number; receiptWritten: boolean }) => void;
    const exited = new Promise<{ code: number; receiptWritten: boolean }>(resolve => { finish = resolve; });
    value.login = createLoginProcess({ command: [process.execPath, value.cli], args: ["output"], env: value.env, cwd: value.root,
      receiptPath: value.receipt, loginToken: "fixture-output-session", onData: (_stream, data) => output.push(data), onExit: (code, receiptWritten) => finish({ code, receiptWritten }) });
    await value.login.ready(); value.login.start();
    expect(await exited).toEqual({ code: 0, receiptWritten: true });
    expect(output.join("")).toContain("fixture-sensitive-auth-url-and-code");
    expect(output.join("")).toContain("fixture-sensitive-token-and-error");
    const raw = await readFile(value.receipt, "utf8");
    const receipt = JSON.parse(raw);
    expect(Object.keys(receipt).sort()).toEqual(["exitCode", "finishedAt", "loginToken"]);
    expect(receipt).toMatchObject({ loginToken: "fixture-output-session", exitCode: 0, finishedAt: expect.any(String) });
    expect(raw).not.toContain("fixture-sensitive");
    expect((await stat(value.receipt)).mode & 0o777).toBe(0o600);
  }, 10000);

  it.skipIf(process.platform === "win32")("records parent disconnect after watchdog readiness without starting the native CLI", async () => {
    const value = await fixture();
    const source = await readFile(new URL("../server/login-process.ts", import.meta.url), "utf8");
    const modulePath = join(value.root, "login-process.cjs");
    const ownerPath = join(value.root, "owner.cjs");
    const watchdogPath = join(value.root, "watchdog.json");
    await writeFile(modulePath, transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText);
    await writeFile(ownerPath, `
const fs=require('node:fs'),{createLoginProcess}=require(${JSON.stringify(modulePath)});
const login=createLoginProcess({command:[process.execPath,${JSON.stringify(value.cli)}],args:['group',${JSON.stringify(value.pids)}],env:process.env,cwd:${JSON.stringify(value.root)},receiptPath:${JSON.stringify(value.receipt)},loginToken:'fixture-before-launch',onData(){},onExit(){}});
login.ready().then(()=>{
 const handles=process.report.getReport().libuv.filter(handle=>handle.type==='process');
 fs.writeFileSync(${JSON.stringify(watchdogPath)},JSON.stringify({pid:handles[0].pid}));
});
setInterval(()=>{},1000);
`);
    value.owner = spawn(process.execPath, [ownerPath], { cwd: value.root, env: value.env, stdio: "ignore" });
    const ownerClosed = new Promise<void>((resolve, reject) => { value.owner!.once("close", () => resolve()); value.owner!.once("error", reject); });
    const watchdog = await vi.waitFor(() => readJson<{ pid: number }>(watchdogPath), { timeout: 5000, interval: 20 });
    value.watchdog = watchdog.pid;
    expect(watchdog.pid).toBeGreaterThan(0); expect(alive(watchdog.pid)).toBe(true);
    await expect(readFile(value.pids)).rejects.toMatchObject({ code: "ENOENT" });
    value.owner.kill("SIGKILL"); await ownerClosed;
    expect(await vi.waitFor(() => readJson(value.receipt), { timeout: 5000, interval: 20 })).toMatchObject({ loginToken: "fixture-before-launch", exitCode: 1 });
    await vi.waitFor(() => expect(alive(watchdog.pid)).toBe(false), { timeout: 5000, interval: 20 });
    await expect(readFile(value.pids)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);
});
