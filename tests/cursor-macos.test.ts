import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { CURSOR_MAC_PRELOAD, cursorMacEnvironment, verifyCursorMacCommand } from "../server/cursor-macos";
import { readCursorCredentials } from "../server/usage/cursor";
import { readCredentialVersion, type QuotaAccount } from "../server/usage";
import { AccountStore } from "../server/store";
import { launcherPath, writeLaunchers } from "../server/integration";
import { LoginSessions } from "../server/login";

const exec = promisify(execFile);
it("isolates simulated macOS Cursor logins and preserves HOME, sessions and child options", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-macos-"));
  try {
    const home = join(root, "home"), globalAuth = join(home, ".cursor", "auth.json");
    const first = join(root, "accounts", "first", "cursor"), second = join(root, "accounts", "second", "cursor");
    await Promise.all([mkdir(join(home, ".cursor"), { recursive: true }), mkdir(join(first, "cursor"), { recursive: true }), mkdir(join(second, "cursor"), { recursive: true }), mkdir(join(root, "bin"))]);
    await writeFile(globalAuth, "original");
    await writeFile(join(home, ".cursor", "session"), "shared-session");
    await writeFile(join(root, "bin", "cursor-macos-preload.cjs"), CURSOR_MAC_PRELOAD);
    const script = join(root, "cursor.cjs");
    await writeFile(script, `
      const fs = require('node:fs/promises'), path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const auth = path.join(require('node:os').homedir(), '.cursor', 'auth.json');
      (async () => {
        if (process.argv[2] === '--version') return console.log('1.0');
        if (process.argv[2] === 'login') {
          await fs.writeFile(auth, process.argv[3]); await fs.chmod(auth, 0o600);
        } else {
          const account = await fs.readFile(auth, 'utf8');
          const child = JSON.parse(execFileSync(process.execPath, ['-e',
            'console.log(JSON.stringify({home:process.env.HOME, options:process.env.NODE_OPTIONS, profile:process.env.PASEO_CURSOR_AUTH_FILE}))'], {encoding:'utf8'}));
          const session = await fs.readFile(path.join(process.env.CURSOR_CONFIG_DIR, 'session'), 'utf8');
          console.log(JSON.stringify({ account, child, session }));
        }
      })().catch(() => process.exit(1));
    `);
    const env = (profile: string) => {
      const base = { ...process.env, HOME: home, CURSOR_CONFIG_DIR: join(home, ".cursor"), NODE_OPTIONS: "--no-warnings" };
      return { ...base, ...cursorMacEnvironment(profile, base) };
    };
    const run = (profile: string, ...args: string[]) => exec(process.execPath, [script, ...args], {env:env(profile)});
    await verifyCursorMacCommand([process.execPath,script], env(first));
    await expect(verifyCursorMacCommand(["/usr/bin/true"], env(first))).rejects.toThrow();
    await run(first, "login", "account-one");
    await run(second, "login", "account-two");
    for (const [profile, account] of [[first, "account-one"], [second, "account-two"]]) {
      expect(JSON.parse((await run(profile, "status")).stdout)).toEqual({ account, session: "shared-session", child: { home, options: "--no-warnings" } });
    }
    expect(await readFile(globalAuth, "utf8")).toBe("original");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("launches a switched account with the shared session and confirms the launched process", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-macos-launch-"));
  try {
    const home = join(root,"home"), shared = join(home,".cursor");
    await mkdir(shared,{recursive:true});
    await writeFile(join(shared,"auth.json"),"system-account");
    await writeFile(join(shared,"session"),"original-session");
    const store = new AccountStore(root);
    await store.initialize({claude:join(root,"claude"),codex:join(root,"codex"),cursor:home});
    const first = await store.add("cursor","First"), second = await store.add("cursor","Second");
    for (const [account, value] of [[first,"first"],[second,"second"]] as const) {
      await mkdir(join(account.home,"cursor"),{recursive:true});
      await writeFile(join(account.home,"cursor","auth.json"),value);
    }
    const cli = join(root,"cli.cjs"), fakePlatform = join(root,"platform.cjs");
    await writeFile(fakePlatform, `Object.defineProperty(process,'platform',{value:'darwin'});`);
    await writeFile(cli, `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      (async()=>{
        if(process.argv[2]==='--version')return console.log('1.0');
        const account=await fs.readFile(path.join(os.homedir(),'.cursor','auth.json'),'utf8');
        const session=await fs.readFile(path.join(process.env.CURSOR_CONFIG_DIR,'session'),'utf8');
        console.log(JSON.stringify({account,session,home:process.env.HOME}));
      })().catch(()=>process.exit(1));
    `);
    await store.change(state=>{state.commands.cursor=[process.execPath,cli,"acp"];state.available.cursor=true;state.sourceEnvironment.cursor={CURSOR_CONFIG_DIR:shared};});
    await writeLaunchers(store);
    await writeFile(join(root,"bin","cursor-macos-preload.cjs"),CURSOR_MAC_PRELOAD);
    await store.prepare("chat","cursor",first.id);
    const env={...process.env,HOME:home,PASEO_AGENT_ID:"chat",NODE_OPTIONS:`--require=${JSON.stringify(fakePlatform)}`};
    for (const [account,value] of [[first,"first"],[second,"second"]] as const) {
      await store.change(state=>{Object.assign(state.bindings[0],{launchAccountId:account.id,launchToken:value});});
      const result=await exec(launcherPath(root,"cursor"),[],{env});
      expect(JSON.parse(result.stdout)).toEqual({account:value,session:"original-session",home});
      expect(JSON.parse(await readFile(join(root,"receipts","chat.json"),"utf8"))).toMatchObject({accountId:account.id,launchToken:value});
    }
    expect(await readFile(join(shared,"auth.json"),"utf8")).toBe("system-account");
    const wrapper=join(root,"wrapper");
    await writeFile(wrapper,`#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${process.execPath}' '${cli}' --version; fi\nexec /usr/bin/true\n`,{mode:0o700});
    await rm(join(root,"receipts","chat.json"));
    await store.change(state=>{state.commands.cursor=[wrapper,"acp"];state.bindings[0].launchToken="unconfirmed";});
    await expect(exec(launcherPath(root,"cursor"),[],{env})).rejects.toThrow();
    await expect(readFile(join(root,"receipts","chat.json"))).rejects.toMatchObject({code:"ENOENT"});
  } finally { await rm(root,{recursive:true,force:true}); }
},15000);

it("uses the macOS system account's Keychain or explicitly selected file for usage", async () => {
  const account: QuotaAccount = {id:"system-cursor",provider:"cursor",source:"system",home:"/Users/test",env:{},command:["cursor-agent"],identityKey:null,generation:0};
  const readKeychain = async (target: {account:string;service:string}) => {
    expect(target).toEqual({account:"cursor-user",service:"cursor-access-token"});
    return "synthetic-token";
  };
  const keychain = await readCursorCredentials(account, {platform:"darwin",readKeychain});
  expect(keychain).toEqual({source:"keychain",raw:JSON.stringify({accessToken:"synthetic-token"})});
  expect(await readCredentialVersion(account,{platform:"darwin",readKeychain})).toMatch(/^present:/);
  account.env.AGENT_CLI_CREDENTIAL_STORE = "file";
  const file = await readCursorCredentials(account, {platform:"darwin",readFile:async path => {expect(path).toBe("/Users/test/.cursor/auth.json");return "{}";}});
  expect(file).toEqual({source:"file",raw:"{}"});
});

it("runs the managed sign-in through the macOS redirect and watchdog", async () => {
  const root = await mkdtemp(join(tmpdir(),"cursor-macos-login-")), home = join(root,"home");
  const descriptor = Object.getOwnPropertyDescriptor(process,"platform")!, previousHome = process.env.HOME;
  const logins = new LoginSessions({finish:async()=>true});
  try {
    await mkdir(join(home,".cursor"),{recursive:true});
    await writeFile(join(home,".cursor","auth.json"),"system-account");
    const cli=join(root,"cli.cjs");
    await writeFile(cli, `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      (async()=>{
        if(process.argv[2]==='--version')return console.log('1.0');
        await fs.writeFile(path.join(os.homedir(),'.cursor','auth.json'),'managed-account');
        console.log('https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture');
      })().catch(()=>process.exit(1));
    `);
    Object.defineProperty(process,"platform",{value:"darwin"}); process.env.HOME=home;
    const store=new AccountStore(root);
    await store.initialize({claude:join(root,"claude"),codex:join(root,"codex"),cursor:home});
    await store.change(state=>{state.commands.cursor=[process.execPath,cli,"acp"];state.available.cursor=true;});
    const account=await store.add("cursor","Managed");
    await mkdir(account.home,{recursive:true});
    await writeLaunchers(store);
    await logins.start(account,await store.read(),root,"login-id");
    for(let i=0;i<100 && !["complete","error"].includes(logins.status(account.id,"login-id").status);i++) await new Promise(resolve=>setTimeout(resolve,50));
    expect(logins.status(account.id,"login-id").status).toBe("complete");
    expect(await readFile(join(account.home,"cursor","auth.json"),"utf8")).toBe("managed-account");
    expect(await readFile(join(home,".cursor","auth.json"),"utf8")).toBe("system-account");
  } finally {
    await logins.close(); Object.defineProperty(process,"platform",descriptor);
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    await rm(root,{recursive:true,force:true});
  }
});
