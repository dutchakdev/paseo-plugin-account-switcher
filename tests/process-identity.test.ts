import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseProcessStart, receiptProcessRuns } from "../server/process-identity";

describe("the start of a process, from ps", () => {
  it("reads what ps -o lstart= prints on macOS, trailing spaces included", () => {
    expect(parseProcessStart("Thu Aug 20 03:04:05 2026    \n")).toBe(new Date(2026, 7, 20, 3, 4, 5).getTime());
  });
  it("reads what ps -o lstart= prints on Linux", () => {
    expect(parseProcessStart("Sat Oct 31 20:04:51 2026\n")).toBe(new Date(2026, 9, 31, 20, 4, 51).getTime());
  });
  it("gives nothing usable for no output", () => {
    expect(parseProcessStart("")).toBeNaN();
  });
});

// These ask the real ps, so CI proves its options and output on macOS and Linux.
describe("the process a launch receipt names", () => {
  it("runs when its PID is alive and started before the receipt", async () => {
    await expect(receiptProcessRuns(process.pid, new Date().toISOString())).resolves.toBe(true);
  });
  it("does not run when nothing has its PID", async () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    await expect(receiptProcessRuns(pid, new Date().toISOString())).resolves.toBe(false);
  });
  it("does not run when its PID went to a process started after the receipt", async () => {
    await expect(receiptProcessRuns(process.pid, "2020-01-01T00:00:00.000Z")).resolves.toBe(false);
  });
  it("counts as running when the receipt's time cannot be read", async () => {
    await expect(receiptProcessRuns(process.pid, "not a time")).resolves.toBe(true);
    await expect(receiptProcessRuns(process.pid, undefined)).resolves.toBe(true);
  });
});
