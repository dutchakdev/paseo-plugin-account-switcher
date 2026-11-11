import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { CURSOR_PRELOAD, cursorEnvironment, verifyCursorCommand } from "../server/cursor-runtime";
import { readCursorCredentials } from "../server/usage/cursor";
import { readCredentialVersion, type QuotaAccount } from "../server/usage";
import { AccountStore } from "../server/store";
import { launcherPath, writeLaunchers } from "../server/integration";
import { LoginSessions } from "../server/login";

const exec = promisify(execFile), cli = join(process.cwd(),"tests","fixtures","cursor-cli.cjs");
it.each(["linux","darwin"])("isolates Cursor accounts and team state on %s while preserving the user's environment and sessions", async platform => {
  const root = await mkdtemp(join(tmpdir(), "cursor-runtime-"));
  try {
    const home = join(root,"home"), xdg = join(root,"xdg"), shared = join(home,".cursor");
    const first = join(root,"accounts","first","cursor"), second = join(root,"accounts","second","cursor");
    await Promise.all([mkdir(shared,{recursive:true}),mkdir(xdg,{recursive:true}),mkdir(join(first,"cursor"),{recursive:true}),mkdir(join(second,"cursor"),{recursive:true}),mkdir(join(root,"bin"))]);
    await writeFile(join(shared,"session"),"shared-session");
    await writeFile(join(shared,"cli-config.json"),JSON.stringify({authInfo:{userId:123,activeTeamId:303},privacyCache:{ghostMode:false,privacyMode:0,updatedAt:1}}));
    const globalAuth=join(platform==="darwin"?shared:join(xdg,"cursor"),"auth.json");
    await mkdir(join(globalAuth,".."),{recursive:true});await writeFile(globalAuth,"system-account");
    await writeFile(join(first,"cursor","auth.json"),"first-account");await writeFile(join(second,"cursor","auth.json"),"second-account");
    await writeFile(join(root,"bin","cursor-preload.cjs"),CURSOR_PRELOAD);
    const fakePlatform=join(root,"platform.cjs");await writeFile(fakePlatform,`Object.defineProperty(process,'platform',{value:'${platform}'});`);
    const base:NodeJS.ProcessEnv={...process.env,HOME:home,XDG_CONFIG_HOME:xdg,CURSOR_CONFIG_DIR:shared,NODE_OPTIONS:`--require=${JSON.stringify(fakePlatform)}`};
    delete base.AGENT_CLI_CREDENTIAL_STORE;
    const env=(profile:string)=>({...base,...cursorEnvironment(profile,base)});
    const run=(profile:string,...args:string[])=>exec(process.execPath,[cli,...args],{env:env(profile)});
    await verifyCursorCommand([process.execPath,cli],env(first));
    await expect(verifyCursorCommand(["/usr/bin/true"],env(first))).rejects.toThrow();
    const drift=join(root,"accounts","drift","cursor");await mkdir(join(drift,"cursor"),{recursive:true});
    expect((await run(drift,"drift")).stdout.trim()).toBe("url+buffer+relative+renamed");
    expect(await readFile(join(drift,"cursor","auth.json"),"utf8")).toBe("url+buffer+relative+renamed");
    await run(first,"team","101");await run(second,"team","202");
    const sockets=new Set<string>();
    for(const [profile,team,account] of [[first,101,"first-account"],[second,202,"second-account"]] as const) {
      const result=JSON.parse((await run(profile,"inspect")).stdout);sockets.add(result.worker.socket);
      expect(result).toEqual({team,privacy:team,account,session:"shared-session",child:{home,xdg,options:base.NODE_OPTIONS,account:"system-account"},worker:{account,socket:expect.stringMatching(/^[0-9a-f]{6}\.sock$/)}});
    }
    expect(sockets.size).toBe(2);
    expect((await run(first,"renamed-worker")).stdout.trim()).toBe("Cursor worker isolation was not confirmed");
    expect(JSON.parse(await readFile(join(shared,"cli-config.json"),"utf8"))).toMatchObject({authInfo:{activeTeamId:303},privacyCache:{privacyMode:0},network:{useHttp1ForAgent:true}});
    expect(await readFile(globalAuth,"utf8")).toBe("system-account");
  } finally { await rm(root,{recursive:true,force:true}); }
},30000);

