import assert from "node:assert/strict";
import { test } from "node:test";
import { notice } from "./noticed.ts";
import { marked, sandboxLine } from "../../client/format/flow.ts";
import { contracts } from "../../shared/rpc.ts";
import type { Layer } from "../../shared/settings.ts";
import { settle } from "./fake-timeline.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { can, providerId, seatOf } from "../../server/catalog/kit/roles.ts";
import type { RoleSpec } from "../../server/catalog/kit/kit.ts";

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

test("the Team tab marks a seat of every role the kit has where its agent has no OS sandbox, and a sandboxed one shows nothing new", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => Object.defineProperty(process, "platform", platform));
  // One machine per agent, a seat of every role the kit has on it, each seated as its first capability here says.
  const machine = async (agent: string, model: string) => {
    const h = harness();
    const kit = h.runtime.kit;
    h.projectSettings({ roles: Object.fromEntries(kit.roles.map((role) => [role.role, { harness: agent }])) });
    const seated: { role: RoleSpec; id: string }[] = [];
    const lanes: string[] = [];
    const by = (capability: string) => seated.find((each) => can(each.role, capability))!;
    const added = async (role: RoleSpec) => h.add(`${providerId(kit, role.role, agent)}/${model}`, h.root, role.role);
    // The seat on the task a Lead's call adds, as the desk seats it.
    const onTask = async (role: RoleSpec, tool: string, args: Record<string, unknown>) => {
      const lead = by("lead");
      const before = new Set(Object.keys(h.ledger().tasks));
      const reply = await h.call(lead.id, lead.role.role, tool, args);
      await h.tick();
      const task = Object.values(h.ledger().tasks).find((each) => !before.has(each.id));
      assert.ok(task?.peer, `a ${agent} ${role.role} was seated: ${JSON.stringify(reply)}`);
      return task.peer;
    };
    const task = { goal: "g", acceptance: ["a"], hints: ["a.txt"], outOfScope: ["the rest of the repository"] };
    const seating = {
      supervise: added,
      lead: async (role: RoleSpec) => {
        const boss = by("supervise");
        const reply = await h.call(boss.id, boss.role.role, "open_lane", {
          title: role.label,
          outcome: "a.txt changes",
          acceptance: ["a"],
          outOfScope: ["anything else in the repository"],
          role: role.role,
        });
        const opened = Object.values(h.ledger().lanes).find((each) => !lanes.includes(each.id));
        assert.ok(opened?.lead, `a ${agent} ${role.role} was seated: ${JSON.stringify(reply)}`);
        lanes.push(opened.id);
        return opened.lead;
      },
      write: (role: RoleSpec) =>
        onTask(role, "add_tasks", { tasks: [{ ...task, key: role.role, title: role.label, role: role.role }] }),
      review: (role: RoleSpec) => onTask(role, "start_review", { focus: "Is it right?", role: role.role }),
      judge: added,
    } as const;
    // Kit order may name a Peer before its Lead, so each capability is seated after those it needs.
    for (const [capability, seat] of Object.entries(seating))
      for (const role of kit.roles)
        if (!seated.some((each) => each.role === role) && can(role, capability))
          seated.push({ role, id: await seat(role) });
    const unseatable = kit.roles.filter((role) => !seated.some((each) => each.role === role));
    assert.deepEqual(
      unseatable.map((role) => [role.role, role.can]),
      [],
      "every role the kit has was seated: a capability no seat here takes needs a seat built for it",
    );
    for (const { role, id } of seated) {
      const seat = seatOf(kit, h.agents.get(id)!.provider);
      assert.deepEqual([seat?.role, seat?.harness.id], [role, agent], `a ${agent} ${role.role}`);
    }
    const ids = seated.map((each) => each.id);
    const seen = async (on: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { ...platform, value: on });
      const flow = await h.rpc(contracts.flow, { project: h.project.slug, open: lanes });
      Object.defineProperty(process, "platform", platform);
      assert.ok("lanes" in flow);
      const shown = new Map(
        [
          ...flow.supervisors,
          ...flow.lanes.flatMap((lane) => [lane.lead, ...lane.tasks.map((task) => task.peer)]),
          flow.watch.seat,
        ].flatMap((seat) => (seat ? [[seat.id, seat] as const] : [])),
      );
      return ids.map((id) => [shown.get(id)?.id, sandboxLine(shown.get(id) ?? null)]);
    };
    return { ids, seen };
  };
  const line = "Unsandboxed: its shell commands can read and write whatever your account can";
  // Claude has an OS sandbox on macOS and Linux and none on Windows; Codex has one on all three.
  const grid = [
    ["claude", "claude-opus-5", { win32: line, darwin: null, linux: null }],
    ["codex", "gpt-5.5", { win32: null, darwin: null, linux: null }],
  ] as const;
  // A harness owns the machine's HOME, so each is read before the next is built.
  for (const [agent, model, lines] of grid) {
    const { ids, seen } = await machine(agent, model);
    for (const [on, expected] of Object.entries(lines))
      assert.deepEqual(
        await seen(on as NodeJS.Platform),
        ids.map((id) => [id, expected]),
        `a ${agent} seat of every role alike on ${on}`,
      );
  }
});
