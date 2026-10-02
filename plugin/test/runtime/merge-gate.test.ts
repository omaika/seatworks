import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { GATE_FAILS, GATE_PASSES, escaped, gateReached, gateStep, heldGate } from "../gates.ts";
import { worktreeRoot } from "../../server/core/paths.ts";
import { contracts } from "../../shared/rpc.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const heard = (h: Harness, id: string) => h.heard(id).join("\n");
/** What the Lead was told from the first letter headed `head` on. */
const after = (h: Harness, lead: string, head: string) => heard(h, lead).split(head)[1] ?? "";

/** A task beside others added under `lead`, with `file` committed in its copy and handed back. */
async function handedBack(h: Harness, lead: string, title: string, holds: string, file = holds) {
  const added = await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title, goal: "g", ...scope, holds: [holds], parallel: true }],
  });
  assert.equal(added.ok, true, added.text);
  const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
  mkdirSync(dirname(join(task.worktree!, file)), { recursive: true });
  h.commit(task.worktree!, file, `${file}\n`);
  assert.equal((await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: title })).ok, true);
  await h.idle(task.peer!);
  return h.ledger().tasks[task.id]!;
}

/** The Lead's accept, and the merge queue gone quiet after it. */
async function accept(h: Harness, lead: string, id: string, over: Record<string, unknown> = {}) {
  const reply = await h.call(lead, "lead", "accept", { task: id, ...over });
  await h.runtime.desk.settled(h.project);
  return reply;
}

test("a task that goes red with its lane brought in stays out until its Lead accepts it over the gate, with a reason", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const notBoth = gateStep("missing", "x.txt", "y.txt");
  await h.call(sup, "supervisor", "set_project", { gate: notBoth, gateOn: "task" });
  // Each green alone and red together, both handed back before either merges.
  await handedBack(h, lead, "Ex", "x.txt");
  const why = await handedBack(h, lead, "Why", "y.txt");
  assert.equal((await accept(h, lead, "L1-T2")).ok, true);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "z", title: "Zed", goal: "g", ...scope, holds: ["z.txt"], parallel: true }],
  });
  assert.equal(
    (await accept(h, lead, "L1-T4")).text,
    "L1-T4 is not handed back: accept it once its Peer hands it back, or cut it.",
    "what it merges is what was gated",
  );
  assert.equal(h.ledger().tasks["L1-T4"]!.status, "running");

  assert.equal((await accept(h, lead, "L1-T3")).ok, true);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "done", "back with its Lead, not merged");
  assert.deepEqual(
    h.events("merge.red").map((event) => event.task),
    ["L1-T3"],
    "the record says the gate stopped it",
  );
  assert.throws(() => h.git(lane.worktree!, "show", `${lane.branch}:y.txt`), "the lane branch never took the red tree");
  assert.equal(h.git(why.worktree!, "show", "HEAD:x.txt"), "x.txt\n", "its copy holds the tree the lane would become");
  assert.match(
    heard(h, lead),
    new RegExp(
      `MERGE RED L1-T3 \\(Why\\): the gate failed on its branch with ${lane.branch} brought in, the tree the lane would become\\. The lane branch is unchanged\\.\\n[^]*Next: Send rework to its Peer with what must change, or accept it again with overGate and a reason to merge it over the gate\\.`,
    ),
  );

  const refused = await accept(h, lead, "L1-T3");
  assert.equal(refused.ok, false);
  assert.match(
    refused.text,
    /^L1-T3's gate is red on the tree the lane would become: send it back with rework, or accept it with overGate and a reason to merge it over the gate\./,
  );
  assert.match((await accept(h, lead, "L1-T3", { overGate: true })).text, /Say why in reason/);
  const reason = "y replaces x next task";
  assert.equal((await accept(h, lead, "L1-T3", { overGate: true, reason })).ok, true);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "merged");
  assert.equal(h.git(lane.worktree!, "show", `${lane.branch}:y.txt`), "y.txt\n");
  assert.match(
    after(h, lead, "MERGED L1-T3"),
    new RegExp(
      `Gate: ran on this task: ${escaped(notBoth)}: the gate failed with exit 1; the same gate on [^\\n]*, passes — merged over it: y replaces x next task`,
    ),
  );
  assert.ok(h.events("gate.overridden").some((event) => event.task === "L1-T3" && event.reason === reason));

  // Standing orders that cannot be read are not a project without a gate: nothing is handed back as if it had none.
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "e", title: "Early", goal: "g", ...scope, holds: ["e.txt"], parallel: true }],
  });
  const early = Object.values(h.ledger().tasks).find((task) => task.title === "Early")!;
  h.commit(early.worktree!, "e.txt", "e\n");
  const orders = join(h.project.state, "project.json");
  writeFileSync(orders, "{not json");
  const unread = await h.call(early.peer!, "peer", "done", { outcome: "complete", summary: "e" });
  assert.equal(unread.ok, false, unread.text);
  assert.match(unread.text, /project\.json is there but could not be read[^]*Nothing was written over it/);
  assert.equal(readFileSync(orders, "utf-8"), "{not json");
});

