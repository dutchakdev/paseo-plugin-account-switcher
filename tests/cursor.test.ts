import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoApi } from "../server/paseo-api";
import { AccountStore } from "../server/store";
import { accountCommand, accountEnvironment, probeAccount } from "../server/auth";
import { assertManagedCommand, assertSubscriptionEnvironment, buildAccountEnv, prepareProfile } from "../server/profiles";
import { installIntegration, launcherPath, prepareRuntime, reconcileIntegration, restoreIntegration, writeLaunchers } from "../server/integration";
import { readCursorCredentials } from "../server/usage/cursor";
import { LoginSessions } from "../server/login";
import type { LoginProcessOptions } from "../server/login-process";
import { SwitchService } from "../server/switching";
import { atomicWrite } from "../server/files";
import { AccountController } from "../server/controller";
import { supportedProvider } from "../client/format";

describe.skipIf(process.platform !== "linux")("Cursor accounts on Linux", () => {
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(closers.splice(0).map(close => close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-accounts-")); roots.push(root);
  const store = new AccountStore(root);
  const sourceHomes = {claude:join(root,"claude"),codex:join(root,"codex"),cursor:join(root,"xdg")};
  await store.initialize(sourceHomes);
  const shared = join(root,"shared-cursor");
  const cli = join(process.cwd(),"tests","fixtures","cursor-cli.cjs");
  await store.change(r => {r.commands.cursor=[process.execPath,cli,"acp"];r.available.cursor=true;r.sourceEnvironment.cursor={CURSOR_CONFIG_DIR:shared};});
  const first=await store.add("cursor","Personal"), second=await store.add("cursor","Work");
  for(const [account,id] of [[first,1],[second,2]] as const) {
    await prepareProfile({provider:"cursor",home:account.home,sourceHome:sourceHomes.cursor});
    await writeFile(join(account.home,"cursor","auth.json"),JSON.stringify({email:`account${id}@example.test`,id}));
  }
  await writeLaunchers(store);
  return {root,store,sourceHomes,shared,cli,first,second};
}
async function run(command:string,args:string[],env:NodeJS.ProcessEnv,input="") {
  return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:"pipe"});let stdout="",stderr="";
    child.stdout.on("data",data=>{stdout+=data;});child.stderr.on("data",data=>{stderr+=data;});
    child.once("error",reject);child.once("close",code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
}

it("upgrades the two-provider v1 registry without losing bindings, defaults, commands, or integration",async()=>{
  const f=await fixture();await f.store.prepare("old-chat","codex",null);
  await f.store.change(r=>{r.defaults.codex="system-codex";r.commands.codex=["/old/codex"];r.integration={enabled:true,error:null,providers:["claude","codex"]};});
  const raw=JSON.parse(await readFile(join(f.root,"registry.json"),"utf8"));
  raw.accounts=raw.accounts.filter((a:{provider:string})=>a.provider!=="cursor");
  for(const key of ["defaults","commands","originalCommands","available","sourceHomes","sourceEnvironment"]) delete raw[key].cursor;
  delete raw.fallback;delete raw.autoFailover;
  await writeFile(join(f.root,"registry.json"),JSON.stringify(raw));
  await f.store.initialize(f.sourceHomes);
  const upgraded=await f.store.read();
  expect(upgraded).toMatchObject({version:1,defaults:{codex:"system-codex",cursor:null},fallback:{claude:true,codex:true},autoFailover:{claude:false,codex:false},commands:{codex:["/old/codex"],cursor:null},integration:raw.integration,bindings:raw.bindings});
  // Upgrading adds no Cursor account; one appears only when Cursor is set up.
  expect(upgraded.accounts.filter(a=>a.provider==="cursor")).toHaveLength(0);
  const bytes=await readFile(join(f.root,"registry.json"),"utf8");await f.store.initialize(f.sourceHomes);
  expect(await readFile(join(f.root,"registry.json"),"utf8")).toBe(bytes);
});

it("uses each credential profile and one shared Cursor session directory for login/status/ACP",async()=>{
  const f=await fixture(),r=await f.store.read();
  for(const [account,id] of [[f.first,1],[f.second,2]] as const) {
    expect(accountEnvironment(account,r,{CURSOR_CONFIG_DIR:"/wrong",CURSOR_API_KEY:"private"})).toMatchObject({PASEO_CURSOR_AUTH_FILE:join(account.home,"cursor","auth.json"),CURSOR_CONFIG_DIR:f.shared});
    expect(accountEnvironment(account,r).CURSOR_API_KEY).toBeUndefined();
    expect(accountEnvironment(account,r,{AGENT_CLI_CREDENTIAL_STORE:"memory"}).AGENT_CLI_CREDENTIAL_STORE).toBe(process.platform==="darwin"?"file":undefined);
    expect(await probeAccount(account,r)).toMatchObject({email:`account${id}@example.test`,authStatus:"ready"});
  }
  expect(accountCommand(r,"cursor")).toEqual([process.execPath,f.cli]);
  expect((await probeAccount(f.first,r)).identityKey).not.toBe((await probeAccount(f.second,r)).identityKey);
  expect(buildAccountEnv("cursor",f.first.home,{}).CURSOR_CONFIG_DIR).toMatch(/\/\.cursor$/);
  expect(await readFile(join(f.first.home,"cursor","auth.json"),"utf8")).not.toContain("account2");
});

it("wraps the exact cursor provider while preserving extends, label, environment and native ACP command",async()=>{
  const f=await fixture();
  const config={providers:{cursor:{extends:"acp",label:"Cursor",enabled:true,command:[process.execPath,f.cli,"acp"],env:{CURSOR_CONFIG_DIR:f.shared,XDG_CONFIG_HOME:f.sourceHomes.cursor}},claude:{command:[process.execPath]},codex:{command:[process.execPath]}}};
  const patch=vi.fn(async(input:{providers:Record<string,unknown>})=>{Object.assign(config.providers,input.providers);});
  const paseo={config:{get:async()=>({config}),patch}} as unknown as PaseoApi;
  await installIntegration(paseo,f.store);
  expect(config.providers.cursor).toMatchObject({extends:"acp",label:"Cursor",command:[launcherPath(f.root,"cursor")],env:{CURSOR_CONFIG_DIR:f.shared}});
  expect((await f.store.read()).integration.providers).toContain("cursor");
  expect((await f.store.read()).commands.cursor).toEqual([process.execPath,f.cli,"acp"]);
  await restoreIntegration(paseo,f.store);
  expect(config.providers.cursor.command).toEqual([process.execPath,f.cli,"acp"]);
  expect(supportedProvider("cursor")).toBe("cursor");expect(supportedProvider("cursor-cli")).toBeNull();
});

it("does not add a cursor provider implicitly or interfere with existing two-provider installations",async()=>{
  const f=await fixture();
  const patch=vi.fn(),paseo={config:{get:async()=>({config:{providers:{claude:{command:[process.execPath]},codex:{command:[process.execPath]}}}}),patch}} as unknown as PaseoApi;
  await prepareRuntime(paseo,f.store);
  expect((await f.store.read()).available.cursor).toBe(false);expect(patch).not.toHaveBeenCalled();
  expect((await f.store.read()).accounts.some(a=>a.id==="system-cursor")).toBe(false);
});

it("keeps Claude and Codex integrated when Cursor is disabled or its entry is removed",async()=>{
  const f=await fixture();
  const config:{providers:Record<string,Record<string,unknown>>}={providers:{cursor:{extends:"acp",command:[process.execPath,f.cli,"acp"],env:{CURSOR_CONFIG_DIR:f.shared,XDG_CONFIG_HOME:f.sourceHomes.cursor}},claude:{command:[process.execPath]},codex:{command:[process.execPath]}}};
  const paseo={config:{get:async()=>({config}),patch:async(input:{providers:Record<string,Record<string,unknown>>})=>{Object.assign(config.providers,input.providers);}}} as unknown as PaseoApi;
  await installIntegration(paseo,f.store);
  expect((await f.store.read()).accounts.find(a=>a.id==="system-cursor")?.home).toBe(f.sourceHomes.cursor);
  config.providers.cursor.enabled=false;
  await prepareRuntime(paseo,f.store);await reconcileIntegration(paseo,f.store);
  expect((await f.store.read()).integration).toEqual({enabled:true,error:null,providers:["claude","codex","cursor"]});
  await f.store.prepare("claude-chat","claude",null);await f.store.prepare("cursor-chat","cursor",f.first.id);
  await f.store.change(r=>{for(const b of r.bindings)b.launchToken="pending";});
  delete config.providers.cursor;
  await reconcileIntegration(paseo,f.store);await prepareRuntime(paseo,f.store);
  const registry=await f.store.read();
  expect(registry.integration).toEqual({enabled:true,error:null,providers:["claude","codex"]});
  expect(registry.bindings.map(b=>[b.agentId,b.launchToken])).toEqual([["claude-chat","pending"],["cursor-chat",null]]);
  expect(registry.accounts.filter(a=>a.provider==="cursor")).toHaveLength(3);
});

it("refuses a managed Cursor profile whose credentials are redirected elsewhere",async()=>{
  const f=await fixture(),registry=await f.store.read(),elsewhere=join(f.root,"elsewhere");
  await mkdir(elsewhere);await writeFile(join(elsewhere,"auth.json"),JSON.stringify({email:"other@example.test",id:9}));
  await rm(join(f.first.home,"cursor"),{recursive:true});await symlink(elsewhere,join(f.first.home,"cursor"));
  await rm(join(f.second.home,"cursor","auth.json"));await symlink(join(elsewhere,"auth.json"),join(f.second.home,"cursor","auth.json"));
  for(const account of [f.first,f.second]) {
    expect(await probeAccount(account,registry)).toMatchObject({email:null,authStatus:"error"});
    await expect(readCursorCredentials({id:account.id,provider:"cursor",source:"managed",home:account.home,env:{},command:[],identityKey:null,generation:0})).rejects.toThrow("outside the account profile");
  }
});

it("keeps launcher stdout transparent and confirms the selected account in a file receipt",async()=>{
  const f=await fixture();await writeLaunchers(f.store);
  await f.store.prepare("cursor/chat","cursor",f.second.id);
  await f.store.change(r=>{Object.assign(r.bindings[0],{launchAccountId:f.second.id,launchToken:"fresh-token"});});
  const originalXdg=join(f.root,"original-xdg");
  const result=await run(launcherPath(f.root,"cursor"),[],{...process.env,PASEO_AGENT_ID:"cursor/chat",CURSOR_CONFIG_DIR:"/wrong",CURSOR_API_KEY:"private",XDG_CONFIG_HOME:f.second.home,PASEO_CURSOR_ORIGINAL_ENV:JSON.stringify({XDG_CONFIG_HOME:originalXdg})},"ACP frame\n");
  expect(result).toMatchObject({code:0,stderr:""});
  const [first,...rest]=result.stdout.split("\n");
  expect(JSON.parse(first)).toEqual({xdg:originalXdg,shared:f.shared,args:["acp"],home:process.env.HOME,account:await readFile(join(f.second.home,"cursor","auth.json"),"utf8")});expect(rest.join("\n")).toBe("ACP frame\n");
  expect(JSON.parse(await readFile(join(f.root,"receipts","cursor%2Fchat.json"),"utf8"))).toMatchObject({accountId:f.second.id,launchToken:"fresh-token"});
});

it("passes Cursor ACP output through unchanged",async()=>{
  const f=await fixture(),cli=join(f.root,"model-picker.cjs");
  const wire=JSON.stringify({jsonrpc:"2.0",id:1,result:{models:{},configOptions:[{id:"model",type:"select",category:"model"}]}})+"\r\n";
  await writeFile(cli,`process.stdout.write(${JSON.stringify(wire)});process.stderr.write('diagnostic\\n');`);
  await f.store.change(r=>{r.commands.cursor=[process.execPath,cli,"acp"];});
  await writeLaunchers(f.store);
  expect(await run(launcherPath(f.root,"cursor"),[],process.env)).toEqual({code:0,stdout:wire,stderr:"diagnostic\n"});
});

it("reserves Cursor browser login, handles split URLs on stderr, and verifies exit without manual codes",async()=>{
  const f=await fixture();let options!:LoginProcessOptions;
  const write=vi.fn(),finish=vi.fn(async()=>true);
  const sessions=new LoginSessions({finish,createProcess:input=>{options=input;return{ready:async()=>{},start:()=>{},write,stop:async()=>{options.onExit(1,true);}};}});closers.push(()=>sessions.close());
  const started=await sessions.start(f.first,await f.store.read(),f.root,"cursor-login");
  expect(started.mode).toBe("browser");expect(options.args).toEqual(["login"]);expect(options.command).toEqual([process.execPath,f.cli]);
  expect(options.env).toMatchObject({NO_OPEN_BROWSER:"1",PASEO_CURSOR_AUTH_FILE:join(f.first.home,"cursor","auth.json"),CURSOR_CONFIG_DIR:f.shared});
  options.onData("stderr","Open https://cursor.com/loginDeepControl?uuid=fixture");
  expect(sessions.status(f.first.id,"cursor-login").authorizationUrl).toBeNull();
  options.onData("stderr","&challenge=fixture\n");
  expect(sessions.status(f.first.id,"cursor-login")).toMatchObject({status:"waiting",canSubmitCode:false,authorizationUrl:"https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture"});
  expect(()=>sessions.submit(f.first.id,"cursor-login","anything")).toThrow(/not waiting/);
  options.onExit(0,true);
  await vi.waitFor(()=>expect(sessions.status(f.first.id,"cursor-login").status).toBe("complete"));
  expect(finish).toHaveBeenCalledWith(f.first.id,"cursor-login",true);expect(write).not.toHaveBeenCalled();
});

it("binds a new Cursor chat before launch and switches A to B to A with distinct receipts",async()=>{
  const f=await fixture(),reloaded:string[]=[];
  await f.store.change(r=>{r.defaults.cursor=f.first.id;r.integration={enabled:true,error:null,providers:["cursor"]};});
  const service=new SwitchService({store:f.store,inspect:async()=>({provider:"cursor",busy:false,archived:false}),checkAccount:async id=>probeAccount((await f.store.read()).accounts.find(a=>a.id===id)!,await f.store.read()),reload:async id=>{
    const b=(await f.store.read()).bindings.find(b=>b.agentId===id)!;reloaded.push(id);
    await atomicWrite(join(f.root,"receipts",encodeURIComponent(id)+".json"),JSON.stringify({accountId:b.launchAccountId,launchToken:b.launchToken}));
  }});
  await service.bindNewAgent("same-chat","cursor");
  expect((await f.store.read()).bindings[0]).toMatchObject({currentAccountId:null,launchAccountId:f.first.id});
  await f.store.change(r=>{r.bindings[0].currentAccountId=f.first.id;});
  for(const target of [f.second,f.first]) {await service.prepare("same-chat",target.id);expect(await service.apply("same-chat")).toMatchObject({currentAccountId:target.id,status:"ready",pendingAccountId:null});}
  expect(reloaded).toEqual(["same-chat","same-chat"]);
});

it("blocks Cursor authentication overrides",async()=>{
  expect(()=>assertSubscriptionEnvironment("cursor",{CURSOR_API_KEY:"private"})).toThrow(/API key/);
  await expect(assertManagedCommand("cursor",["acp","--api-key=private"])).rejects.toThrow(/isolation/);
  await expect(assertManagedCommand("cursor",["acp","--auth-token=private"])).rejects.toThrow(/isolation/);
  expect(()=>assertSubscriptionEnvironment("cursor",{CURSOR_AUTH_TOKEN:"private"})).toThrow();
});

it("includes managed Cursor profiles in quota collection",async()=>{
  const f=await fixture(),controller=new AccountController(f.root);closers.push(()=>controller.close());await controller.ready;
  expect((await controller.quotaAccounts()).filter(a=>a.provider==="cursor").map(a=>a.home)).toEqual(expect.arrayContaining([f.first.home,f.second.home]));
});

});