it("confirms simulated macOS account launches and refuses an unverified switch", async () => {
  const root=await mkdtemp(join(tmpdir(),"cursor-launch-")),home=join(root,"home"),shared=join(home,".cursor");
  try {
    await mkdir(shared,{recursive:true});await writeFile(join(shared,"auth.json"),"system-account");
    const store=new AccountStore(root);await store.initialize({claude:join(root,"claude"),codex:join(root,"codex"),cursor:home});
    const first=await store.add("cursor","First"),second=await store.add("cursor","Second");
    for(const [account,value] of [[first,"first"],[second,"second"]] as const) {
      await mkdir(join(account.home,"cursor"),{recursive:true});await writeFile(join(account.home,"cursor","auth.json"),value);
    }
    const platform=join(root,"platform.cjs");await writeFile(platform,"Object.defineProperty(process,'platform',{value:'darwin'});");
    await store.change(state=>{state.commands.cursor=[process.execPath,cli,"acp"];state.available.cursor=true;state.sourceEnvironment.cursor={CURSOR_CONFIG_DIR:shared};});
    await writeLaunchers(store);await store.prepare("chat","cursor",first.id);
    const env={...process.env,HOME:home,PASEO_AGENT_ID:"chat",NODE_OPTIONS:`--require=${JSON.stringify(platform)}`};
    const launch=()=>new Promise<string>((resolve,reject)=>{
      const child=execFile(launcherPath(root,"cursor"),[],{env},(error,stdout)=>error?reject(error):resolve(stdout));child.stdin!.end();
    });
    for(const [account,value] of [[first,"first"],[second,"second"]] as const) {
      await store.change(state=>{Object.assign(state.bindings[0],{launchAccountId:account.id,launchToken:value});});
      expect(JSON.parse((await launch()).trim())).toMatchObject({account:value,shared,home});
      expect(JSON.parse(await readFile(join(root,"receipts","chat.json"),"utf8"))).toMatchObject({accountId:account.id,launchToken:value});
    }
    await rm(join(root,"receipts","chat.json"));
    await store.change(state=>{state.commands.cursor=["/usr/bin/true","acp"];state.bindings[0].launchToken="unconfirmed";});
    await expect(launch()).rejects.toThrow();
    await expect(readFile(join(root,"receipts","chat.json"))).rejects.toMatchObject({code:"ENOENT"});
    expect(await readFile(join(shared,"auth.json"),"utf8")).toBe("system-account");
  } finally { await rm(root,{recursive:true,force:true}); }
},30000);

it.each(["linux","darwin"])("runs browser sign-in through the isolated profile and watchdog on %s", async platform => {
  const root = await mkdtemp(join(tmpdir(),"cursor-login-")), home = join(root,"home");
  const descriptor = Object.getOwnPropertyDescriptor(process,"platform")!, previousHome = process.env.HOME, previousOptions=process.env.NODE_OPTIONS, previousXdg=process.env.XDG_CONFIG_HOME;
  const logins = new LoginSessions({finish:async()=>true});
  try {
    const systemAuth=join(home,platform==="darwin"?".cursor":".config/cursor","auth.json");
    await mkdir(dirname(systemAuth),{recursive:true});await writeFile(systemAuth,"system-account");
    const fakePlatform=join(root,"platform.cjs");await writeFile(fakePlatform,`Object.defineProperty(process,'platform',{value:'${platform}'});`);
    Object.defineProperty(process,"platform",{value:platform});process.env.HOME=home;process.env.XDG_CONFIG_HOME=join(home,".config");process.env.NODE_OPTIONS=`--require=${JSON.stringify(fakePlatform)}`;
    const store=new AccountStore(root);
    await store.initialize({claude:join(root,"claude"),codex:join(root,"codex"),cursor:home});
    await store.change(state=>{state.commands.cursor=[process.execPath,cli,"acp"];state.available.cursor=true;});
    const account=await store.add("cursor","Managed");await mkdir(account.home,{recursive:true});await writeLaunchers(store);
    // The watchdog must not execute Cursor's preload; only the CLI needs it.
    await writeFile(join(root,"bin","cursor-preload.cjs"),`if (process.argv[1]?.includes('/logins/')) throw new Error('Preload reached watchdog');\n${CURSOR_PRELOAD}`);
    await logins.start(account,await store.read(),root,"login-id");
    for(let i=0;i<200 && !["complete","error"].includes(logins.status(account.id,"login-id").status);i++) await new Promise(resolve=>setTimeout(resolve,50));
    expect(logins.status(account.id,"login-id").status).toBe("complete");
    expect(await readFile(join(account.home,"cursor","auth.json"),"utf8")).toBe("managed-account");
    expect(await readFile(systemAuth,"utf8")).toBe("system-account");
  } finally {
    await logins.close();Object.defineProperty(process,"platform",descriptor);
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previousOptions;
    if(previousXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=previousXdg;
    await rm(root,{recursive:true,force:true});
  }
},30000);

it("uses the macOS system account's Keychain or explicitly selected file for usage", async () => {
  const account: QuotaAccount = {id:"system-cursor",provider:"cursor",source:"system",home:"/Users/test",env:{},command:["cursor-agent"],identityKey:null,generation:0};
  const readKeychain = async (target: {account:string;service:string}) => {
    expect(target).toEqual({account:"cursor-user",service:"cursor-access-token"});return "synthetic-token";
  };
  expect(await readCursorCredentials(account, {platform:"darwin",readKeychain})).toEqual({source:"keychain",raw:JSON.stringify({accessToken:"synthetic-token"})});
  expect(await readCredentialVersion(account,{platform:"darwin",readKeychain})).toMatch(/^present:/);
  account.env.AGENT_CLI_CREDENTIAL_STORE = "file";
  expect(await readCursorCredentials(account, {platform:"darwin",readFile:async path => {expect(path).toBe("/Users/test/.cursor/auth.json");return "{}";}})).toEqual({source:"file",raw:"{}"});
});
