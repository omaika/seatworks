import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";

/**
 * Takes read off `path` for this account the way the platform does it, and hands back what gives it again: a mode where
 * there is one, and on Windows a deny on its access list, which is what Node's chmod cannot reach there.
 */
export function noRead(path: string): () => void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o000);
    return () => chmodSync(path, 0o700);
  }
  const icacls = (...args: string[]) => execFileSync("icacls", [path, ...args], { encoding: "utf-8" });
  icacls("/deny", "*S-1-1-0:(RX)");
  return () => void icacls("/remove:d", "*S-1-1-0");
}
