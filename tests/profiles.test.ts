import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile, buildAccountEnv, assertManagedCommand } from "../server/profiles";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("keeps account credentials separate while both Codex profiles resume the same history", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-switcher-test-")); roots.push(root);
  const source = join(root, "original"); await mkdir(join(source, "sessions"), { recursive: true });
  await writeFile(join(source, "sessions", "conversation.jsonl"), "preserved conversation\n");
  await writeFile(join(source, "config.toml"), 'model = "test-model"\n');
  const a = join(root, "a"), b = join(root, "b");
  await prepareProfile({ provider: "codex", home: a, sourceHome: source });
  await prepareProfile({ provider: "codex", home: b, sourceHome: source });
  await writeFile(join(a, "auth.json"), '{"token":"A"}');
  await writeFile(join(b, "auth.json"), '{"token":"B"}');
  expect(await realpath(join(a, "sessions"))).toBe(await realpath(join(b, "sessions")));
  expect(await readFile(join(b, "sessions", "conversation.jsonl"), "utf8")).toContain("preserved conversation");
  expect(await readFile(join(a, "auth.json"), "utf8")).toContain("A");
  expect(await readFile(join(b, "auth.json"), "utf8")).toContain("B");
  const envA = buildAccountEnv("codex", a, { PATH: "/usr/bin", OPENAI_API_KEY: "foreign", CODEX_HOME: source });
  const envB = buildAccountEnv("codex", b, envA);
  expect(envA.CODEX_HOME).toBe(a); expect(envB.CODEX_HOME).toBe(b);
  expect(envA.OPENAI_API_KEY).toBeUndefined(); expect(envA.PATH).toBe("/usr/bin");
});

it("refuses shared settings and CLI overrides that could select another identity",async()=>{
 const root=await mkdtemp(join(tmpdir(),"profile-auth-"));roots.push(root);
 const source=join(root,"source"),home=join(root,"account");await mkdir(source);
 await writeFile(join(source,"settings.json"),JSON.stringify({env:{CLAUDE_CONFIG_DIR:"/another/account"}}));
 await expect(prepareProfile({provider:"claude",home,sourceHome:source})).rejects.toThrow(/authentication/);
 await expect(assertManagedCommand("claude",["--settings",JSON.stringify({env:{ANTHROPIC_CUSTOM_HEADERS:"Authorization: foreign"}})])).rejects.toThrow(/authentication/);
 await expect(assertManagedCommand("codex",["-c","profiles.work.cli_auth_credentials_store=\"keyring\""])).rejects.toThrow(/isolation/);
 await expect(assertManagedCommand("codex",["-c","model_reasoning_effort=\"high\""])).resolves.toBeUndefined();
 const env=buildAccountEnv("claude",home,{CLAUDE_CODE_OAUTH_REFRESH_TOKEN:"foreign",CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR:"9",ANTHROPIC_CUSTOM_HEADERS:"foreign",PATH:"/bin"});
 expect(env).toEqual({CLAUDE_CONFIG_DIR:home,PATH:"/bin"});
});

it("updates shared settings without retaining removed values or touching own login",async()=>{
 const root=await mkdtemp(join(tmpdir(),"profile-settings-"));roots.push(root);
 const source=join(root,"source"),home=join(root,"account");await mkdir(source);
 await writeFile(join(source,"settings.json"),'{"theme":"dark"}');
 await prepareProfile({provider:"claude",home,sourceHome:source});
 await writeFile(join(home,".claude.json"),'{"oauthAccount":{"accountUuid":"own"}}');
 await rm(join(source,"settings.json"));
 await prepareProfile({provider:"claude",home,sourceHome:source});
 await expect(readFile(join(home,"settings.json"))).rejects.toMatchObject({code:"ENOENT"});
 expect(JSON.parse(await readFile(join(home,".claude.json"),"utf8")).oauthAccount.accountUuid).toBe("own");
});

it("shares Claude tools and checkpoints without copying the source account identity", async () => {
  const root=await mkdtemp(join(tmpdir(),"claude-profile-"));roots.push(root);
  const source=join(root,"source"),home=join(root,"account");await mkdir(source);
  await writeFile(join(source,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"original"},mcpServers:{local:{command:"test-server"}},hasCompletedOnboarding:true}));
  await writeFile(join(source,"settings.json"),JSON.stringify({permissions:{allow:["Read"]}}));
  await prepareProfile({provider:"claude",home,sourceHome:source});
  const metadata=JSON.parse(await readFile(join(home,".claude.json"),"utf8"));
  expect(metadata.mcpServers.local.command).toBe("test-server");
  expect(metadata.oauthAccount).toBeUndefined();
  expect(await realpath(join(home,"file-history"))).toBe(await realpath(join(source,"file-history")));
  await writeFile(join(home,".claude.json"),JSON.stringify({...metadata,oauthAccount:{accountUuid:"new"}}));
  await prepareProfile({provider:"claude",home,sourceHome:source});
  expect(JSON.parse(await readFile(join(home,".claude.json"),"utf8")).oauthAccount.accountUuid).toBe("new");
});

