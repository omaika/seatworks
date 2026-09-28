import assert from "node:assert/strict";
import { test } from "node:test";
import { KEPT, type Layer } from "../../shared/settings.ts";
import { laneLine, seatLine } from "../../client/format/flow.ts";
import { caseLines, incidentLines, judgeWords } from "../../client/format/watch.ts";
import {
  dropMcp,
  keptRoles,
  modelRow,
  setLanguage,
  nextSeat,
  setLevelSeat,
  setReviewSensor,
  setRole,
  withKey,
} from "../../client/model/layer.ts";
import type { FlowLane, WatchJudge } from "../../shared/flow-views.ts";
import { TIMELINE } from "../../shared/timeline-items.ts";

const docs = {
  enabled: true,
  label: "Docs",
  roles: ["lead"],
  connect: { type: "http" as const, url: "https://x", headers: { Authorization: "Bearer SECRET" } },
};
const lead = { harness: "claude", model: "opus", thinking: "high", rules: "Never touch the generated client." };
const held: Layer = {
  rules: "Keep diffs small.",
  roles: { lead },
  attention: { longTurnMinutes: 30 },
  mcp: { docs },
  sensor: { other: { key: KEPT } },
};
const { mcp: _mcp, ...undocked } = held;
const EDITS: [string, (layer: Layer) => Layer, Layer][] = [
  [
    "changing a seat's agent forgets what was chosen for the old one and keeps what the owner wrote",
    (layer) => setRole(layer, "lead", { harness: "omp" }, true),
    { ...held, roles: { lead: { rules: lead.rules, harness: "omp" } } },
  ],
  [
    "changing its model keeps the rest of its choice",
    (layer) => setRole(layer, "lead", { model: "other" }),
    { ...held, roles: { lead: { ...lead, model: "other" } } },
  ],
  [
    "removing a server this layer added forgets it, token and all, rather than keeping it marked removed",
    (layer) => dropMcp(layer, "docs"),
    undocked,
  ],
  [
    "a key typed on the panel goes with the save beside the ones shown as KEPT",
    (layer) => withKey(layer, "jev", "a-new-key"),
    { ...held, sensor: { other: { key: KEPT }, jev: { key: "a-new-key" } } },
  ],
  [
    "forgetting one key leaves the others",
    (layer) => withKey({ ...layer, sensor: { ...layer.sensor, jev: { key: KEPT } } }, "jev", null),
    held,
  ],
  [
    "the last key forgotten leaves no sensor block",
    (layer) => withKey(layer, "other", null),
    { ...held, sensor: undefined },
  ],
  [
    "review's sensor is chosen apart from the watch's",
    (layer) => setReviewSensor(layer, "jev"),
    { ...held, review: { sensor: "jev" } },
  ],
  [
    "going back to the kit's sensor for review leaves no review block",
    (layer) => setReviewSensor({ ...layer, review: { sensor: "jev" } }, undefined),
    held,
  ],
  [
    "the Human's language is kept as they typed it, trimmed",
    (layer) => setLanguage(layer, " Vietnamese "),
    { ...held, language: "Vietnamese" },
  ],
  [
    "emptied, the language is left to the prompts",
    (layer) => setLanguage({ ...layer, language: "Vietnamese" }, " "),
    held,
  ],
];

test("a panel edit changes only what it names and keeps the rest of the layer", () => {
  for (const [what, edit, edited] of EDITS) assert.deepEqual(edit(held), edited, what);
});

test("re-pasting a server the owner gave to nobody leaves it given to nobody", () => {
  const reachable = ["supervisor", "lead", "peer", "reviewer"];
  assert.deepEqual(
    keptRoles([], reachable),
    [],
    "unticking the last role writes an empty list, a narrowing to nobody; a re-paste once gave the server to all four",
  );
  assert.deepEqual(keptRoles(undefined, reachable), reachable, "never narrowed is what does mean every reachable role");
  assert.deepEqual(keptRoles(["lead", "peer"], reachable), ["lead", "peer"]);
  assert.deepEqual(
    keptRoles(["lead", "designer"], reachable),
    ["lead"],
    "and a role that cannot reach it is dropped from the narrowing",
  );
});

test("the model row shows what is in force even when this agent does not list it, and offers a way back", () => {
  const opus = [{ id: "claude-opus-5", label: "Opus 5" }];
  const settled = modelRow("claude-opus-5", opus);
  assert.equal(settled.stray, false);
  assert.deepEqual(settled.options, [{ label: "Opus 5", value: "claude-opus-5" }]);
  const wrong = modelRow("glm-5-air", opus);
  assert.equal(
    wrong.value,
    "glm-5-air",
    "the seat's own model is what is shown, where the screen once printed Opus 5 and no control",
  );
  assert.equal(wrong.stray, true);
  assert.deepEqual(
    wrong.options,
    [
      { label: "Opus 5", value: "claude-opus-5" },
      { label: "glm-5-air", value: "glm-5-air" },
    ],
    "and it stays pickable so the owner can move off it",
  );
  assert.equal(modelRow("", opus).stray, false, "nothing chosen is not a stray choice");
});

