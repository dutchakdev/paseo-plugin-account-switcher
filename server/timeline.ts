import { randomUUID } from "node:crypto";
import type { PaseoApi } from "./paseo-api";
import { ACCOUNT_NOTE_KIND, ACCOUNT_NOTE_VERSION, type AccountNote } from "../shared/timeline";
import { FAILOVER_KIND, FAILOVER_VERSION, type FailoverRow } from "../shared/failover";

/** Records the agent's account in its timeline. A host that refuses the row never fails the switch itself. */
export async function appendAccountNote(paseo: PaseoApi, agentId: string, note: AccountNote): Promise<void> {
  try {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `${ACCOUNT_NOTE_KIND}-${randomUUID()}`, kind: ACCOUNT_NOTE_KIND, version: ACCOUNT_NOTE_VERSION, data: note });
  } catch (error) {
    console.error(`Could not add the account note to agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Adds the failover row, or replaces it: the row keeps its id from the offer to the outcome. Best effort, like the notes. */
export async function appendFailoverRow(paseo: PaseoApi, agentId: string, row: FailoverRow): Promise<void> {
  try {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: row.rowId, kind: FAILOVER_KIND, version: FAILOVER_VERSION, data: row });
  } catch (error) {
    console.error(`Could not update the account failover row for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
