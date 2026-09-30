import assert from "node:assert/strict";
import { test } from "node:test";
import { recordEvent } from "../../server/desk/store/event-log.ts";
import { laneWithPeer } from "./harness.ts";
import { book } from "./noticed.ts";

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };

/** The kinds of the incidents opened since, in order. */
const opened = (h: Awaited<ReturnType<typeof laneWithPeer>>["h"]) =>
  Object.values(book(h)).map((item) => [item.kind, item.quote]);

test("an accept with nothing read or run since the hand-back, and one far heavier in tests than in source, are evidence", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const stream = h.timelineOf(lead);
  h.commit(h.ledger().tasks["L1-T1"]!.worktree!, "a.test.js", "assert(1);\nassert(2);\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "tests" });
  stream.add({ type: "user_message", text: "HANDBACK L1-T1 (Clean build) from agent\n\nOutcome: complete" }, "l1");
  const accepted = await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal(accepted.ok, true, accepted.text);
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), [
    ["accepted-unread", "L1-T1 was accepted with nothing read, searched or run since its last hand-back or review"],
    ["overbuilt", "L1-T1 changes 2 test lines against 0 source lines"],
  ]);
});

test("an accept after reading the change, or with no hand-back letter in the record to count from, is none", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const stream = h.timelineOf(lead);
  h.commit(h.ledger().tasks["L1-T1"]!.worktree!, "a.txt", "done\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  stream.add({ type: "user_message", text: "HANDBACK L1-T1 (Clean build) from agent" }, "l1");
  const diff = { type: "shell", command: "git diff main" };
  stream.add({ type: "tool_call", callId: "d", name: "Bash", status: "completed", detail: diff }, "l1");
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), []);

  // No hand-back letter in the Lead's record: nothing to count from, so nothing is read into it.
  const other = await laneWithPeer();
  other.h.commit(other.h.ledger().tasks["L1-T1"]!.worktree!, "a.txt", "done\n");
  await other.h.call(other.peer, "peer", "done", { outcome: "complete", summary: "done" });
  const accepted = await other.h.call(other.lane.lead!, "lead", "accept", { task: "L1-T1" });
  assert.equal(accepted.ok, true, accepted.text);
  await other.h.runtime.desk.settled(other.h.project);
  assert.deepEqual(opened(other.h), []);
});

test("a claude Lead that looked through PowerShell before its accept looked", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const stream = h.timelineOf(lead);
  h.commit(h.ledger().tasks["L1-T1"]!.worktree!, "a.txt", "done\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  stream.add({ type: "user_message", text: "HANDBACK L1-T1 (Clean build) from agent" }, "l1");
  // As Paseo 0.10.2 gives a claude PowerShell call: an unknown detail holding the tool's own input.
  const detail = { type: "unknown", input: { command: "git diff main", description: "diff" }, output: null };
  stream.add({ type: "tool_call", callId: "p", name: "PowerShell", status: "completed", detail }, "l1");
  const accepted = await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal(accepted.ok, true, accepted.text);
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), []);
});

test("a sending-back on a review that ran nothing, and a review's accept with nothing run, are evidence", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  h.commit(h.ledger().tasks["L1-T1"]!.worktree!, "a.txt", "done\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is it right?" });
  const reviewer = h.ledger().tasks["L1-R1"]!.peer!;
  await h.call(reviewer, "reviewer", "done", { verdict: "changes", answer: "It reads wrong." });
  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Fix it." });
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "fixed" });
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is it right now?" });
  const second = h.ledger().tasks["L1-R2"]!.peer!;
  const ran = { type: "shell", command: "node --test" };
  h.timelineOf(second).add({ type: "tool_call", callId: "r", name: "Bash", status: "completed", detail: ran }, "r1");
  await h.call(second, "reviewer", "done", { verdict: "accept", answer: "Right.", ran: ["node --test"] });
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), [
    ["rework-unrun", "L1-T1 was sent back on L1-R1, a review that ran nothing"],
    ["review-unchecked", "L1-R2 accepted with 1 changed file unread: a.txt"],
  ]);
});

test("a claude review whose commands ran through PowerShell ran them: its whole diff shown is every changed file read", async () => {
  const { h, lane, peer } = await laneWithPeer();
  h.commit(h.ledger().tasks["L1-T1"]!.worktree!, "a.txt", "done\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  await h.call(lane.lead!, "lead", "start_review", { task: "L1-T1", focus: "Is it right?" });
  const reviewer = h.ledger().tasks["L1-R1"]!.peer!;
  // As Paseo 0.10.2 gives a claude PowerShell call: an unknown detail holding the tool's own input.
  const detail = { type: "unknown", input: { command: "git diff main", description: "diff" }, output: null };
  h.timelineOf(reviewer).add({ type: "tool_call", callId: "p", name: "PowerShell", status: "completed", detail }, "r1");
  await h.call(reviewer, "reviewer", "done", { verdict: "accept", answer: "Right.", ran: ["git diff main"] });
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), []);
});

test("a long lane reported ready with nobody asking anything, over a gate growing slower, and a brief with a pasted history, are evidence", async () => {
  const { h, sup } = await laneWithPeer();
  await h.call(sup, "supervisor", "open_lane", { title: "Wide", outcome: "x", ...scope, isolate: true });
  const lead = h.ledger().lanes.L2!.lead!;
  const brief = (key: string, context?: string) => ({
    key,
    title: key,
    goal: "g",
    ...scope,
    holds: [`${key}.txt`],
    parallel: true,
    ...(context ? { context } : {}),
  });
  const added = await h.call(lead, "lead", "add_tasks", {
    tasks: [brief("b"), brief("c"), brief("d"), brief("e", "x".repeat(5000))],
  });
  assert.equal(added.ok, true, added.text);
  for (const seconds of [10, 15, 31])
    recordEvent(h.project, { kind: "gate.passed", lane: "L2", seconds, command: "npm test" });
  const reported = await h.call(lead, "lead", "report", { summary: "done", ready: true });
  assert.equal(reported.ok, true, reported.text);
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(opened(h), [
    ["brief-pasted", "e's context runs 5000 characters"],
    ["no-pushback", "L2 reported ready after 4 tasks with no ask from any of its seats"],
    ["gate-slowing", "L2's gate took 10, 15, 31 seconds over its last three runs"],
  ]);
});
