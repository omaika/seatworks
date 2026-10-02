import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runGate } from "../../server/core/gate.ts";
import { gateStep } from "../gates.ts";
import { tempDir } from "../tempdir.ts";

/** Whether `pid` still runs: a leftover ends either killed by the gate or after its late write, never on a timer. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the gate reports exit, output tail and timeouts", { timeout: 30_000 }, async (t) => {
  const dir = tempDir("sw2-gate-");
  const pass = await runGate("echo ok", dir, join(dir, "g1.log"), 10_000);
  assert.equal(pass.ok, true);
  assert.match(pass.tail, /ok/);
  const fail = await runGate(gateStep("complain", "broken", "3"), dir, join(dir, "g2.log"), 10_000);
  assert.deepEqual([fail.ok, fail.code], [false, 3]);
  const slow = await runGate(gateStep("sleep", "5"), dir, join(dir, "g3.log"), 300);
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
  assert.equal(existsSync(join(dir, "g3.log")), true);

  // A passing suite that leaves something running, held until the test lets it go: the verdict is the command's own exit,
  // not the output's end. The limit is past the test's own timeout, so a gate waiting for it never answers, and the
  // test's end stops it.
  const [open, pidFile] = [join(dir, "open"), join(dir, "left.pid")];
  t.after(() => writeFileSync(open, ""));
  const leftBehind = await runGate(
    gateStep("leaves", "ok 1 - everything passes", join(dir, "g4.log"), open, pidFile),
    dir,
    join(dir, "g4.log"),
    10 * 60_000,
    t.signal,
  );
  assert.deepEqual([leftBehind.ok, leftBehind.code, leftBehind.timedOut], [true, 0, false]);
  assert.match(leftBehind.tail, /everything passes/);
  // What it left running is stopped with the verdict; nothing else would stop it writing into the log once let go. Windows
  // stops no leftover of a gate that ran to its own end: `finish` kills the tree from the root, and by then the root,
  // cmd.exe, has exited and its descendants are nobody's tree. Node offers no Job Object, whose kill-on-close would hold
  // them, and a snapshot of the root's descendants taken while it lives misses whatever it spawns after the snapshot.
  writeFileSync(open, "");
  if (process.platform !== "win32") {
    const pid = Number(readFileSync(pidFile, "utf-8"));
    while (alive(pid)) await sleep(20, undefined, { signal: t.signal });
    assert.doesNotMatch(
      readFileSync(join(dir, "g4.log"), "utf-8"),
      /late 42/,
      "the log line the command itself echoes is not a leftover writing",
    );
  }

  // The tail is read from the end, since reading the whole log back throws past half a gigabyte.
  const noisy = await runGate(
    gateStep("noisy", "3000000", "the last line is the reason"),
    dir,
    join(dir, "g5.log"),
    20_000,
  );
  assert.equal(noisy.code, 1);
  assert.match(
    noisy.tail,
    /the last line is the reason/,
    "the reason is at the end, which is the part that has to survive",
  );
  assert.equal(noisy.tail.length <= 3000, true);
});
