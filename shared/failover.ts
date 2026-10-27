import { z } from "zod";

/** A plugin row in an agent's timeline after a turn failed on a used-up account: the offer to switch, then its outcome. */
export const FAILOVER_KIND = "account-failover";
export const FAILOVER_VERSION = 1;

export const FailoverRowSchema = z.object({
  // The timeline item's own id. A renderer is not told it, and the button needs it to update this row.
  rowId: z.string(),
  // offered: a button switches; none: no account has room; switching: in progress;
  // switched / auto: done by the button / automatically; failed: `error` says why.
  state: z.enum(["offered", "none", "switching", "switched", "auto", "failed"]),
  from: z.string(),
  // The account `from` names. The button's switch is refused once the agent runs on another; rows from before this
  // field skip that check.
  fromId: z.string().optional(),
  to: z.string().nullable(),
  toId: z.string().nullable(),
  // When the account that ran out is usable again; null when the provider gave no time.
  resetsAt: z.string().nullable(),
  error: z.string().nullable(),
  // false: the switch did not ask the agent to continue, so the user's next message runs on `to`. Rows from before
  // this field always asked.
  resumes: z.boolean().optional(),
});
export type FailoverRow = z.infer<typeof FailoverRowSchema>;

/** The row's sentence. `formatTime` turns the reset time into a local one, so the text stays testable. */
export function failoverText(row: FailoverRow, formatTime: (value: string) => string): string {
  const used = `${row.from}'s limit is used up${row.resetsAt ? ` until ${formatTime(row.resetsAt)}` : ""}.`;
  const to = row.to ?? "another account";
  switch (row.state) {
    case "offered": return used;
    case "none": return `${used} No other account has room.`;
    case "switching": return `Switching from ${row.from} to ${to}…`;
    case "switched": return `Switched from ${row.from} to ${to}.`;
    case "auto": return `Switched automatically from ${row.from} to ${to}.${row.resumes === false ? ` Your next message runs on ${to}.` : ""}`;
    case "failed": return `Could not switch to ${to}: ${row.error ?? "the switch failed."}`;
  }
}

/** The row's button: only an open offer has one. */
export function failoverAction(row: FailoverRow): { label: string; accountId: string } | null {
  return row.state === "offered" && row.to && row.toId ? { label: `Switch to ${row.to} and continue`, accountId: row.toId } : null;
}
