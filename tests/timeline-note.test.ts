import { describe, expect, it } from "vitest";
import { AccountNoteSchema, noteText } from "../shared/timeline";

describe("account notes in the chat timeline", () => {
  it("describes a switch the user applied", () => {
    expect(noteText({ kind: "switched", from: "Work", to: "Second", reason: null })).toBe("Account switched from Work to Second.");
    expect(noteText({ kind: "switched", from: null, to: "Second", reason: null })).toBe("Account switched to Second.");
  });
  it("says why a new agent did not start on the default", () => {
    expect(noteText({ kind: "started", from: "Work", to: "Second", reason: "exhausted" })).toBe("Starting on Second: the default Work has used up a limit.");
    expect(noteText({ kind: "started", from: "Work", to: "Second", reason: "model" })).toBe("Starting on Second: the default Work's plan does not offer this agent's model.");
    expect(noteText({ kind: "started", from: "Work", to: "Second", reason: "sign-in" })).toBe("Starting on Second: the default Work needs sign-in.");
    expect(noteText({ kind: "started", from: "Work", to: "Second", reason: "unverified" })).toBe("Starting on Second: the default Work could not be checked.");
  });
  it("rejects data from another shape rather than rendering it", () => {
    expect(AccountNoteSchema.safeParse({ kind: "switched", to: "Second" }).success).toBe(false);
  });
});