it("leaves unchanged profile files untouched and still synchronizes changed or removed source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-no-rewrite-")); roots.push(root);
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "config.toml"), 'model = "first"\n');
  await writeFile(join(source, "AGENTS.md"), "Shared instructions\n");
  await writeFile(join(source, "AGENTS.override.md"), "Override instructions\n");
  await writeFile(join(source, "settings.json"), '{"permissions":{"allow":["Read"]}}');
  const codex = join(root, "codex"), claude = join(root, "claude");
  await prepareProfile({ provider: "codex", home: codex, sourceHome: source });
  await prepareProfile({ provider: "claude", home: claude, sourceHome: source });
  const paths = [join(codex, "config.toml"), join(codex, "AGENTS.md"), join(codex, "AGENTS.override.md"), join(claude, "settings.json")];
  const oldTime = new Date("2001-01-01T00:00:00Z");
  for (const path of paths) await utimes(path, oldTime, oldTime);
  const before = await Promise.all(paths.map(path => stat(path)));
  await prepareProfile({ provider: "codex", home: codex, sourceHome: source });
  await prepareProfile({ provider: "claude", home: claude, sourceHome: source });
  for (let index = 0; index < paths.length; index++) {
    const after = await stat(paths[index]);
    expect({ inode: after.ino, modified: after.mtimeMs }).toEqual({ inode: before[index].ino, modified: before[index].mtimeMs });
  }
  await writeFile(join(source, "config.toml"), 'model = "second"\n');
  await writeFile(join(source, "AGENTS.md"), "Updated instructions\n");
  await rm(join(source, "AGENTS.override.md"));
  await writeFile(join(source, "settings.json"), '{"permissions":{"allow":["Read","Edit"]}}');
  await prepareProfile({ provider: "codex", home: codex, sourceHome: source });
  await prepareProfile({ provider: "claude", home: claude, sourceHome: source });
  expect(await readFile(paths[0], "utf8")).toContain('model = "second"');
  expect(await readFile(paths[1], "utf8")).toBe("Updated instructions\n");
  await expect(readFile(paths[2])).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(paths[3], "utf8")).permissions.allow).toEqual(["Read", "Edit"]);
});

it("preserves own Claude project trust and history while importing only ordinary shared project configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-project-state-")); roots.push(root);
  const source = join(root, "source"), home = join(root, "account"); await mkdir(source); await mkdir(home);
  const ownProject = { hasTrustDialogAccepted: true, lastSessionId: "own-session", lastCost: 3, enabledMcpjsonServers: ["trusted"] };
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "own" }, projects: { "/work": ownProject, "/own-only": { lastSessionId: "kept" } } }));
  await writeFile(join(source, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "foreign" }, projects: {
    "/work": { hasTrustDialogAccepted: false, lastSessionId: "foreign-session", lastCost: 9, mcpServers: { shared: { command: "test-server" } } },
    "/new": { mcpContextUris: ["resource://shared"], oauthAccount: { accountUuid: "foreign" }, accessToken: "fixture-secret", hasTrustDialogAccepted: true, lastSessionId: "foreign-session" },
  } }));
  await prepareProfile({ provider: "claude", home, sourceHome: source });
  let metadata = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  expect(metadata.projects["/work"]).toEqual({ ...ownProject, mcpServers: { shared: { command: "test-server" } } });
  expect(metadata.projects["/own-only"]).toEqual({ lastSessionId: "kept" });
  expect(metadata.projects["/new"]).toEqual({ mcpContextUris: ["resource://shared"] });
  expect(metadata.oauthAccount).toEqual({ accountUuid: "own" });
  expect(JSON.stringify(metadata)).not.toContain("fixture-secret");
  await writeFile(join(source, ".claude.json"), '{}');
  await prepareProfile({ provider: "claude", home, sourceHome: source });
  metadata = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  expect(metadata.projects["/work"]).toMatchObject(ownProject);
  expect(metadata.projects["/own-only"]).toEqual({ lastSessionId: "kept" });
});
