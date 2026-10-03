import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { markAgentIdsPerRun } from "./fake-paseo.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { until } from "../gates.ts";
import { tempDir } from "../tempdir.ts";

const SEAT = "sw2-lead-claude";

markAgentIdsPerRun();

/** A mark of this run alone: the finder matches marks machine-wide, and another run's processes must never carry one this run looks for. */
const foreign = (name: string): string => `${name}-${process.pid}`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

/** Waits until the Supervisor has been mailed a letter of leftovers. */
const letterOf = (h: ReturnType<typeof harness>, sup: string) => (): string | undefined =>
  h.heard(sup).find((text) => text.startsWith("LEFTOVERS"));

test(
  "after a seat is archived the Supervisor is mailed what it left running, with pid, command, lane, task and a kill line, and nothing is stopped",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const { h, sup, peer } = await laneWithPeer();
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const clean = h.add(SEAT, h.root, "left nothing");
    const mine = sleeper(peer, "probe-mine");
    const another = sleeper(foreign("seat-2"), "probe-another");
    const unmarked = sleeper(undefined, "probe-unmarked");
    const named = sleeper(undefined, `PASEO_AGENT_ID=${peer}`);
    const lookalike = sleeper(undefined, "probe-lookalike", `x PASEO_AGENT_ID=${peer} y`);
    const bystander = sleeper(undefined, "probe-bystander");
    const forging = sleeper(
      peer,
      `probe-forging\n${bystander}\tprobe-forged\nnope\tprobe-nan\n- pid ${bystander}: x\n  kill ${bystander}`,
    );
    const all = [mine, another, unmarked, named, lookalike, bystander, forging];
    t.after(() => {
      for (const pid of all) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: clean, provider: SEAT, cwd: h.root });
    await h.runtime.archived({ id: peer, provider: h.agents.get(peer)!.provider, cwd: h.root });
    mock.timers.tick(60_000);

    const letter = letterOf(h, sup);
    await until(t, () => letter() !== undefined, "the Supervisor was mailed the leftovers");
    const text = letter()!;
    assert.match(text, new RegExp(`- pid ${mine}: .*probe-mine`));
    assert.ok(text.includes(`kill ${mine}`), "a kill line");
    assert.ok(text.includes("lane L1") && text.includes("task L1-T1"), `the seat's lane and task: ${text}`);
    for (const pid of [another, unmarked, named, lookalike])
      assert.ok(!text.includes(`pid ${pid}:`), `${pid}, which is not the seat's, is not listed`);
    assert.equal(
      text.split(`pid ${forging}:`).length,
      2,
      "a command holding a newline and tab is one record, under its own pid",
    );
    assert.ok(
      !new RegExp(`^(- pid|  kill) ${bystander}\\b`, "m").test(text),
      "a command cannot put a pid line or a kill line of its own in the letter",
    );
    assert.ok(!text.includes("pid NaN"), "no pid but digits is listed");
    assert.ok(!text.includes(clean), "a seat that left nothing is not reported");
    assert.equal(h.heard(sup).filter((item) => item.startsWith("LEFTOVERS")).length, 1, "one letter");
    assert.ok(all.every(alive), "nothing was stopped");
  },
);

