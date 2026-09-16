import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readClaudeCredentials, type ClaudeDependencies } from "./claude";
import { UsageError, type QuotaAccount } from "./index";
import { credentialHash } from "./credential-hash";

/** Hashes only the selected provider profile. Never returns credential contents.
 * Keep the previous version on `unavailable`; only `absent` establishes auth loss.
 */
export async function readCredentialVersion(account: QuotaAccount, dependencies: ClaudeDependencies = {}): Promise<string> {
  try {
    const resolved=account.provider==="claude" ? await readClaudeCredentials(account,dependencies) : {source:"file",raw:await (dependencies.readFile??(path=>readFile(path,"utf8")))(join(account.home,"auth.json"))};
    return credentialHash(resolved.source,resolved.raw);
  } catch(error) {
    if(error instanceof UsageError)return error.status==="needs_auth"?"absent":"unavailable";
    return ["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code??"")?"absent":"unavailable";
  }
}
