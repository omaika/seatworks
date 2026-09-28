import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { test } from "node:test";
import { executableIn, pathDirs } from "../server/core/paths.ts";

/** What test/setup.ts promises every test: a home of its own, on whatever platform the suite runs. */
test("a test's home is its own, for it, for the platform's own home API and for what it spawns", () => {
  const own = process.env.HOME;
  assert.ok(own, "HOME is unset");
  assert.equal(process.env.USERPROFILE, own, "USERPROFILE points elsewhere, so Windows reads the owner's profile");
  assert.equal(homedir(), own);
  const spawned = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], {
    encoding: "utf-8",
  });
  assert.equal(spawned, own);
});

/** The prepend is a third of the suite's time; on Windows the binary it looks for carries an extension. */
test("git's own binary is the first one the tests and all they run find", () => {
  const first = pathDirs()[0] ?? "";
  assert.ok(executableIn([first], "git"), `no git in the first PATH entry: ${first}`);
  assert.equal(first, execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim());
});