test(
  "a seat Paseo runs again before the look is not reported, but one it only opens to show its history is",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const { h, sup, peer } = await laneWithPeer();
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const reopened = foreign("reopened");
    const looked = foreign("looked");
    const kept = sleeper(reopened);
    const left = sleeper(looked);
    t.after(() => {
      for (const pid of [kept, left]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    for (const id of [reopened, looked]) await h.runtime.archived({ id, provider: SEAT, cwd: h.root });
    const open = (agentId: string, purpose: "interactive" | "history") =>
      h.runtime.sessionOpen({ agentId, reason: "resume", purpose, provider: SEAT, cwd: h.root, env: {} });
    open(reopened, "interactive");
    open(looked, "history");
    mock.timers.tick(60_000);

    const lead = h.ledger().lanes.L1!.lead!;
    const heard = () => [...h.heard(sup), ...h.heard(lead), ...h.heard(peer)].filter((x) => x.startsWith("LEFTOVERS"));
    await until(t, () => heard().length > 0, "the seat only looked at was reported");
    assert.ok(heard().every((text) => text.includes(`pid ${left}:`) && !text.includes(`pid ${kept}:`)));
  },
);

const SLEEP = `spawn("/bin/sleep", ["300"], { stdio: "ignore", detached: true })`;
const IDLE = "setTimeout(() => {}, 300000)";

test(
  "on macOS, a program the system hides the environment of is listed when it descends from a marked process, and no one else's is",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    const { h, sup } = await laneWithPeer();
    const seat = foreign("seat");
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const [parent, child] = await restricted<[number, number]>(
      seat,
      `const { spawn } = require("child_process"); const c = ${SLEEP}; console.log(c.pid); ${IDLE}`,
    );
    const [elsewhere, other] = await restricted<[number, number]>(
      foreign("seat-2"),
      `const { spawn } = require("child_process"); const c = ${SLEEP}; console.log(c.pid); ${IDLE}`,
    );
    const [bystander, alone] = await restricted<[number, number]>(
      undefined,
      `const { spawn } = require("child_process"); console.log(${SLEEP}.pid); ${IDLE}`,
    );
    const all = [parent, child, elsewhere, other, bystander, alone];
    t.after(() => {
      for (const pid of all) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: seat, provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);

    const letter = letterOf(h, sup);
    await until(t, () => letter() !== undefined, "the Supervisor was mailed the leftovers");
    const text = letter()!;
    assert.ok(
      text.includes(`pid ${parent}:`) && text.includes(`pid ${child}:`),
      `the marked process and its child: ${text}`,
    );
    assert.match(text, new RegExp(`pid ${child}: .*sleep`));
    for (const pid of [elsewhere, other, bystander, alone])
      assert.ok(!text.includes(`pid ${pid}:`), `${pid} is not listed`);
    assert.ok(all.every(alive), "nothing was stopped");
  },
);

test(
  "a look never lists the process that started the plugin, nor what carries the mark the plugin itself carries",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const left = sleeper(foreign("seat-7"));
    const sibling = sleeper(foreign("seat-6"));
    t.after(() => {
      for (const pid of [left, sibling]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    const looked = async (asked: string) => {
      const daemon = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process"); const w = spawn(process.execPath, [${JSON.stringify(WORKER)}, ${JSON.stringify(asked)}], { stdio: "inherit" }); w.on("exit", () => setTimeout(() => process.exit(0), 100)); ${IDLE}`,
        ],
        {
          env: { ...process.env, PASEO_AGENT_ID: foreign("seat-6") },
          stdio: ["ignore", "pipe", "inherit"],
          windowsHide: true,
        },
      );
      t.after(() => daemon.kill("SIGKILL"));
      let out = "";
      daemon.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      await new Promise((resolve) => daemon.on("exit", resolve));
      return { out, daemon: daemon.pid! };
    };
    const other = await looked(foreign("seat-7"));
    assert.ok(other.out.includes(`found ${left}\n`), `the other seat's leftover is found: ${other.out}`);
    assert.ok(!other.out.includes(`found ${other.daemon}\n`), "the worker's parent is not listed");
    const own = await looked(foreign("seat-6"));
    assert.ok(!own.out.includes("found"), "what carries the daemon's own mark is not listed, nor the daemon");
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
  "on macOS, a look never lists the plugin's daemon, nor what the daemon started, when a process above the daemon carries the mark",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    const mark = foreign("seat-x");
    const daemon = `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      const c = spawn(process.execPath, ["-e", "${IDLE}"], { env, stdio: "ignore" });
      const w = spawn(process.execPath, [${JSON.stringify(WORKER)}, ${JSON.stringify(mark)}], { env, stdio: ["ignore", "inherit", "inherit"] });
      w.on("exit", () => console.log("done", process.pid, c.pid)); ${IDLE}`;
    const above = await printing(
      mark,
      `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      spawn(process.execPath, ["-e", ${JSON.stringify(daemon)}], { env, stdio: ["ignore", "inherit", "inherit"] }); ${IDLE}`,
      /((?:found \d+\n)*)done (\d+) (\d+)/,
    );
    const [found, d, c] = above.groups as [string, string, string];
    t.after(() => {
      for (const pid of [above.pid, Number(d), Number(c)]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    assert.equal(
      found,
      "",
      "the look found nothing: the daemon, its other child and the process above it are not listed",
    );
  },
);

test(
  "on macOS, the descent from a marked process stops at a child whose environment is shown without the mark, and goes no further",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    const { h, sup } = await laneWithPeer();
    const seat = foreign("seat");
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const middle = `const { spawn } = require("child_process"); console.log(${SLEEP}.pid); ${IDLE}`;
    const [parent, child, grandchild] = await restricted<[number, number, number]>(
      seat,
      `const { spawn } = require("child_process"); ${WITHOUT_MARK}
      const c = spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { env, stdio: ["ignore", "pipe", "inherit"] });
      c.stdout.once("data", (d) => console.log(c.pid, String(d).trim())); ${IDLE}`,
    );
    const all = [parent, child, grandchild];
    t.after(() => {
      for (const pid of all) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await h.runtime.archived({ id: seat, provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);

    const letter = letterOf(h, sup);
    await until(t, () => letter() !== undefined, "the Supervisor was mailed the leftovers");
    const text = letter()!;
    assert.ok(text.includes(`pid ${parent}:`), `the marked process: ${text}`);
    for (const pid of [child, grandchild])
      assert.ok(!text.includes(`pid ${pid}:`), `${pid}, below a process that is not the seat's, is not listed`);
  },
);

test(
  "on macOS, a seat Paseo runs again while its listing is still being made is not reported",
  { timeout: 30_000, skip: process.platform !== "darwin" },
  async (t) => {
    const { h, sup, peer } = await laneWithPeer();
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const reopened = foreign("reopened-in-flight");
    const stays = foreign("stays");
    const kept = sleeper(reopened);
    const left = sleeper(stays);
    t.after(() => {
      for (const pid of [kept, left]) if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    // A perl ahead of the real one on PATH that makes a file when it starts and waits for another before it lists.
    const dir = tempDir("sw2-listing-");
    const [reached, open] = [join(dir, "reached"), join(dir, "open")];
    writeFileSync(
      join(dir, "perl"),
      `#!/bin/sh\n: > "${reached}.$$"\nwhile [ ! -e "${open}" ]; do /bin/sleep 0.05; done\nexec /usr/bin/perl "$@"\n`,
    );
    chmodSync(join(dir, "perl"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    t.after(() => {
      process.env.PATH = path;
      writeFileSync(open, "");
    });

    for (const id of [reopened, stays]) await h.runtime.archived({ id, provider: SEAT, cwd: h.root });
    mock.timers.tick(60_000);
    await until(
      t,
      () => readdirSync(dir).filter((name) => name.startsWith("reached.")).length === 2,
      "both listings are under way",
    );
    h.runtime.sessionOpen({
      agentId: reopened,
      reason: "resume",
      purpose: "interactive",
      provider: SEAT,
      cwd: h.root,
      env: {},
    });
    writeFileSync(open, "");

    const lead = h.ledger().lanes.L1!.lead!;
    const heard = () => [...h.heard(sup), ...h.heard(lead), ...h.heard(peer)].filter((x) => x.startsWith("LEFTOVERS"));
    await until(t, () => heard().length > 0, "the other seat was reported");
    assert.ok(heard().every((text) => text.includes(`pid ${left}:`) && !text.includes(`pid ${kept}:`)));
  },
);
