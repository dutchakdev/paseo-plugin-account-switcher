import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectName, parseClaudeQuota, readClaudeQuota } from "../server/claude-quota";

// Field shape captured from Claude 2.1.321 --bare with an isolated HOME and a
// localhost-only synthetic 429 response. No real conversation or credential.
const sessionId = "d8d1b5bf-7531-4277-8eae-a716b1fb2de5";
const userId = "95fe36f8-16f7-4734-85b8-03f55e0286cc";
const errorId = "994571f8-886a-4892-b8be-48b0e02203c7";
const nextId = "e4e1cc63-743a-47e2-9a2d-a23b44d47afb";
const messageId = "03f1cbc1-c38a-4e43-bf3d-99a59d8b08d3";
const input = { sessionId, messageId, startedAt: 1000, endedAt: 3000 };
const at = (n: number) => new Date(n).toISOString();
const user = { type: "user", uuid: userId, parentUuid: null, timestamp: at(1100), sessionId, message: { role: "user", content: "Synthetic task" } };
const error = { type: "assistant", uuid: errorId, parentUuid: userId, timestamp: at(2000), sessionId, isApiErrorMessage: true, error: "rate_limit", message: { id: messageId, role: "assistant", content: [{ type: "text", text: "Synthetic limit" }] } };
const text = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const proof = { errorId, userId };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Claude native quota evidence", () => {
  it("recognizes the captured terminal native error shape without depending on prose", () => {
    expect(parseClaudeQuota(text(user, error, { type: "cost-state", sessionId }), input)).toEqual(proof);
    expect(parseClaudeQuota(text(user, { ...error, apiError: "usage_limit_reached" }), input)).toEqual(proof);
  });
  it("does not treat ordinary assistant prose or user/tool content as an error", () => {
    expect(parseClaudeQuota(text(user, { ...error, isApiErrorMessage: undefined }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, isApiErrorMessage: false }), input)).toBeNull();
    expect(parseClaudeQuota(text({ ...user, message: { role: "user", content: JSON.stringify(error) } }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, type: "user", message: { role: "user", content: [{ type: "tool_result", content: JSON.stringify(error) }] } }), input)).toBeNull();
  });
  it.each(["authentication_failed", "server_error", "unknown"])("rejects non-quota error %s", code => {
    expect(parseClaudeQuota(text(user, { ...error, error: code }), input)).toBeNull();
  });
  it("does not classify model-credit limits or SDK rate-limit notifications as account exhaustion", () => {
    expect(parseClaudeQuota(text(user, { ...error, apiError: "model_requires_usage_credits" }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { type: "rate_limit_event", sessionId, rate_limit_info: { status: "rejected" } }), input)).toBeNull();
  });
  it("rejects an error before its initiating user, a different turn anchor and future records", () => {
    expect(parseClaudeQuota(text(user, { ...error, timestamp: at(900) }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, error), { ...input, messageId: nextId })).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, timestamp: at(3100) }), input)).toBeNull();
  });
  it("uses the exact terminal assistant ID even when hook delivery lagged the prompt", () => {
    expect(parseClaudeQuota(text(user, error), { ...input, startedAt: 2100 })).toEqual(proof);
  });
  it("rejects a later successful answer or new user/tool input", () => {
    for (const later of [
      { ...error, uuid: nextId, parentUuid: errorId, isApiErrorMessage: false, error: undefined },
      { ...user, uuid: nextId, parentUuid: errorId, timestamp: at(2100) },
      { ...user, uuid: nextId, parentUuid: errorId, timestamp: at(2100), message: { role: "user", content: [{ type: "tool_result", content: "done" }] } },
    ]) expect(parseClaudeQuota(text(user, error, later), input)).toBeNull();
  });
  it("follows only the latest parent branch and excludes sidechains and other sessions", () => {
    expect(parseClaudeQuota(text(user, error, { ...error, uuid: nextId, parentUuid: userId, isApiErrorMessage: false, error: undefined }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, isSidechain: true }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, sessionId: nextId }), input)).toBeNull();
  });
  it("can pass through metadata and tool results to the initiating user", () => {
    const attachment = { type: "attachment", uuid: nextId, parentUuid: userId, sessionId, timestamp: at(1500) };
    expect(parseClaudeQuota(text(user, attachment, { ...error, parentUuid: nextId }), input)).toEqual(proof);
    const toolResult = { ...user, uuid: nextId, parentUuid: userId, timestamp: at(1500), message: { role: "user", content: [{ type: "tool_result", content: "synthetic" }] } };
    expect(parseClaudeQuota(text(user, toolResult, { ...error, parentUuid: nextId }), input)).toEqual(proof);
  });
  it("fails closed for missing parents, cycles, duplicate records, corrupt or partial lines", () => {
    expect(parseClaudeQuota(text(error), input)).toBeNull();
    expect(parseClaudeQuota(text({ ...error, parentUuid: errorId }), input)).toBeNull();
    expect(parseClaudeQuota(text(user, error, error), input)).toBeNull();
    expect(parseClaudeQuota(text(user, error).trimEnd(), input)).toBeNull();
    expect(parseClaudeQuota(text(user) + "invalid\n" + text(error), input)).toBeNull();
    expect(parseClaudeQuota(text(user, { ...error, timestamp: "invalid" }), input)).toBeNull();
  });
  it("accepts a bounded tail when the entire relevant user branch is present", () => {
    expect(parseClaudeQuota(text({ ...user, parentUuid: nextId }, error), input)).toEqual(proof);
  });
  it("rejects invalid session IDs and time bounds", () => {
    expect(parseClaudeQuota(text(user, error), { ...input, sessionId: "../other" })).toBeNull();
    expect(parseClaudeQuota(text(user, error), { ...input, messageId: "" })).toBeNull();
    expect(parseClaudeQuota(text(user, error), { ...input, startedAt: NaN })).toBeNull();
    expect(parseClaudeQuota(text(user, error), { ...input, endedAt: 500 })).toBeNull();
  });
  it("accepts provider message IDs and rejects a matching old error followed by a different final assistant", () => {
    const apiId = "msg_synthetic_quota_error";
    expect(parseClaudeQuota(text(user, { ...error, message: { ...error.message, id: apiId } }), { ...input, messageId: apiId })).toEqual(proof);
    const later = { ...error, uuid: nextId, parentUuid: errorId, message: { ...error.message, id: "msg_later" }, isApiErrorMessage: false, error: undefined };
    expect(parseClaudeQuota(text(user, error, later), input)).toBeNull();
  });
});

