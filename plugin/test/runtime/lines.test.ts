import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { PaseoHost } from "../../server/adapters/paseo/host.ts";
import { deskSocket, stateRoot } from "../../server/core/paths.ts";
import type { TeamSocket } from "../../server/runtime/seat/team-socket.ts";
import { contracts } from "../../shared/rpc.ts";
import { reported } from "../console.ts";
import { harness } from "./harness.ts";
import { heldGate, until } from "../gates.ts";

type Harness = ReturnType<typeof harness>;
type Heard = {
  type: string;
  id?: string;
  ok?: boolean;
  text?: string;
  choices?: Record<string, Record<string, string[]>>;
};

/** Whether `check` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
}

/** The Lead's team server's line to the desk of the plugin running now: what it heard, and a way to speak on it. */
async function lineOf(h: Harness, t: Pick<TestContext, "after" | "diagnostic" | "signal">) {
  const socket = (h.runtime as unknown as { socket: TeamSocket }).socket;
  socket.listen();
  t.after(() => socket.close());
  const line = connect(deskSocket());
  await new Promise((resolve) => line.on("connect", resolve));
  t.after(() => line.destroy());
  const heard: Heard[] = [];
  createInterface({ input: line }).on("line", (text) => heard.push(JSON.parse(text) as Heard));
  const say = (message: object) => line.write(`${JSON.stringify(message)}\n`);
  say({ type: "hello", key: "k-lead", role: "lead", cwd: h.root });
  await until(t, () => heard.some((said) => said.type === "welcome"), "the desk's welcome, as the seat's key is known");
  const result = async (id: string) => {
    const answered = () => heard.find((said) => said.type === "result" && said.id === id);
    await until(t, () => answered() !== undefined, `a result for ${id}`);
    return answered()!;
  };
  return { socket, heard, say, result };
}

const addTask = (id: string, title: string, holds: string) => ({
  type: "call",
  id,
  tool: "add_tasks",
  args: {
    tasks: [{ key: "t", title, goal: "g", acceptance: ["a"], holds: [holds], outOfScope: ["z"], parallel: true }],
  },
});