test("what the gate did reaches the Lead: with the hand-back, when its verdict is used again, and with each merge", async () => {
  const runs = join(tempDir("sw2-gate-runs-"), "runs");
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const gate = (settings: Record<string, unknown>) => h.call(sup, "supervisor", "set_project", settings);
  const notBroken = gateStep("missing", "BROKEN");
  await gate({ gate: notBroken, gateOn: "task" });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Numbers",
    outcome: "a.txt gains words",
    acceptance: ["four"],
    outOfScope: ["anything else"],
  });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  /** A task in the lane's copy, committing `text` to a.txt unless it finds nothing needed changing. */
  const inLane = async (title: string, text?: string) => {
    await h.call(lead, "lead", "add_tasks", { tasks: [{ key: "t", title, goal: "g", ...scope, hints: ["a.txt"] }] });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    if (text) h.commit(lane.worktree!, "a.txt", text);
    const summary = text ? "four" : "nothing needed changing: the parser already handles it";
    assert.equal((await h.call(task.peer!, "peer", "done", { outcome: "complete", summary })).ok, true);
    await h.idle(task.peer!);
    assert.equal((await accept(h, lead, task.id)).ok, true);
    return h.ledger().tasks[task.id]!;
  };

  // The default path, in the lane's copy, is the one where the task gate used to be skipped in silence.
  await inLane("Add four", "one\ntwo\nthree\nfour\n");
  assert.match(
    heard(h, lead),
    new RegExp(`Gate: ${escaped(notBroken)} passed in`),
    "the Lead is told what the gate did, not what it would do",
  );
  assert.match(after(h, lead, "MERGED L1-T1"), new RegExp(`Gate: ran on this task: ${escaped(notBroken)} passed in`));
  assert.doesNotMatch(heard(h, lead), /Gate: runs on the whole lane/);
  const nothing = await inLane("Check the parser");
  assert.equal(
    nothing.status,
    "merged",
    "the Lead judges the hand-back; the desk does not decide no diff means no work",
  );
  assert.match(after(h, lead, "MERGED L1-T2"), /changed no files/, "the letter says plainly that nothing moved");

  await gate({ gate: gateStep("append", runs, "run") });
  const reused = await handedBack(h, lead, "Side", "c.txt");
  await accept(h, lead, reused.id);
  assert.equal(h.ledger().tasks[reused.id]!.status, "merged");
  assert.equal(
    readFileSync(runs, "utf-8"),
    "run\n",
    "its lane had not moved since its hand-back, so the gate ran once",
  );

  const red = gateStep("complain", "red", "1");
  await gate({ gate: red });
  const broke = await handedBack(h, lead, "B", "b.txt");
  assert.match(
    after(h, lead, `HANDBACK ${broke.id}`),
    new RegExp(
      `Gate: ${escaped(red)}: the gate failed with exit 1; the same gate on [^\\n]*, fails too\\. The lane takes it red only if you accept it over the gate with a reason\\.`,
    ),
  );
  assert.equal((await accept(h, lead, broke.id)).ok, false);
  assert.equal(
    (await accept(h, lead, broke.id, { overGate: true, reason: "the gate is broken, not the task" })).ok,
    true,
  );
  assert.equal(h.ledger().tasks[broke.id]!.status, "merged", "accepted over the gate with a reason, it lands");
  assert.match(h.git(lane.worktree!, "log", "-1", "--format=%s"), new RegExp(`^Merge ${broke.id}`));

  await gate({ gate: GATE_PASSES, gateOn: "lane" });
  const ungated = await handedBack(h, lead, "Tail", "d.txt");
  await accept(h, lead, ungated.id);
  assert.match(
    after(h, lead, `MERGED ${ungated.id}`),
    /Gate: not run on merges, so the lane branch can break between reports; it runs on the whole lane when you report it ready/,
  );
});