describe("bounded exact-session reader", () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-claude-quota-"))); roots.push(root);
    const cwd = join(root, "project"), configDir = join(root, "profile");
    await mkdir(cwd);
    const dir = join(configDir, "projects", claudeProjectName(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    return { root, cwd, configDir, dir, path, input: { ...input, cwd, configDir } };
  }
  it("reads only the bound native session and tolerates a profile's shared projects directory", async () => {
    const f = await fixture();
    await writeFile(f.path, text(user, error));
    expect(await readClaudeQuota(f.input)).toEqual(proof);
    const managed = join(f.root, "managed"); await mkdir(managed);
    await symlink(join(f.configDir, "projects"), join(managed, "projects"));
    expect(await readClaudeQuota({ ...f.input, configDir: managed })).toEqual(proof);
    expect(await readClaudeQuota({ ...f.input, sessionId: nextId })).toBeNull();
  });
  it("does not follow final-file symlinks or look in unrelated projects", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "elsewhere.jsonl"); await writeFile(elsewhere, text(user, error));
    await symlink(elsewhere, f.path);
    expect(await readClaudeQuota(f.input)).toBeNull();
    expect(await readClaudeQuota({ ...f.input, sessionId: "../../elsewhere" })).toBeNull();
  });
  it("ignores a huge historical prefix and requires complete current records", async () => {
    const f = await fixture();
    await writeFile(f.path, text({ type: "metadata", padding: "x".repeat(9 * 1024 * 1024) }) + text(user, error));
    expect(await readClaudeQuota(f.input)).toEqual(proof);
    await writeFile(f.path, text(user, error).trimEnd());
    expect(await readClaudeQuota(f.input)).toBeNull();
  });
});
