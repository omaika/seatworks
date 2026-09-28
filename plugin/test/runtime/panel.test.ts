import assert from "node:assert/strict";
import { test } from "node:test";
import { notice } from "./noticed.ts";
import { marked, sandboxLine } from "../../client/format/flow.ts";
import { contracts } from "../../shared/rpc.ts";
import type { Layer } from "../../shared/settings.ts";
import { settle } from "./fake-timeline.ts";
import { harness, laneWithPeer } from "./harness.ts";

test("what the watch sees reaches whoever supervises, the Team tab shows what waits for somebody to be seated, and a call its harness refused is recorded though it never reached the desk", async (t) => {
  const { h, sup, timeline } = await laneWithPeer();
  const working = h.runtime.kit.roles.find((role) => role.role === "peer")!;
  const label = working.label;
  t.after(() => void (working.label = label));
  working.label = "Coder";
  timeline.beat("turn_started", "t1");
  const edit = {
    type: "edit",
    filePath: "src/a.ts",
    oldString: "const x = f();",
    newString: "// @ts-ignore\nconst x = f();",
  };
  timeline.add({ type: "tool_call", callId: "c1", name: "Edit", status: "completed", detail: edit }, "t1");
  const push = { type: "shell", command: "git push --force origin main" };
  timeline.add({ type: "tool_call", callId: "c2", name: "Bash", status: "running", detail: push }, "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.idle(sup);
  const sent = h.agents.get(sup)!.sent.join("\n");
  assert.match(
    sent,
    /INCIDENT I2 \(destructive, page\) on the Coder on L1-T1 \(Clean build\)/,
    "a page is irreversible and often done already, and names the seat by its role as the kit calls it",
  );
  assert.match(sent, /INCIDENT I1 \(suppressed, attend\)/, "and the rest is told as soon");
  Object.assign(h.agents.get(sup)!, { archivedAt: new Date().toISOString() });
  await notice(h, h.ledger().tasks["L1-T1"]!.peer!, "test-weakened", "attend", "src/a.test.ts: 3 assertions become 1");
  const held = await h.rpc(contracts.flow, { project: h.project.slug });
  assert.ok("watch" in held);
  assert.deepEqual(
    held.watch.incidents,
    { told: 2, held: 1, recorded: 0, closed: 0 },
    "the Human sees how many incidents stand where, not the cases, which are W's for whoever supervises",
  );
  Object.assign(h.agents.get(sup)!, { archivedAt: null });

  await h.beginTurn(sup);
  await h.endTurn(sup, "Opening the lane.", {
    type: "tool_call",
    callId: "c1",
    name: "mcp__team__open_lane",
    status: "failed",
    error: {
      content: "InputValidationError: mcp__team__open_lane was called with input that could not be parsed as JSON.",
    },
    detail: { type: "unknown", input: { __unparsedToolInput: { raw: '{"title": "Build"' } }, output: null },
  });
  // No watch follows the Supervisor and the call never reached the desk, so this log is its only record.
  assert.deepEqual(
    h.events("call.malformed").map(({ tool, role }) => [tool, role]),
    [["mcp__team__open_lane", "supervisor"]],
  );
  assert.deepEqual(
    h.events("tool").filter((event) => !event.ok),
    [],
    "and no failed desk call was recorded",
  );
  // Paseo hands the hook the whole session, so the next turn carries the same failed call again.
  await h.endTurn(sup, "Now the task.", {
    type: "tool_call",
    callId: "c2",
    name: "status",
    status: "completed",
    detail: {},
  });
  assert.equal(h.events("call.malformed").length, 1);
});

test("a save is refused only for what it adds", async () => {
  const h = harness();
  h.machineSettings({ roles: { pager: { harness: "claude" } } });
  const save = async (values: Layer) => {
    const read = await h.rpc(contracts.settingsRead, { project: h.project.slug });
    return h.rpc(contracts.settingsWrite, { project: h.project.slug, revision: read.revision, values });
  };
  assert.equal(
    (await save({ hitl: { on: true } })).status,
    "saved",
    "the machine's old role does not block the project",
  );
  const refused = await save({ roles: { ghost: { harness: "claude" } } });
  assert.deepEqual(
    [refused.status, refused.status === "invalid" && refused.error],
    ["invalid", "The project settings name an unknown role ghost"],
  );
});

test("the Team tab marks every seat that runs with no OS sandbox, the Supervisor too, and a sandboxed seat reads as it did", async () => {
  // Codex has a sandbox of its own on every platform the kit names, and pi on none.
  const { h, sup, lane } = await laneWithPeer({ roles: { lead: { harness: "codex" }, peer: { harness: "pi" } } });
  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  const boxed = h.add("sw2-supervisor-codex/gpt-5.5", h.root, "sup-codex");
  const bare = h.add("sw2-supervisor-pi/glm-5", h.root, "sup-pi");
  const flow = await h.rpc(contracts.flow, { project: h.project.slug, open: [lane.id] });
  assert.ok("lanes" in flow);
  const shown = flow.lanes.find((each) => each.id === lane.id)!;
  const peer = shown.tasks[0]!.peer;
  assert.deepEqual(
    [shown.lead?.unsandboxed, peer?.unsandboxed],
    [false, true],
    "each seat as its own agent is, not as its role or its lane",
  );
  assert.equal(sandboxLine(shown.lead), null, "a sandboxed seat shows nothing new");
  assert.equal(sandboxLine(peer), "Unsandboxed: its shell commands can read and write whatever your account can");
  assert.ok(flow.supervisors.some((seat) => seat.id === boxed));
  assert.deepEqual(
    marked(flow.supervisors).map((seat) => [seat.id, sandboxLine(seat)]),
    [[bare, "Unsandboxed: its shell commands can read and write whatever your account can"]],
    "a Supervisor the tab names nowhere else shows only to be marked",
  );
});
