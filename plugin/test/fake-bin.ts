import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * A program a test puts on PATH for the plugin to start, written once as Node and installed in the form this platform
 * runs: a script with the executable bit where there is one, and on Windows a batch file, which is what the plugin's
 * own `commandIn` looks for there and starts through a shell. Windows has no executable bit and no shebang.
 */
export function fakeBin(dir: string, name: string, body: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, body.endsWith("\n") ? body : `${body}\n`);
  if (WINDOWS) {
    const batch = join(dir, `${name}.cmd`);
    writeFileSync(batch, `@"${process.execPath}" "${script}" %*\r\n`);
    return batch;
  }
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The files `fakeBin` leaves for one program, for a test that asserts over what a directory holds. */
export const fakeBinFiles = (name: string) => (WINDOWS ? [`${name}.mjs`, `${name}.cmd`] : [`${name}.mjs`, name]);