test("a Maven wrapper's gate, found from the project's files, starts in this platform's shell and its exit decides the gate", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  // The wrapper as Maven ships it, both forms: each fails while the project holds `red`, as its tests would.
  writeFileSync(join(h.root, "mvnw"), "#!/bin/sh\nif [ -f red ]; then exit 3; fi\n");
  chmodSync(join(h.root, "mvnw"), 0o755);
  writeFileSync(join(h.root, "mvnw.cmd"), "@echo off\r\nif exist red exit /b 3\r\nexit /b 0\r\n");
  h.commit(h.root, "pom.xml", "<project/>\n");
  await h.call(sup, "supervisor", "open_lane", {
    title: "Maven",
    outcome: "the project gains files",
    acceptance: ["a"],
    outOfScope: ["anything else"],
  });
  const lead = h.ledger().lanes.L1!.lead!;
  const green = await handedBack(h, lead, "Green", "a.txt");
  assert.match(after(h, lead, `HANDBACK ${green.id}`), /Gate: \S*mvnw\S* -q test passed in/);
  const red = await handedBack(h, lead, "Red", "red");
  assert.match(after(h, lead, `HANDBACK ${red.id}`), /Gate: \S*mvnw\S* -q test: the gate failed with exit 3;/);
});

test("a change a risk rule reaches is rehearsed with its gate, and a red rehearsal keeps it out as a red gate does", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const rules = (gate: string, rehearse: string, invariant = "running it twice changes nothing") =>
    h.call(sup, "supervisor", "set_project", {
      gate,
      riskRules: [{ paths: ["db/**"], invariant, reviewQuestion: "What does a second run do?", rehearse }],
    });
  const cut = (id: string) => h.call(lead, "lead", "cut", { task: id, reason: "rehearsed" });

  await rules(GATE_FAILS, GATE_PASSES);
  const first = await handedBack(h, lead, "Migrate", "db/", "db/001.sql");
  assert.deepEqual(
    [first.handback!.gate!.ok, first.handback!.gate!.note],
    [
      false,
      `${GATE_FAILS}: the gate failed with exit 1; the same gate on ${lane.branch} at ${h.git(h.root, "rev-parse", "--short=7", lane.branch).trim()}, in a copy made as a task's is, fails too`,
    ],
    "a red gate stays red whatever the rehearsals after it would say, and they do not run",
  );
  await cut(first.id);

  await rules(GATE_PASSES, GATE_FAILS);
  const migrate = await handedBack(h, lead, "M", "db/", "db/001.sql");
  const copy = await handedBack(h, lead, "Copy", "c.txt");
  assert.match(
    after(h, lead, `HANDBACK ${migrate.id}`),
    new RegExp(
      `Gate: ${escaped(GATE_PASSES)} passed in \\d+s; ${escaped(GATE_FAILS)}, rehearsing that running it twice changes nothing, failed with exit 1`,
    ),
  );
  assert.doesNotMatch(
    after(h, lead, `HANDBACK ${copy.id}`),
    /rehearsing/,
    "a change the rule does not reach is not rehearsed",
  );
  assert.match((await accept(h, lead, migrate.id)).text, /^L1-T\d+'s gate is red on the tree the lane would become/);
  await cut(migrate.id);

  await rules(GATE_PASSES, gateStep("one-per-prefix", "db", "3"), "no two migrations share a number");
  const [a, b] = [
    await handedBack(h, lead, "Add a", "db/001-a.sql"),
    await handedBack(h, lead, "Add b", "db/001-b.sql"),
  ];
  assert.deepEqual([a.handback!.gate!.ok, b.handback!.gate!.ok], [true, true], "each is green alone");
  await accept(h, lead, a.id);
  await accept(h, lead, b.id);
  assert.equal(h.ledger().tasks[b.id]!.status, "done", "rehearsed together at merge, the second is kept out");
  assert.match(
    heard(h, lead),
    /MERGE RED L1-T\d+ \(Add b\)[^]*rehearsing that no two migrations share a number, failed with exit 1/,
  );
});

test("a task's red gate comes with the same gate on its lane's tip, in a copy made as a task's is, run once for each tip", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const runs = join(tempDir("sw2-tip-runs-"), "runs");
  await h.call(sup, "supervisor", "set_project", {
    gate: `${gateStep("append", runs, "run")} && ${gateStep("missing", "BROKEN")}`,
    gateOn: "task",
  });
  const tip = () => h.git(h.root, "rev-parse", "--short=7", lane.branch).trim();
  await handedBack(h, lead, "Breaks", "BROKEN");
  assert.match(
    after(h, lead, "HANDBACK L1-T2"),
    new RegExp(
      `Gate: [^\\n]*the gate failed with exit 1; the same gate on ${lane.branch} at ${tip()}, in a copy made as a task's is, passes\\.`,
    ),
  );
  h.commitTo(lane.branch, "BROKEN", "on the lane\n");
  await handedBack(h, lead, "Beside", "c.txt");
  await handedBack(h, lead, "Again", "d.txt");
  for (const id of ["L1-T3", "L1-T4"])
    assert.match(
      after(h, lead, `HANDBACK ${id}`),
      new RegExp(`the same gate on ${lane.branch} at ${tip()}, in a copy made as a task's is, fails too\\.`),
    );
  assert.equal(
    readFileSync(runs, "utf-8").split("\n").filter(Boolean).length,
    5,
    "the tip's run is kept for its commit",
  );
  assert.deepEqual(
    h.git(h.root, "worktree", "list", "--porcelain").match(/^worktree .*tip-.*$/gm),
    null,
    "and the copy it ran in is gone",
  );
});

