import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import { AccountController } from "../server/controller";
import { readCredentialVersion } from "../server/usage";
import { probeAccount } from "../server/auth";

vi.mock("../server/usage",()=>({
  createUsageService:()=>({start:vi.fn(),close:vi.fn(async()=>{}),invalidate:vi.fn(),refresh:vi.fn(async()=>[])}),
  readCredentialVersion:vi.fn(async()=>"present:fixture"),
}));
vi.mock("../server/auth",async importOriginal=>({
  ...await importOriginal<typeof import("../server/auth")>(),
  probeAccount:vi.fn(async()=>({identityKey:"fixture-identity",email:null,plan:null,authStatus:"ready"})),
}));
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe("system Claude quota credential home",()=>{
  it.each(["probe-error","credential-error","unstable"])("does not reuse identity proof after %s",async failure=>{
    const root=await mkdtemp(join(tmpdir(),"quota-unproven-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.commands.claude=[process.execPath];});
      await controller.quotaAccounts({verifyAccountId:"system-claude"});
      if(failure==="probe-error")vi.mocked(probeAccount).mockResolvedValueOnce({identityKey:null,email:null,plan:null,authStatus:"error"});
      if(failure==="credential-error")vi.mocked(readCredentialVersion).mockResolvedValueOnce("unavailable");
      if(failure==="unstable")for(const version of ["one","two","three","four"])vi.mocked(readCredentialVersion).mockResolvedValueOnce(`present:${version}`);
      const current=(await controller.quotaAccounts({verifyAccountId:"system-claude"})).find(account=>account.id==="system-claude")!;
      expect(current.identityCredentialVersion).toBeUndefined();
      expect(current.identityKey).toBe("fixture-identity");
    } finally {await controller.close();}
  });
  it("binds identity proof to stable credentials and verifies only the requested account",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-proof-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.commands.claude=[process.execPath];state.commands.codex=[process.execPath];});
      vi.mocked(readCredentialVersion).mockResolvedValueOnce("present:old").mockResolvedValueOnce("present:new").mockResolvedValueOnce("present:new").mockResolvedValueOnce("present:new");
      const accounts=await controller.quotaAccounts({verifyAccountId:"system-claude"});
      expect(accounts.find(account=>account.id==="system-claude")).toMatchObject({identityKey:"fixture-identity",credentialVersion:"present:new",identityCredentialVersion:"present:new"});
      expect(vi.mocked(readCredentialVersion).mock.calls.map(([account])=>account.id)).toEqual(Array(4).fill("system-claude"));
      expect(vi.mocked(probeAccount).mock.calls.map(([account])=>account.id)).toEqual(["system-claude","system-claude"]);
    } finally {await controller.close();}
  });
  it("lists stored quota accounts without spawning credential readers or native probes",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-idle-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.commands.claude=[process.execPath];});
      for(let tick=0;tick<12;tick++)await controller.quotaAccounts();
      expect(vi.mocked(readCredentialVersion).mock.calls.length).toBe(0);
      expect(vi.mocked(probeAccount).mock.calls.length).toBe(0);
    } finally {await controller.close();}
  });
  it.each([
    {name:"explicit secure-storage home",environment:{CLAUDE_CONFIG_DIR:"/fixture/settings",CLAUDE_SECURESTORAGE_CONFIG_DIR:"/fixture/credentials"},expected:"/fixture/credentials"},
    {name:"empty secure-storage override",environment:{CLAUDE_CONFIG_DIR:"/fixture/settings",CLAUDE_SECURESTORAGE_CONFIG_DIR:""},expected:join(process.env.HOME||homedir(),".claude")},
    {name:"configuration home fallback",environment:{CLAUDE_CONFIG_DIR:"/fixture/settings"},expected:"/fixture/settings"},
  ])("uses $name without moving shared settings",async({environment,expected})=>{
    const root=await mkdtemp(join(tmpdir(),"quota-controller-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{
        state.sourceEnvironment.claude=environment;
        state.commands.claude=[process.execPath];
        state.accounts.find(account=>account.id==="system-claude")!.home="/fixture/settings";
      });
      const account=(await controller.quotaAccounts({verifyAccountId:"system-claude"})).find(account=>account.id==="system-claude")!;
      expect(account.home).toBe(expected);
      expect(vi.mocked(readCredentialVersion)).toHaveBeenCalledWith(expect.objectContaining({id:"system-claude",home:expected}));
      expect((await controller.store.read()).accounts.find(account=>account.id==="system-claude")?.home).toBe("/fixture/settings");
    } finally {await controller.close();}
  });
  it("preserves explicitly empty secure-storage configuration during provider discovery",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-discovery-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    const config={providers:{claude:{command:[process.execPath],env:{CLAUDE_CONFIG_DIR:"/fixture/settings",CLAUDE_SECURESTORAGE_CONFIG_DIR:""}},codex:{command:[process.execPath]}}};
    const paseo={config:{get:async()=>({config})}} as unknown as PaseoApi;
    try {
      await controller.ensureRuntime(paseo);
      expect((await controller.store.read()).sourceEnvironment.claude).toEqual({CLAUDE_CONFIG_DIR:"/fixture/settings",CLAUDE_SECURESTORAGE_CONFIG_DIR:""});
    } finally {await controller.close();}
  });
});