const asking = {
  id: "a1",
  label: "Peer",
  status: "running",
  minutes: 2,
  waiting: ["Write outside the working copy"],
  unsandboxed: false,
};
const cart: FlowLane = {
  id: "L1",
  title: "Cart",
  status: "open",
  branch: "lane/l1-cart",
  copy: "S0",
  lead: { ...asking, label: "Lead", waiting: [] },
  kept: [],
  tasks: [],
  taskCount: 3,
  running: 1,
  open: false,
};
const inLoop = { human: true, supervisor: "the Chief" };
const outOfLoop = { human: false, supervisor: "the Chief" };

test("a lane's line never hides a Lead that waits or has gone behind its counts", () => {
  assert.equal(laneLine(cart, false, inLoop).text, "1 running", "the ordinary case is the count");
  assert.deepEqual(
    laneLine({ ...cart, lead: asking }, false, inLoop),
    { tone: "you", text: "waits on you" },
    "lanes start closed, so the lane's line is the only place a Lead waiting on the owner shows",
  );
  assert.equal(
    laneLine({ ...cart, lead: { ...asking, waiting: [], status: "gone" } }, false, inLoop).text,
    "Lead gone",
    "and a Lead that has gone is never news a count may hide",
  );
});

test("a seat waiting on a permission names who answers it, and a landing held before the Human stepped out says so", () => {
  assert.deepEqual(seatLine(asking, inLoop), { tone: "you", text: "waits on you" });
  assert.deepEqual(
    seatLine(asking, outOfLoop),
    { tone: "wait", text: "waits on the Chief" },
    "out of the loop, whoever supervises answers it, not the Human",
  );
  const held: FlowLane = {
    ...cart,
    landApproval: { minutes: 3, approved: false, signals: ["It touches src/auth."], evidence: [] },
  };
  assert.deepEqual(laneLine(held, false, inLoop), { tone: "you", text: "waits on you" });
  assert.deepEqual(laneLine(held, false, outOfLoop), { tone: "wait", text: "held from while you were in" });
});

const judge = { label: "Jev", minutes: null, detail: null };
const kept = "Its answers are kept in assessments.log; no seat is sent them.";
const JUDGES: [WatchJudge, ReturnType<typeof judgeWords>][] = [
  [
    { ...judge, label: "", state: "off" },
    {
      title: "No brain reads what the watch sees",
      hint: "Brains is off: set it on Team, on the Judge. The code's own facts go on.",
      tone: "muted",
    },
  ],
  [
    { ...judge, state: "nokey", detail: "OpenRouter key" },
    {
      title: "Jev is asked nothing: it has no key",
      hint: "Add its OpenRouter key on Team, under Machine defaults, on the Judge. The code's own facts go on.",
      tone: "muted",
    },
  ],
  [
    { ...judge, state: "waiting" },
    { title: "Jev answers the watch's questions", hint: `Nothing has been asked of it yet. ${kept}`, tone: "success" },
  ],
  [
    { ...judge, state: "answering", minutes: 3 },
    { title: "Jev answers the watch's questions", hint: kept, tone: "success" },
  ],
  [
    { ...judge, state: "failing", minutes: 4, detail: "503: busy" },
    {
      title: "Jev is not answering",
      hint: "503: busy. The code's own facts go on; nothing waits for an answer.",
      tone: "warning",
    },
  ],
];

test("the watch card says in words where an incident has got to and who answers the watch's questions, and how that stands, naming roles as the kit labels them", () => {
  assert.deepEqual(incidentLines({ told: 2, held: 1, recorded: 0, closed: 3 }, "Chief"), [
    "2 told the Chief",
    "1 held · nobody is seated to tell",
    "3 told and closed since the report was read",
  ]);
  assert.deepEqual(caseLines({ waiting: 1, expired: 4, dropped: 0, superseded: 2 }, "Judge"), [
    "1 waiting on the Judge",
    "4 expired unjudged",
    "2 folded into a newer case",
  ]);
  for (const [state, words] of JUDGES) assert.deepEqual(judgeWords(state, "Judge"), words, state.state);
});

test("a level's seat: a new agent drops the old one's model and thinking, a new model its thinking, and an emptied level leaves no trace", () => {
  const opus = { harness: "claude", model: "opus", thinking: "high" };
  assert.deepEqual(nextSeat(opus, { thinking: "medium" }), { ...opus, thinking: "medium" });
  assert.deepEqual(nextSeat(opus, { model: "sonnet" }), { harness: "claude", model: "sonnet" });
  assert.deepEqual(nextSeat(opus, { harness: "omp" }), { harness: "omp" });
  assert.deepEqual(nextSeat(opus, { harness: "claude", model: "opus" }), opus, "the same pick again changes nothing");
  const set = setLevelSeat({ rules: "Keep diffs small." }, "max", "lead", opus);
  assert.deepEqual(set.levels, { max: { lead: opus } });
  const both = setLevelSeat(set, "cheap", "peer", { harness: "omp" });
  assert.deepEqual(Object.keys(both.levels ?? {}), ["max", "cheap"], "one level set leaves the others alone");
  assert.deepEqual(
    setLevelSeat(set, "max", "lead", { harness: "omp" }).levels?.max?.lead,
    { harness: "omp" },
    "put in whole",
  );
  assert.deepEqual(setLevelSeat(set, "max", "lead", null), { rules: "Keep diffs small." });
});

test("every row the desk puts in a chat has a kind Paseo's app will draw it by", () => {
  // The app's addTimelineRenderer refuses any other kind, and one refusal fails the plugin's whole client.
  for (const row of Object.values(TIMELINE)) assert.match(row.kind, /^[a-z][a-z0-9-]*$/, row.kind);
});
