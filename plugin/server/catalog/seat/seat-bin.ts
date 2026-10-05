import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeConfigAtomic } from "../../core/config-file.ts";
import { executableIn, nodeBin, pathDirs, stateRoot } from "../../core/paths.ts";
import type { Kit } from "../kit/kit.ts";

const WIN = process.platform === "win32";

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/** A path as the script's own shell reads it: on Windows that shell is Git Bash, which takes a backslash for an escape. */
const scriptPath = (path: string) => quoted(WIN ? path.replaceAll("\\", "/") : path);
/** `text` as a batch file's `echo` prints it: cmd's own characters escaped, and `%` doubled. */
const echoed = (text: string) => text.replace(/[\^&|<>()]/g, "^$&").replaceAll("%", "%%");

/**
 * The git a seat's PATH finds past the shim: the shim's directory is skipped, since what is there is named git too. On
 * Windows only the .exe will do, since the shim starts it as a process, and a process cannot be a .cmd.
 */
function realGit(skip: string): string | undefined {
  return executableIn(
    pathDirs().filter((dir) => dir && dir !== skip),
    WIN ? "git.exe" : "git",
  );
}

/**
 * On Windows, the bash of Git for Windows that keeps a seat's PATH as given: the bash.exe in Git's bin folder puts Git's
 * own git first on PATH before it starts, past the shim, while usr/bin's is that same bash started directly.
 */
export function plainBash(root = stateRoot()): string | undefined {
  if (!WIN) return undefined;
  let dir = realGit(join(root, "bin"));
  for (let up = 0; dir && up < 4; up++) {
    dir = dirname(dir);
    const bash = join(dir, "usr", "bin", "bash.exe");
    if (existsSync(bash)) return bash;
  }
  return undefined;
}

/**
 * Writes the directory a seat's PATH starts at: a git that runs the kit's shim over the real git, and for each command the kit
 * refuses one that says why and fails. Nothing where this machine has no git.
 */
export function seatBin(kit: Kit, root = stateRoot()): string | undefined {
  const dir = join(root, "bin");
  const git = realGit(dir);
  if (!git) return undefined;
  const [node, shim] = [nodeBin(), join(kit.dir, "bin", "git-shim.mjs")];
  const commands: Record<string, { sh: string; cmd: string }> = {
    git: {
      sh: `#!/bin/sh\nexec ${scriptPath(node)} ${scriptPath(shim)} ${scriptPath(git)} "$@"\n`,
      cmd: `@echo off\r\n"${node}" "${shim}" "${git}" %*\r\n`,
    },
  };
  for (const [name, why] of Object.entries(kit.refused)) {
    const said = `${name}: refused: ${why}. Say what you need to whoever gave you the work.`;
    commands[name] = {
      sh: `#!/bin/sh\necho ${quoted(said)} >&2\nexit 1\n`,
      cmd: `@echo off\r\n>&2 echo ${echoed(said)}\r\nexit /b 1\r\n`,
    };
  }
  // Windows shells find the batch file; the Git Bash some agents run commands in finds the script. A git started as a
  // process rather than by a shell finds neither and runs the real git: to a bare name libuv appends .com and .exe
  // alone, and CreateProcess starts only such an image, so nothing but a program of the plugin's own could stand there.
  const wanted = Object.fromEntries(
    Object.entries(commands).flatMap(([name, { sh, cmd }]) =>
      WIN
        ? [
            [name, sh],
            [`${name}.cmd`, cmd],
          ]
        : [[name, sh]],
    ),
  );
  mkdirSync(dir, { recursive: true });
  // The directory is the plugin's alone: a command the kit no longer refuses must run again.
  for (const name of readdirSync(dir)) if (!(name in wanted)) rmSync(join(dir, name), { force: true });
  for (const [name, text] of Object.entries(wanted)) {
    const file = join(dir, name);
    if (!existsSync(file) || readFileSync(file, "utf-8") !== text) writeConfigAtomic(file, text, 0o755);
  }
  return dir;
}
