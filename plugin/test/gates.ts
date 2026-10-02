import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tempdir.ts";

const RUNNER = fileURLToPath(new URL("./gate-run.ts", import.meta.url));

/** A word a gate command holds, as both shells read one: double quotes are all cmd.exe and sh agree on. */
const quoted = (word: string) => `"${word}"`;

/**
 * A gate command that runs `step` of test/gate-run.ts. The plugin starts a gate through the platform's own shell, so a
 * command written for one of them says nothing on the other; this says the same to both.
 */
export const gateStep = (...step: string[]) => [process.execPath, RUNNER, ...step].map(quoted).join(" ");

/** Both shells stop a command line at the first word that fails, and `exit` leaves them with that code. */
export const GATE_PASSES = "exit 0";
export const GATE_FAILS = "exit 1";

/** What `command` matches as itself inside a bigger pattern. */
export const escaped = (command: string) => command.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A gate held where the test can see it has started and let go when the test says, however it ends; `arm` holds the next run. */
export function heldGate(t: Pick<TestContext, "after" | "signal">) {
  const dir = tempDir("sw2-gate-");
  const [reached, open] = [join(dir, "reached"), join(dir, "open")];
  const release = () => writeFileSync(open, "");
  const arm = () => {
    rmSync(open, { force: true });
    rmSync(reached, { force: true });
  };
  t.after(release);
  return {
    command: gateStep("held", reached, open),
    release,
    arm,
    running: () => existsSync(reached),
    signal: t.signal,
  };
}

/**
 * Waits until `call` is held in `gate`, however long load makes that take; fails with its reply if it ends first. The
 * test's end, by its timeout too, stops the wait, so a gate that never runs leaves nothing polling.
 */
export async function gateReached(
  gate: { running: () => boolean; signal: AbortSignal },
  call: Promise<{ text: string }>,
) {
  const ended = call.then((reply) => reply.text);
  while (!gate.running()) {
    const text = await Promise.race([ended, sleep(20, undefined, { signal: gate.signal })]);
    assert.equal(text, undefined, "the call ended without being held in its gate");
  }
}
