import { z } from "zod";

/** A plugin row in an agent's timeline recording which account it runs on and why. */
export const ACCOUNT_NOTE_KIND = "account-note";
export const ACCOUNT_NOTE_VERSION = 1;

export const AccountNoteSchema = z.object({
  kind: z.enum(["switched", "started"]),
  from: z.string().nullable(),
  to: z.string(),
  // Why a new agent did not start on the default; null for a switch the user applied.
  reason: z.enum(["exhausted", "model", "sign-in"]).nullable(),
});
export type AccountNote = z.infer<typeof AccountNoteSchema>;

const why: Record<NonNullable<AccountNote["reason"]>, (from: string) => string> = {
  exhausted: (from) => `the default ${from} has used up a limit`,
  model: (from) => `the default ${from}'s plan does not offer this agent's model`,
  "sign-in": (from) => `the default ${from} needs sign-in`,
};

export function noteText(note: AccountNote): string {
  if (note.kind === "switched") return note.from ? `Account switched from ${note.from} to ${note.to}.` : `Account switched to ${note.to}.`;
  return note.reason && note.from ? `Started on ${note.to}: ${why[note.reason](note.from)}.` : `Started on ${note.to}.`;
}
