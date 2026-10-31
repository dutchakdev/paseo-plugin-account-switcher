import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// ps gives a start to the second, and a CLI starts just before its launcher stamps the receipt.
const MARGIN_MS = 60_000;

/** Reads `ps -o lstart=`, local time such as "Sat Oct 31 20:04:51 2026". NaN for anything else. */
export function parseProcessStart(text: string): number {
  return Date.parse(text.trim());
}

/**
 * Whether the process a launch receipt names, by PID and the time the receipt was written, still runs.
 * The PID may since have gone to another process, after a reboot above all, so one that started after
 * the receipt is not that process. Anything unclear counts as running: a profile that may be in use stays held.
 */
export async function receiptProcessRuns(pid: number, writtenAt: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    return !(parseProcessStart(String(stdout)) > Date.parse(String(writtenAt)) + MARGIN_MS);
  } catch {
    return true;
  }
}
