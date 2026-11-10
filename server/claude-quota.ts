import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const conversationTypes = new Set(["user", "assistant", "system", "attachment"]);
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export interface ClaudeQuotaInput {
  configDir: string;
  cwd: string;
  sessionId: string;
  /** Current turn's final assistant message ID (preserved by Paseo projection). */
  messageId: string;
  startedAt: number;
  endedAt: number;
}
export interface ClaudeQuotaEvidence { errorId: string; userId: string }

/** Claude 2.1.321's project directory encoding. Unknown locations fail closed;
 * never search unrelated projects or accounts for an error that happens to fit. */
export function claudeProjectName(cwd: string): string {
  const text = process.platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const encoded = text.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Identifies a terminal, structured native rate-limit interruption, NOT account
 * exhaustion. The caller must separately refresh and prove account-wide quota
 * exhaustion, and reject cancellation/new activity before switching or sending.
 * Ordinary prose, SDK retry events and abandoned parent branches never count.
 * Private JSONL fields were verified with an isolated Claude 2.1.321 process
 * talking only to a synthetic local 429 endpoint; unknown formats return null. */
export function parseClaudeQuota(text: string, input: Pick<ClaudeQuotaInput, "sessionId" | "messageId" | "startedAt" | "endedAt">): ClaudeQuotaEvidence | null {
  const { sessionId, messageId, startedAt, endedAt } = input;
  if (!UUID.test(sessionId) || !validMessageId(messageId) || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || !text.endsWith("\n")) return null;
  const nodes = new Map<string, RecordValue>();
  let head: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: RecordValue;
    try { entry = object(JSON.parse(line)); } catch { return null; }
    if (entry.sessionId !== sessionId || entry.isSidechain === true || !conversationTypes.has(String(entry.type))) continue;
    if (typeof entry.uuid !== "string" || !UUID.test(entry.uuid) || !(entry.parentUuid === null || typeof entry.parentUuid === "string" && UUID.test(entry.parentUuid))) return null;
    if (nodes.has(entry.uuid)) return null;
    nodes.set(entry.uuid, entry);
    head = entry.uuid;
  }
  const seen = new Set<string>();
  let error: RecordValue | undefined;
  while (head !== null) {
    if (seen.has(head)) return null;
    seen.add(head);
    const entry = nodes.get(head);
    if (!entry) return null; // Truncated or missing parent before a real user anchor.
    const at = timestamp(entry.timestamp);
    if (!Number.isFinite(at) || at > endedAt) return null;
    if (!error) {
      if (entry.type === "user") return null; // A newer input wins, including a tool result.
      if (entry.type === "assistant") {
        if (object(entry.message).id !== messageId || entry.isApiErrorMessage !== true || entry.error !== "rate_limit" ||
            entry.apiError !== undefined && entry.apiError !== "usage_limit_reached") return null;
        error = entry;
      }
    } else if (entry.type === "user") {
      const message = object(entry.message);
      if (message.role !== "user") return null;
      const content = message.content;
      const onlyToolResults = Array.isArray(content) && content.length > 0 && content.every(block => object(block).type === "tool_result");
      if (!onlyToolResults && entry.isMeta !== true) {
        // The terminal assistant ID is an exact turn anchor. Paseo replaces user
        // IDs with client IDs, but preserves assistant IDs. Hook delivery may lag
        // the native prompt/error; do not substitute a broad clock tolerance.
        if (!(typeof content === "string" || Array.isArray(content)) || at > timestamp(error.timestamp)) return null;
        return { errorId: error.uuid as string, userId: head };
      }
    }
    head = entry.parentUuid as string | null;
  }
  return null;
}

/** Bounded read of only the exact bound session. Profile projects symlinks are
 * expected, but the final JSONL must be a regular, unchanged file. No content,
 * credential, prompt or path is returned or persisted by this reader. */
export async function readClaudeQuota(input: ClaudeQuotaInput): Promise<ClaudeQuotaEvidence | null> {
  if (!UUID.test(input.sessionId) || !validMessageId(input.messageId) || !isAbsolute(input.configDir) || !isAbsolute(input.cwd)) return null;
  try {
    const cwd = await realpath(input.cwd);
    const path = join(input.configDir, "projects", claudeProjectName(cwd), `${input.sessionId}.jsonl`);
    const link = await lstat(path);
    if (!link.isFile() || link.isSymbolicLink()) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.ino !== link.ino || before.dev !== link.dev) return null;
      const offset = Math.max(0, before.size - MAX_BYTES);
      const buffer = Buffer.alloc(Math.min(before.size, MAX_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const after = await file.stat();
      const current = await lstat(path);
      if (bytesRead !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          current.ino !== before.ino || current.dev !== before.dev || !current.isFile() || current.size !== before.size || current.mtimeMs !== before.mtimeMs) return null;
      const start = offset > 0 ? buffer.indexOf(10) + 1 : 0;
      if (offset > 0 && start === 0) return null;
      return parseClaudeQuota(buffer.subarray(start).toString("utf8"), input);
    } finally { await file.close(); }
  } catch { return null; }
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}