test("a tip whose copy failed to set up has no verdict on its commit, and the next red hand-back runs its gate again", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const broke = join(tempDir("sw2-tip-setup-"), "broke");
  writeFileSync(broke, "");
  // The setup fails while `broke` is there; the gate needs what a setup leaves, and is red on either task's file.
  await h.call(sup, "supervisor", "set_project", {
    setup: `${gateStep("missing", broke)} && ${gateStep("touch", "SET_UP")}`,
    gate: `${gateStep("missing", "BROKEN")} && ${gateStep("missing", "ALSO")} && ${gateStep("exists", "SET_UP")}`,
    gateOn: "task",
  });
  const tip = () => h.git(h.root, "rev-parse", "--short=7", lane.branch).trim();
  await handedBack(h, lead, "Breaks", "BROKEN");
  assert.match(
    after(h, lead, "HANDBACK L1-T2"),
    new RegExp(
      `the same gate was not run on ${lane.branch} at ${tip()}: the project's setup in its copy failed with exit 1; its log is \\S+\\.log`,
    ),
  );
  rmSync(broke);
  await handedBack(h, lead, "Also", "ALSO");
  assert.match(
    after(h, lead, "HANDBACK L1-T3"),
    new RegExp(`the same gate on ${lane.branch} at ${tip()}, in a copy made as a task's is, passes\\.`),
  );
});

test("a lane's tip copy keeps the lane's whole tree while its setup and gate run, through a patrol round and Clean, and goes once they end", async (t) => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const gate = heldGate(t);
  await h.call(sup, "supervisor", "set_project", { gate: gateStep("missing", "BROKEN"), gateOn: "task" });
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Breaks", goal: "g", ...scope, holds: ["BROKEN"], parallel: true }],
  });
  const task = Object.values(h.ledger().tasks).find((entry) => entry.title === "Breaks")!;
  h.commit(task.worktree!, "BROKEN", "BROKEN\n");
  // Set once the task's copy is made, so the first copy set up is the tip's, held until the test lets it go.
  await h.call(sup, "supervisor", "set_project", { setup: gate.command });
  const handed = h.call(task.peer!, "peer", "done", { outcome: "complete", summary: "Breaks" });
  await gateReached(gate, handed);
  const copies = join(worktreeRoot(), h.project.slug);
  const [tip] = readdirSync(copies).filter((name) => name.startsWith("tip-"));
  assert.ok(tip, "the tip is set up in a copy of its own");
  const copy = join(copies, tip);

  await h.tick();
  const tracked = h.git(h.root, "ls-tree", "-r", "--name-only", lane.branch).split("\n").filter(Boolean);
  assert.deepEqual(
    tracked.filter((file) => !existsSync(join(copy, file))),
    [],
    "a patrol round leaves every tracked file of the tip in its copy",
  );
  const listed = await h.rpc(contracts.clean, {});
  assert.deepEqual(
    listed.items.filter((item) => item.path.includes("tip-")),
    [],
    "Clean does not offer a copy the desk is setting up",
  );

  gate.release();
  assert.equal((await handed).ok, true);
  assert.match(
    after(h, lead, "HANDBACK L1-T2"),
    new RegExp(`the same gate on ${lane.branch} at [0-9a-f]{7}, in a copy made as a task's is, passes\\.`),
  );
  assert.equal(existsSync(copy), false, "the copy goes once its gate ends, which ran to its own verdict");
  mkdirSync(copy);
  assert.deepEqual(
    (await h.rpc(contracts.clean, {})).items.map((item) => item.path),
    [copy],
    "and nothing holds its path any more: a folder left there is Clean's to offer",
  );
  await h.tick();
  assert.equal(existsSync(copy), false, "and the sweep's to take");
});