test("a seat's line to the desk carries its choices and its calls, and a call stopped on either side, or made before a reload is reached, is carried out and mailed", async (t) => {
  const gate = heldGate(t);
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  // The lane's gate waits for the test, so a report is still being worked on when its caller stops it.
  await h.call(sup, "supervisor", "set_project", { gate: gate.command, gateOn: "lane" });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Build",
    outcome: "a.txt changes",
    acceptance: ["a"],
    outOfScope: ["anything else in the repository"],
  });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  const seat = h.agents.get(lead)!;
  // The Lead's key, as Paseo opens its session; then its team server's line to the desk.
  h.runtime.sessionOpen({
    agentId: lead,
    reason: "create",
    provider: seat.provider,
    cwd: h.root,
    env: { SEATWORKS_DESK_KEY: "k-lead" },
  });
  const { socket, heard, say, result } = await lineOf(h, t);
  const skills = (said?: Heard) => said?.choices?.add_tasks?.skills ?? [];
  assert.ok(skills(heard[0]).includes("ide-index-mcp"), "Peers have the IDE server, so a Lead may name its skill");
  const read = await h.rpc(contracts.settingsRead, { project: h.project.slug });
  const saved = await h.rpc(contracts.settingsWrite, {
    project: h.project.slug,
    revision: read.revision,
    values: { mcp: { "intellij-index": { enabled: false } } },
  });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  await until(t, () => heard.some((said) => said.type === "choices"), "the new choices, told to the seat's server");
  const choices = heard.find((said) => said.type === "choices");
  assert.equal(skills(choices).includes("ide-index-mcp"), false, "without the server, its skill is no choice");

  // As seen live: a Lead well into a long turn accepts, and the merge's MERGED waits for that turn to end.
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Clean build", goal: "g", acceptance: ["a"], hints: ["a.txt"], outOfScope: ["z"] }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  h.agents.get(peer)!.status = "idle";
  seat.status = "running";
  h.runtime.outbox.turnStarted(lead);
  say({ type: "call", id: "accept", tool: "accept", args: { task: "L1-T1" } });
  assert.match((await result("accept")).text ?? "", /L1-T1 is in the merge queue/);
  await h.runtime.desk.settled(h.project);
  const merged = () => [...seat.steered, ...seat.sent].filter((text) => /MERGED L1-T1/.test(text));
  assert.deepEqual(merged(), [], "a text arriving while a call waits is taken as the call being cut short");
  await h.tick();
  assert.deepEqual(merged(), [], "answered is not taken: the harness has not read it yet");
  say({ type: "taken", id: "accept" });
  await until(t, () => !socket.calling(lead), "the desk letting go of the taken call");
  await h.tick();
  assert.deepEqual(merged(), [], "nor once the call is done: the turn is still its own to think and write in");
  await h.idle(lead);
  assert.deepEqual(seat.steered, [], "nothing was steered into it");
  assert.match(seat.sent.join("\n"), /MERGED L1-T1/, "what waited goes once its turn ends");

  // Mailed, or ridden along with the reply to a later call on a line, which carries what is held for its seat.
  const lines = [heard];
  const mailed = (tool: string, what: string) =>
    until(
      t,
      () =>
        new RegExp(`ANSWER to your ${tool} call, which was stopped on your side before its answer reached you\\.`).test(
          [...h.heard(lead), ...lines.flat().map((said) => said.text ?? "")].join("\n"),
        ),
      what,
    );
  say({ type: "call", id: "status", tool: "status", args: {} });
  await result("status");
  say({ type: "cancel", id: "status" });
  await mailed("status", "the status answer that reached the line but not the harness, mailed");
  say({ type: "call", id: "report", tool: "report", args: { summary: "done", ready: true } });
  say({ type: "cancel", id: "report" });
  gate.release();
  await mailed("report", "the report stopped before its answer came, mailed once its gate is done");

  // Loaded again, the plugin has Paseo's API only once a hook or a panel call brings it.
  const host = new PaseoHost();
  h.restart(host);
  const reloaded = await lineOf(h, t);
  lines.push(reloaded.heard);
  reloaded.say(addTask("a", "Waits", "x.txt"));
  reloaded.say(addTask("b", "Stopped", "y.txt"));
  reloaded.say({ type: "cancel", id: "b" });
  // Held on the line, the call is the desk's; that it waited for Paseo shows in its answer once Paseo comes.
  await until(t, () => reloaded.socket.calling(lead), "add_tasks a, held on the reloaded line");
  assert.equal(
    reloaded.heard.some((said) => said.type === "result"),
    false,
    "it waits, as the call cannot reach a seat yet",
  );
  host.answering({
    handle: (_contract: unknown, handler: (input: unknown, context: { paseo: unknown }) => unknown) =>
      handler(undefined, { paseo: h.paseo }),
  } as never)({ name: "status" }, () => undefined);
  const waited = await reloaded.result("a");
  assert.equal(waited.ok, true, waited.text);
  await mailed("add_tasks", "add_tasks b, stopped by its harness meanwhile, carried out and mailed");
  // Either call may start the first task, so its Peer is read once both are done.
  const started = Object.values(h.ledger().tasks).find((entry) => entry.title === "Waits")!;
  assert.ok(started.peer, "carried out once Paseo came, its task started with a Peer of its own");

  const said = reported(t);
  t.mock.method(h.runtime.outbox, "post", async () => {
    throw new Error("the disk is full");
  });
  reloaded.say({ type: "call", id: "late", tool: "status", args: {} });
  await reloaded.result("late");
  reloaded.say({ type: "cancel", id: "late" });
  await until(t, () => /could not be mailed/.test(said()), "word that a reply lost on its way could not be mailed");
});

test("a seat Paseo starts again after it was archived is served nothing, and told why, as is any seat while the keys cannot be read", async (t) => {
  const h = harness();
  const socket = (h.runtime as unknown as { socket: TeamSocket }).socket;
  socket.listen();
  t.after(() => socket.close());
  const hello = async (key: string) => {
    const line = connect(deskSocket());
    t.after(() => line.destroy());
    const heard: Heard[] = [];
    createInterface({ input: line }).on("line", (text) => heard.push(JSON.parse(text) as Heard));
    await new Promise((resolve) => line.on("connect", resolve));
    line.write(`${JSON.stringify({ type: "hello", key, role: "lead", cwd: h.root })}\n`);
    assert.ok(await within(2000, () => heard.length > 0), "the desk answers the hello");
    return heard[0] as Heard & { why?: string };
  };
  const open = (key?: string) =>
    h.runtime.sessionOpen({
      agentId: "agent-9",
      reason: key ? "create" : "resume",
      provider: "sw2-lead-claude",
      cwd: h.root,
      env: key ? { SEATWORKS_DESK_KEY: key } : {},
    });
  open("k-9");
  assert.equal((await hello("k-9")).type, "welcome");
  await h.runtime.archived({ id: "agent-9", provider: "sw2-lead-claude", cwd: h.root });
  const revived = open().env.SEATWORKS_DESK_KEY ?? "";
  const refused = await hello(revived);
  assert.equal(refused.type, "refused");
  assert.match(refused.why ?? "", /agent was archived, and the desk serves no archived seat/, "the true reason");

  const said = reported(t);
  writeFileSync(join(stateRoot(), "keys.json"), "{not json");
  const unread = await hello("k-9");
  assert.match(unread.why ?? "", /keys\.json is there but could not be read/);
  assert.match(said(), /keys\.json/);
});
