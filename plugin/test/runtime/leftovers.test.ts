import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mock, test, type TestContext } from "node:test";
import { harness } from "./harness.ts";
import { reported } from "../console.ts";
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

/** Waits for `stopped`, and fails at once with what the sweep reported if it could not list processes. */
function stopsOrReports(t: TestContext, said: () => string, stopped: () => boolean, what: string) {
  return until(
    t,
    () => {
      if (said()) throw new Error(`the sweep reported instead of ${what}:\n${said()}`);
      return stopped();
    },
    what,
  );
}

/** A harmless process asleep for minutes, on its own so that it outlives whoever started it, carrying `mark` if given. */
function sleeper(mark?: string, argument?: string, other?: string): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PASEO_AGENT_ID;
  if (other) env.OTHER = other;
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
  const said = reported(t);
  const h = harness();
  const mine = sleeper("seat-1");
  const another = sleeper("seat-2");
  const unmarked = sleeper();
  const named = sleeper(undefined, "PASEO_AGENT_ID=seat-1");
  const notSeat = sleeper("agent-x");
  const lookalike = sleeper(undefined, undefined, "x PASEO_AGENT_ID=seat-1 y");
  t.after(() => {
    for (const pid of [mine, another, unmarked, named, notSeat, lookalike])
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.ok([mine, another, unmarked, named, notSeat, lookalike].every(alive));

  await h.runtime.archived({ id: "agent-x", provider: "claude", cwd: h.root });
  await h.runtime.archived({ id: "seat-1", provider: SEAT, cwd: h.root });
  mock.timers.tick(60_000);

  await stopsOrReports(t, said, () => !alive(mine), "the archived seat's leftover process stopped");
  assert.ok(alive(another), "another seat's process still runs");
  assert.ok(alive(unmarked), "a process with no mark still runs");
  assert.ok(alive(named), "a process with the mark only in its arguments still runs");
  assert.ok(alive(notSeat), "the process of an agent that is not a seat still runs");
  assert.ok(alive(lookalike), "a process whose other variable only contains the mark still runs");
});

