import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandIn, deskSocket, executableIn } from "../../server/core/paths.ts";
import { tempDir } from "../tempdir.ts";

/**
 * Runs `what` with this process saying it is `platform`: these functions read `process.platform` on every call, so both
 * arms are reachable whichever machine the suite runs on. What Windows does with its own separators and ACLs is not.
 */
function saying(platform: string, what: () => void): void {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  const pathext = process.env.PATHEXT;
  Object.defineProperty(process, "platform", { ...was, value: platform });
  if (platform === "win32") process.env.PATHEXT = ".EXE;.CMD";
  try {
    what();
  } finally {
    Object.defineProperty(process, "platform", was);
    if (pathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = pathext;
  }
}

function executable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "");
  chmodSync(file, 0o755);
  return file;
}

test("the desk's line is a socket file on macOS and Linux, and a named pipe named for its state root on Windows", () => {
  const one = tempDir("sw2-pipe-one-");
  const two = tempDir("sw2-pipe-two-");

  saying("darwin", () => assert.equal(deskSocket(one), join(one, "desk.sock"), "a file beside the state it keeps"));

  saying("win32", () => {
    const pipe = deskSocket(one);
    assert.match(
      pipe,
      /^\\\\\.\\pipe\\seatworks-[0-9a-f]{16}$/,
      "Windows has no socket files: a pipe name, no path in it",
    );
    assert.equal(deskSocket(one), pipe, "the same state root is the same pipe, so a seat and the desk meet");
    assert.notEqual(deskSocket(two), pipe, "another state root is another pipe, so two desks do not collide");
  });
});

test("a command is found and started as the platform finds and starts it: bare on macOS and Linux, by PATHEXT on Windows", () => {
  const dir = tempDir("sw2-pathext-");
  const exe = executable(dir, "git.EXE");
  const cmd = executable(dir, "node.CMD");

  saying("darwin", () => {
    assert.equal(executableIn([dir], "git"), undefined, "no extension is added off Windows");
    assert.deepEqual(commandIn([dir], "node.CMD"), { file: cmd, shell: false }, "and no shell runs it");
  });

  saying("win32", () => {
    assert.equal(executableIn([dir], "git"), exe, "a bare name is tried with each extension PATHEXT names");
    assert.equal(executableIn([dir], "git.EXE"), exe, "a name with an extension of its own is left alone");
    assert.equal(executableIn([dir], "node"), cmd, "in PATHEXT's order, whichever extension is there");
    assert.deepEqual(
      commandIn([dir], "node"),
      { file: `"${cmd}"`, shell: true },
      "a .cmd, which npm installs a command as, only a shell starts, its path quoted against a space in it",
    );
    assert.deepEqual(commandIn([dir], "git"), { file: exe, shell: false }, "a real executable is started directly");
    assert.deepEqual(
      commandIn([dir], "missing"),
      { file: "missing", shell: false },
      "and a name nowhere on PATH as it is",
    );
  });
});