test("a second red hand-back while its lane's tip gate runs never takes the first run's copy", async (t) => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  h.machineSettings({ gatesAtOnce: 2 });
  const gate = heldGate(t);
  // Red on either task's file; on the tip, which has neither, held until the test lets it go.
  await h.call(sup, "supervisor", "set_project", {
    gate: `${gateStep("missing", "BROKEN")} && ${gateStep("missing", "ALSO")} && ${gate.command}`,
    gateOn: "task",
  });
  const peers: string[] = [];
  for (const [title, file] of [
    ["Breaks", "BROKEN"],
    ["Also", "ALSO"],
  ] as const) {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: title, title, goal: "g", ...scope, holds: [file], parallel: true }],
    });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    h.commit(task.worktree!, file, `${file}\n`);
    peers.push(task.peer!);
  }
  const done = (peer: string) => h.call(peer, "peer", "done", { outcome: "complete", summary: "red" });
  const first = done(peers[0]!);
  await gateReached(gate, first);
  const copies = join(worktreeRoot(), h.project.slug);
  const tips = () => readdirSync(copies).filter((name) => name.startsWith("tip-"));
  const [held] = tips();
  assert.ok(held);
  gate.arm();
  const second = done(peers[1]!);
  await gateReached(gate, second);
  assert.equal(tips().length, 2, "each run in a copy of its own");
  const tracked = h.git(h.root, "ls-tree", "-r", "--name-only", lane.branch).split("\n").filter(Boolean);
  assert.deepEqual(
    tracked.filter((file) => !existsSync(join(copies, held, file))),
    [],
    "the first run's copy keeps the whole tip",
  );
  await h.tick();
  assert.equal(existsSync(join(copies, held, "a.txt")), true, "and is still held through a patrol round");

  gate.release();
  assert.deepEqual(
    (await Promise.all([first, second])).map((reply) => reply.ok),
    [true, true],
  );
  for (const id of ["L1-T2", "L1-T3"])
    assert.match(
      after(h, lead, `HANDBACK ${id}`),
      new RegExp(`the same gate on ${lane.branch} at [0-9a-f]{7}, in a copy made as a task's is, passes\\.`),
    );
  assert.deepEqual(tips(), [], "each run's copy goes once it ends");
});

test("a tip gate the plugin's stop cuts short has no verdict on its commit, and the next red hand-back runs it again", async (t) => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const gate = heldGate(t);
  // Red on either task's file; on the tip, which has neither, held until the test lets it go.
  await h.call(sup, "supervisor", "set_project", {
    gate: `${gateStep("missing", "BROKEN")} && ${gateStep("missing", "ALSO")} && ${gate.command}`,
    gateOn: "task",
  });
  const peers: string[] = [];
  for (const [title, file] of [
    ["Breaks", "BROKEN"],
    ["Also", "ALSO"],
  ] as const) {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: title, title, goal: "g", ...scope, holds: [file], parallel: true }],
    });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    h.commit(task.worktree!, file, `${file}\n`);
    peers.push(task.peer!);
  }
  const done = (peer: string) => h.call(peer, "peer", "done", { outcome: "complete", summary: "red" });
  const cut = done(peers[0]!);
  await gateReached(gate, cut);
  h.restart();
  await cut;
  gate.release();
  assert.equal((await done(peers[1]!)).ok, true);
  assert.match(
    after(h, lead, "HANDBACK L1-T3"),
    new RegExp(`the same gate on ${lane.branch} at [0-9a-f]{7}, in a copy made as a task's is, passes\\.`),
  );
});

test("no more gates run at once than the machine's gatesAtOnce, the rest waiting their turn", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  h.machineSettings({ gatesAtOnce: 1 });
  // Red when another gate runs beside it: the second mkdir finds the first one's folder.
  const busy = join(tempDir("sw2-gates-at-once-"), "busy");
  await h.call(sup, "supervisor", "set_project", {
    gate: gateStep("exclusive", busy, "0.3"),
    gateOn: "task",
  });
  const tasks = [];
  for (const [title, file] of [
    ["One", "c.txt"],
    ["Two", "d.txt"],
  ] as const) {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: title, title, goal: "g", ...scope, holds: [file], parallel: true }],
    });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    h.commit(task.worktree!, file, `${file}\n`);
    tasks.push(task);
  }
  const handed = await Promise.all(
    tasks.map((task) => h.call(task.peer!, "peer", "done", { outcome: "complete", summary: task.title })),
  );
  assert.deepEqual(
    handed.map((reply) => reply.ok),
    [true, true],
  );
  assert.deepEqual(
    tasks.map((task) => h.ledger().tasks[task.id]!.handback!.gate!.ok),
    [true, true],
    "each gate ran alone",
  );
});
