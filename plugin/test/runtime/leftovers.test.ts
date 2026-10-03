import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mock, test } from "node:test";
import { harness } from "./harness.ts";
import { until } from "../gates.ts";

const SEAT = "sw2-lead-claude";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A harmless process asleep for minutes, on its own so that it outlives whoever started it, carrying `mark` if given. */
function sleeper(mark?: string, argument?: string): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PASEO_AGENT_ID;
  if (mark) env.PASEO_AGENT_ID = mark;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", ...(argument ? [argument] : [])], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid!;
}

test("archiving a seat stops what its commands left running, and nothing else", { timeout: 30_000 }, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const h = harness();
  const mine = sleeper("seat-1");
  const another = sleeper("seat-2");
  const unmarked = sleeper();
  const named = sleeper(undefined, "PASEO_AGENT_ID=seat-1");
  const notSeat = sleeper("agent-x");
  t.after(() => {
    for (const pid of [mine, another, unmarked, named, notSeat]) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.ok([mine, another, unmarked, named, notSeat].every(alive));

  await h.runtime.archived({ id: "agent-x", provider: "claude", cwd: h.root });
  await h.runtime.archived({ id: "seat-1", provider: SEAT, cwd: h.root });
  mock.timers.tick(60_000);

  await until(t, () => !alive(mine), "the archived seat's leftover process stopped");
  assert.ok(alive(another), "another seat's process still runs");
  assert.ok(alive(unmarked), "a process with no mark still runs");
  assert.ok(alive(named), "a process with the mark only in its arguments still runs");
  assert.ok(alive(notSeat), "the process of an agent that is not a seat still runs");
});

test(
  "a seat Paseo runs again before the sweep keeps what carries its id, but one it only opens to show its history does not",
  { timeout: 30_000 },
  async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const h = harness();
    const reopened = sleeper("seat-3");
    const archived = sleeper("seat-4");
    const looked = sleeper("seat-5");
    t.after(() => {
      for (const pid of [reopened, archived, looked]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: "seat-3", provider: SEAT, cwd: h.root });
    await h.runtime.archived({ id: "seat-4", provider: SEAT, cwd: h.root });
    await h.runtime.archived({ id: "seat-5", provider: SEAT, cwd: h.root });
    const open = (agentId: string, purpose: "interactive" | "history") =>
      h.runtime.sessionOpen({ agentId, reason: "resume", purpose, provider: SEAT, cwd: h.root, env: {} });
    open("seat-3", "interactive");
    open("seat-5", "history");
    mock.timers.tick(60_000);

    // Both sweeps were due together, so once the other seat's is done, the reopened one's would have been.
    await until(
      t,
      () => !alive(archived) && !alive(looked),
      "the seats not opened again had their leftover processes stopped",
    );
    assert.ok(alive(reopened), "the seat that opened again keeps its process");
  },
);
