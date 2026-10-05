import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Removed when the test process exits; on Windows named in full, as git names it, where TEMP holds an 8.3 short name. */
export function tempDir(prefix = "sw2-test-"): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  const dir = process.platform === "win32" ? realpathSync.native(created) : created;
  made.push(dir);
  return dir;
}

/** A home of its own for this process and all it spawns: POSIX reads HOME, Windows reads USERPROFILE. */
export function ownHome(prefix = "sw2-home-"): string {
  const dir = tempDir(prefix);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}