test(
  "at start, what seats archived while the plugin was away left running is stopped, and what a live seat or a non-seat agent runs is not",
  { timeout: 30_000 },
  async (t) => {
    const said = reported(t);
    const h = harness();
    const archivedSeat = h.add(SEAT, h.root, "archived seat");
    const liveSeat = h.add(SEAT, h.root, "live seat");
    const archivedOther = h.add("claude", h.root, "archived agent that is no seat");
    h.agents.get(archivedSeat)!.archivedAt = new Date().toISOString();
    h.agents.get(archivedOther)!.archivedAt = new Date().toISOString();
    const left = sleeper(archivedSeat);
    const live = sleeper(liveSeat);
    const other = sleeper(archivedOther);
    t.after(() => {
      for (const pid of [left, live, other]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.prepare();
    await stopsOrReports(t, said, () => !alive(left), "the archived seat's leftover process stopped at start");
    assert.ok(alive(live), "a live seat's process still runs");
    assert.ok(alive(other), "the process of an archived agent that is not a seat still runs");
  },
);

/** The next listing of Paseo's agents that takes in the archived is held once made, with that listing as it was then, until `release`. */
function heldListing(h: ReturnType<typeof harness>) {
  const agents = h.paseo as { agents: { list: (options?: unknown) => Promise<unknown> } };
  const list = agents.agents.list;
  let listed = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => (listed = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  agents.agents.list = async (options?: unknown) => {
    const page = await list(options);
    if (!(options as { filter?: { includeArchived?: boolean } }).filter?.includeArchived) return page;
    agents.agents.list = list;
    listed();
    await held;
    return page;
  };
  return { reached, release };
}

test(
  "a seat Paseo opens again before or while the sweep at start runs keeps what carries its id",
  { timeout: 30_000 },
  async (t) => {
    const said = reported(t);
    const h = harness();
    const before = h.add(SEAT, h.root, "opened before the sweep");
    const during = h.add(SEAT, h.root, "opened while the sweep lists");
    const gone = h.add(SEAT, h.root, "stays archived");
    for (const id of [before, during, gone]) h.agents.get(id)!.archivedAt = new Date().toISOString();
    const kept = [sleeper(before), sleeper(during)];
    const left = sleeper(gone);
    t.after(() => {
      for (const pid of [...kept, left]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    const open = (agentId: string) =>
      h.runtime.sessionOpen({
        agentId,
        reason: "resume",
        purpose: "interactive",
        provider: SEAT,
        cwd: h.root,
        env: {},
      });

    open(before);
    const listing = heldListing(h);
    const prepared = h.runtime.prepare();
    await listing.reached;
    open(during);
    listing.release();
    await prepared;

    await stopsOrReports(t, said, () => !alive(left), "the seat that stayed archived had its leftover process stopped");
    assert.ok(
      kept.every(alive),
      "the seats opened again, before the listing and after it, keep their processes: the sweep that stopped the other's is over",
    );
  },
);

const WORKER = fileURLToPath(new URL("./sweep-worker.ts", import.meta.url));

/** An idle process of a kind macOS shows no environment of, started by `script` in a session of its own, with the pids it printed. */
async function restricted<N extends number[]>(mark: string | undefined, script: string): Promise<N> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PASEO_AGENT_ID;
  if (mark) env.PASEO_AGENT_ID = mark;
  const child = spawn(process.execPath, ["-e", script], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  child.unref();
  const printed = await new Promise<string>((resolve) =>
    child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())),
  );
  child.stdout.destroy();
  return [child.pid!, ...printed.trim().split(" ").map(Number)] as N;
}

const SLEEP = `spawn("/bin/sleep", ["300"], { stdio: "ignore", detached: DETACHED })`;
const IDLE = "setTimeout(() => {}, 300000)";

test(
  "on macOS, archiving a seat stops the processes of its commands the kernel shows no environment of, by whose they are, and no one else's",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const said = reported(t);
    const h = harness();
    // A marked process whose child is a /bin/sleep of a session of its own: found by its parent.
    const [parent, child] = await restricted<[number, number]>(
      "seat-1",
      `const { spawn } = require("child_process"); const c = ${SLEEP.replace("DETACHED", "true")}; console.log(c.pid); ${IDLE}`,
    );
    // A marked process leads a session of its own, and a /bin/sleep in it has lost its parent: found by the session whose leader is marked.
    const [leader, sibling] = await restricted<[number, number]>(
      "seat-1",
      `const { spawn } = require("child_process");
      spawn(process.execPath, ["-e", 'const { spawn } = require("child_process"); console.log(${SLEEP.replace("DETACHED", "false")}.pid); process.exit(0)'], { stdio: ["ignore", "inherit", "ignore"] });
      ${IDLE}`,
    );
    const [elsewhere, other] = await restricted<[number, number]>(
      "seat-2",
      `const { spawn } = require("child_process"); const c = ${SLEEP.replace("DETACHED", "true")}; console.log(c.pid); ${IDLE}`,
    );
    const [bystander, alone] = await restricted<[number, number]>(
      undefined,
      `const { spawn } = require("child_process"); console.log(${SLEEP.replace("DETACHED", "true")}.pid); ${IDLE}`,
    );
    const all = [parent, child, leader, sibling, elsewhere, other, bystander, alone];
    t.after(() => {
      for (const pid of all) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.ok(all.every(alive));

    await h.runtime.archived({ id: "seat-1", provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);

    await stopsOrReports(
      t,
      said,
      () => !alive(child),
      "the /bin/sleep a marked process started stopped: the kernel shows its environment to no one, so only its parent says whose it is",
    );
    await stopsOrReports(
      t,
      said,
      () => !alive(sibling),
      "the /bin/sleep in the session a marked process leads stopped: only the session says whose it is",
    );
    assert.ok(!alive(parent) && !alive(leader), "the marked processes stopped");
    assert.ok(alive(elsewhere) && alive(other), "another seat's process and its /bin/sleep still run");
    assert.ok(alive(alone), "a /bin/sleep of no seat, in a session of its own, still runs");
  },
);

test(
  "a sweep never stops the process that started the plugin, nor what carries the mark the plugin itself carries, though it is asked to",
  { timeout: 30_000 },
  async (t) => {
    const sibling = sleeper("seat-6");
    const left = sleeper("seat-7");
    t.after(() => {
      for (const pid of [sibling, left]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    // The daemon stands in as a marked process that starts the plugin's worker, which inherits its environment.
    const daemon = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process"); const w = spawn(process.execPath, [${JSON.stringify(WORKER)}, "seat-6", "seat-7"], { stdio: "inherit" }); w.on("exit", () => setTimeout(() => process.exit(0), 100)); setTimeout(() => {}, 300000)`,
      ],
      { env: { ...process.env, PASEO_AGENT_ID: "seat-6" }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    t.after(() => daemon.kill("SIGKILL"));
    let out = "";
    daemon.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => daemon.on("exit", resolve));
    assert.ok(out.includes(`stopped ${left}\n`), `the worker stopped the other seat's leftover process: ${out}`);
    assert.ok(alive(sibling), "what carries the daemon's own mark, though asked about, still runs");
    assert.ok(!out.includes(`stopped ${daemon.pid}\n`), "the worker's parent was not stopped");
    assert.equal(daemon.signalCode, null, "the daemon ended by itself, not by a signal");
  },
);

/** Starts `script` in a session of its own with `mark` and waits for it to print a line matching `done`, whose groups are returned. */
async function printing(mark: string, script: string, done: RegExp): Promise<{ pid: number; groups: string[] }> {
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, PASEO_AGENT_ID: mark },
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  child.unref();
  let out = "";
  const groups = await new Promise<string[]>((resolve) =>
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = done.exec(out);
      if (found) resolve(found.slice(1));
    }),
  );
  child.stdout.destroy();
  return { pid: child.pid!, groups };
}

const WITHOUT_MARK = "const env = { ...process.env }; delete env.PASEO_AGENT_ID;";

test(
  "a sweep never stops the plugin's daemon, nor what the daemon started, when a process above the daemon carries the mark it sweeps",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    // Above the stand-in daemon (D) is a process carrying seat-x; D starts another process (C) and the plugin's worker.
    const daemon = `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      const c = spawn(process.execPath, ["-e", "${IDLE}"], { env, stdio: "ignore" });
      const w = spawn(process.execPath, [${JSON.stringify(WORKER)}, "seat-x"], { env, stdio: ["ignore", "inherit", "inherit"] });
      w.on("exit", () => console.log("done", process.pid, c.pid)); ${IDLE}`;
    const above = await printing(
      "seat-x",
      `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      spawn(process.execPath, ["-e", ${JSON.stringify(daemon)}], { env, stdio: ["ignore", "inherit", "inherit"] }); ${IDLE}`,
      /((?:stopped \d+\n)*)done (\d+) (\d+)/,
    );
    const [stopped, d, c] = above.groups as [string, string, string];
    t.after(() => {
      for (const pid of [above.pid, Number(d), Number(c)]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.equal(stopped, "", "the worker stopped nothing");
    assert.ok(alive(Number(d)), "the daemon still runs");
    assert.ok(alive(Number(c)), "what else the daemon started still runs");
    assert.ok(alive(above.pid), "the process above the daemon, which carries the mark, still runs");
  },
);

test(
  "a sweep asked about the mark the plugin's daemon carries still never stops the daemon, which is the worker's parent",
  { timeout: 30_000 },
  async (t) => {
    const left = sleeper("seat-6");
    // The worker does not inherit the daemon's mark, so only being its parent spares the daemon.
    const daemon = await printing(
      "seat-6",
      `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      const w = spawn(process.execPath, [${JSON.stringify(WORKER)}, "seat-6"], { env, stdio: ["ignore", "inherit", "inherit"] });
      w.on("exit", () => console.log("done")); ${IDLE}`,
      /((?:stopped \d+\n)*)done/,
    );
    t.after(() => {
      for (const pid of [daemon.pid, left]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.ok(
      daemon.groups[0]!.includes(`stopped ${left}\n`),
      `the worker stopped the leftover process: ${daemon.groups[0]}`,
    );
    assert.ok(!daemon.groups[0]!.includes(`stopped ${daemon.pid}\n`), "the worker's parent was not stopped");
    assert.ok(alive(daemon.pid), "the daemon, which carries the mark, still runs");
  },
);

test(
  "on macOS, a sweep never stops what shares the session of the plugin and the daemon, though a marked process is in it",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const said = reported(t);
    const h = harness();
    // Neither is detached, so both are in this test's own session, which is the plugin's.
    const env = { ...process.env, PASEO_AGENT_ID: "seat-9" };
    const marked = spawn(process.execPath, ["-e", IDLE], { env, stdio: "ignore", windowsHide: true }).pid!;
    const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore", windowsHide: true }).pid!;
    t.after(() => {
      for (const pid of [marked, bystander]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: "seat-9", provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);

    await stopsOrReports(t, said, () => !alive(marked), "the marked process stopped");
    assert.ok(alive(bystander), "a process of no seat in the plugin's own session still runs");
  },
);

test(
  "on macOS, a session an old daemon left behind is not swept past the processes marked with an archived seat's id: a live seat's, the Human's shell and a bystander's keep running",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const said = reported(t);
    const h = harness();
    // The old daemon is gone; what it started stays in its session: an archived seat's process, a live seat's shell, no process of a live seat the kernel shows an environment of,
    // a node with an empty environment, the Human's shell with a command of its own, and a /bin/sleep of no seat.
    const [, archived, shell, empty, human, bystander] = await restricted<
      [number, number, number, number, number, number]
    >(
      undefined,
      `const { spawn } = require("child_process");
      const mark = (id) => spawn(process.execPath, ["-e", "${IDLE}"], { stdio: "ignore", env: { ...process.env, PASEO_AGENT_ID: id } });
      const a = mark("seat-archived");
      const z = spawn("/bin/zsh", ["-c", "/bin/sleep 300; :"], { stdio: "ignore", env: { ...process.env, PASEO_AGENT_ID: "seat-live" } });
      const e = spawn(process.execPath, ["-e", "${IDLE}"], { stdio: "ignore", env: {} });
      const u = spawn("/bin/zsh", ["-c", "/bin/sleep 300; :"], { stdio: "ignore" });
      const s = ${SLEEP.replace("DETACHED", "false")};
      console.log(a.pid, z.pid, e.pid, u.pid, s.pid); process.exit(0)`,
    );
    t.after(() => {
      for (const pid of [archived, shell, empty, human, bystander]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: "seat-archived", provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);

    await stopsOrReports(t, said, () => !alive(archived), "the archived seat's process stopped");
    assert.ok(alive(shell), "a live seat's shell, which the kernel shows no environment of, still runs");
    assert.ok(alive(empty), "a process with an empty environment, which the kernel does show, still runs");
    assert.ok(alive(human), "the Human's shell, whose command shares the session, still runs");
    assert.ok(alive(bystander), "a /bin/sleep of no seat in the same session still runs");
  },
);

test(
  "a seat Paseo runs again before the sweep keeps what carries its id, but one it only opens to show its history does not",
  { timeout: 30_000 },
  async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const said = reported(t);
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
    await stopsOrReports(
      t,
      said,
      () => !alive(archived) && !alive(looked),
      "the seats not opened again had their leftover processes stopped",
    );
    assert.ok(alive(reopened), "the seat that opened again keeps its process");
  },
);
