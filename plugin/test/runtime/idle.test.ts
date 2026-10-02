import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("an idle Lead with nothing running, asked or reported ready wakes whoever supervises, and one waiting on it or on the Human does not", async () => {
  const h = harness();
  h.projectSettings({ hitl: { on: true } });
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "set_project", { askFirst: ["b.txt"] });
  for (const [title, isolate] of [
    ["Quiet", false],
    ["Held", true],
    ["Ready", true],
    ["Parked", true],
    ["Detoured", true],
  ] as const)
    await h.call(sup, "supervisor", "open_lane", { title, ...scope, isolate });
  await h.call(sup, "supervisor", "open_lane", { title: "Clearing", ...scope, isolate: true, detourOf: "L5" });
  const lanes = h.ledger().lanes;
  await h.call(sup, "supervisor", "hold_lane", { lane: "L2", reason: "the Human is reading it" });
  await h.call(lanes.L3!.lead!, "lead", "report", { summary: "done", ready: true });
  h.commit(lanes.L4!.worktree!, "b.txt", "bee, changed\n");
  await h.call(lanes.L4!.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L4" })).text, /waits for the Human's approval/);
  await h.call(sup, "supervisor", "amend_lane", { lane: "L4", acceptance: ["a", "b"], why: "the Human added b" });
  for (const lane of Object.values(lanes)) h.agents.get(lane.lead!)!.status = "idle";
  await h.tick(Date.now() + 20 * 60_000);
  const said = h.heard(sup).join("\n");
  assert.match(
    said,
    /INCIDENT I1 \(lane-idle, attend\) on the Lead of L1 \(Quiet\)[^]*What was seen: idle \d+ minutes with no running task, no open ask and no report of it ready; its last words: [^]*\nNext: Nothing, if /,
    "whether to step in is whoever supervises' own call",
  );
  assert.doesNotMatch(
    said,
    /lane-idle, attend\) on the Lead of L[2345]/,
    "a Lead told to wait, or waiting on whoever lands it, on the Human or on a lane clearing its way, is not idle",
  );
  assert.doesNotMatch(h.heard(lanes.L1!.lead!).join("\n"), /INCIDENT/, "never to the Lead it is about");
});

test("an audit Lead waiting for the next landing on its base is not idle, and one with a landing it has not taken in is", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Work", outcome: "a.txt changes", ...scope });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Audit",
    outcome: "main does what CONTEXT.md says before it is pushed",
    ...scope,
    isolate: true,
    audit: true,
  });
  const [work, audit] = [h.ledger().lanes.L1!, h.ledger().lanes.L2!];
  Object.assign(h.agents.get(audit.lead!)!, { status: "idle", updatedAt: new Date(Date.now() - 60_000).toISOString() });
  await h.tick(Date.now() + 20 * 60_000);
  assert.doesNotMatch(
    h.heard(sup).join("\n"),
    /lane-idle, attend\) on the Lead of L2/,
    "nothing has landed on main since it last moved: it waits by design",
  );
  h.commit(work.worktree!, "a.txt", "changed\n");
  await h.call(work.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(work.lead!)!.status = "idle";
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  await h.tick(Date.now() + 20 * 60_000);
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I\d+ \(lane-idle, attend\) on the Lead of L2 \(Audit\)/,
    "L1 landed on main after it last moved, and it has not looked",
  );
});
