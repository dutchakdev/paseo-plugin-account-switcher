import { randomUUID } from "node:crypto";
import type { PaseoApi } from "./paseo-api";
import { ACCOUNT_NOTE_KIND, ACCOUNT_NOTE_VERSION, type AccountNote } from "../shared/timeline";

/** Records the agent's account in its timeline. A host that refuses the row never fails the switch itself. */
export async function appendAccountNote(paseo: PaseoApi, agentId: string, note: AccountNote): Promise<void> {
  try {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `${ACCOUNT_NOTE_KIND}-${randomUUID()}`, kind: ACCOUNT_NOTE_KIND, version: ACCOUNT_NOTE_VERSION, data: note });
  } catch (error) {
    console.error(`Could not add the account note to agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
