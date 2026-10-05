import assert from "node:assert/strict";
import { test } from "node:test";
import { KEPT, type Layer, REVIEW_OFF } from "../../shared/settings.ts";
import { laneLine, seatLine } from "../../client/format/flow.ts";
import { caseLines, incidentLines, judgeWords } from "../../client/format/watch.ts";
import {
  dropMcp,
  keptRoles,
  modelRow,
  setLanguage,
  nextSeat,
  reviewOptions,
  setLevelSeat,
  setReviewSensor,
  setRole,
  withKey,
} from "../../client/model/layer.ts";
import type { FlowLane, WatchJudge } from "../../shared/flow-views.ts";
import type { TeamView } from "../../shared/views.ts";
import { keyWords, reviewLine, watchKeyLine } from "../../client/model/key-rows.ts";
import { TIMELINE } from "../../shared/timeline-items.ts";
import { resolveTeam } from "../../server/catalog/team/team.ts";
import { makeKit } from "../kit.ts";

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

test("a key typed for the watch's sensor is gone once its row goes, and does not come back with it", () => {
  const sensors = [{ id: "jev" }, { id: "other" }];
  const reading: TeamView["attention"] = { watch: true, brain: "sensor", sensor: "jev" };
  const typed = { jev: "jev-key" };
  const ids = (line: ReturnType<typeof watchKeyLine>) => line.rows.map((row) => row.sensor.id);
  const rows: [TeamView["attention"]["brain"], string[]][] = [
    ["off", []],
    ["seat", []],
    ["sensor", ["jev"]],
    ["both", ["jev"]],
  ];
  for (const [brain, keyed] of rows)
    assert.deepEqual(ids(watchKeyLine(sensors, { watch: true, brain, sensor: "jev" }, {})), keyed, `brains ${brain}`);
  assert.deepEqual(ids(watchKeyLine(sensors, { ...reading, watch: false }, {})), [], "the watch off asks no sensor");
  assert.equal(watchKeyLine(sensors, reading, typed).drafts, typed, "kept while its own sensor's row shows");
  const moved = watchKeyLine(sensors, { watch: true, brain: "sensor", sensor: "other" }, typed).drafts;
  assert.deepEqual(moved, {}, "never left for another sensor's Save");
  assert.deepEqual(
    watchKeyLine(sensors, { watch: true, brain: "seat", sensor: "jev" }, typed).drafts,
    {},
    "dropped with its row",
  );
  assert.deepEqual(watchKeyLine(sensors, reading, moved).drafts, {}, "not brought back when the first sensor returns");
});

test("review's line offers a key row wherever a project's review could ask with it, and none where nothing asks", () => {
  const sensors = [{ id: "jev" }, { id: "other" }];
  const team = { review: { sensor: "other" }, attention: { watch: true, brain: "seat", sensor: "jev" } } as const;
  const off: Layer = { review: { sensor: REVIEW_OFF } };
  const rows: [string, Layer, Layer, "machine" | "project", string[]][] = [
    ["machine Off still offers every key a project may name", off, {}, "machine", ["jev", "other"]],
    ["a project naming one under machine Off shows that one's", { review: { sensor: "jev" } }, off, "project", ["jev"]],
    ["a project that names none under machine Off asks nothing, so no key row warns", {}, off, "project", []],
    ["no choice falls to the sensor review resolves to", {}, {}, "machine", ["other"]],
  ];
  for (const [what, values, machine, layer, offered] of rows)
    assert.deepEqual(
      reviewLine(sensors, team, values, machine, layer, {}).rows.map((row) => row.sensor.id),
      offered,
      what,
    );
});

test("review's select shows only what its own page picked, so the machine's Off is never shown as a project's choice", () => {
  const sensors = [{ id: "jev" }];
  const team = { review: { sensor: null }, attention: { watch: true, brain: "seat", sensor: "jev" } } as const;
  const off: Layer = { review: { sensor: REVIEW_OFF } };
  assert.equal(reviewLine(sensors, team, {}, off, "project", {}).value, "", "inherited Off shows as the empty choice");
  assert.equal(reviewLine(sensors, team, off, {}, "machine", {}).value, REVIEW_OFF, "Off picked here shows as Off");
});

test("a key typed on review's line goes with its row, so a sensor that comes back shows no hidden key to save", () => {
  const sensors = [{ id: "jev" }, { id: "other" }];
  const team = { review: { sensor: "jev" }, attention: { watch: true, brain: "seat", sensor: "jev" } } as const;
  const off: Layer = { review: { sensor: REVIEW_OFF } };
  const typed = { jev: "jev-key", other: "other-key" };
  assert.equal(reviewLine(sensors, team, off, {}, "machine", typed).drafts, typed, "kept while every row shows");
  const named = reviewLine(sensors, team, { review: { sensor: "other" } }, {}, "machine", typed).drafts;
  assert.deepEqual(named, { other: "other-key" }, "a sensor that leaves the line takes its typed key with it");
  const back = reviewLine(sensors, team, off, {}, "machine", named).drafts;
  assert.equal(back.jev, undefined, "not brought back when the sensor returns");
});

test("with Jev off on the machine, its key row is offered as optional and warns of nothing", () => {
  const jev = { id: "jev", label: "Jev", key: "OpenRouter key" };
  const off: Layer = { review: { sensor: REVIEW_OFF } };
  const team = { review: { sensor: null }, attention: { watch: true, brain: "seat", sensor: "jev" } } as const;
  const words = (attention: TeamView["attention"], kept: boolean) => {
    const [row] = reviewLine([jev], { ...team, attention }, off, {}, "machine", {}).rows;
    return keyWords(row!.sensor, { asked: row!.asked, kept, layer: "machine", role: "Watcher" });
  };
  for (const kept of [false, true]) {
    const said = words(team.attention, kept);
    assert.equal(said.status, null, `${kept ? "kept" : "no key"}: no status to warn with`);
    assert.match(said.label, /optional/i, `${kept ? "kept" : "no key"}: the field says it is optional`);
    assert.match(said.hint, /only when a project turns Jev on/, `${kept ? "kept" : "no key"}: and when it is needed`);
  }
  const [missing, kept] = [words(team.attention, false), words(team.attention, true)];
  assert.equal(missing.label, kept.label, "no key: the field is named as when one is kept");
  assert.ok(kept.hint.includes(missing.hint), `no key: nothing said of the missing key\n${missing.hint}`);
  const reading = words({ watch: true, brain: "sensor", sensor: "jev" }, false);
  assert.doesNotMatch(reading.label, /optional/i, "a key the machine's own watch asks with is not called optional");
});

test("review's choice on a page says what its empty choice inherits, and the one picked is what review resolves to", () => {
  const base = makeKit();
  const spec = { key: "OpenRouter key", url: "https://x", model: "m", terms: "t", timeoutSeconds: 5, retries: 0 };
  const kit = {
    ...base,
    attention: { ...base.attention, sensor: "jev" },
    sensors: { jev: { ...spec, id: "jev", label: "Jev" }, other: { ...spec, id: "other", label: "Other" } },
  };
  const sensors = Object.values(kit.sensors);
  const off: Layer = { review: { sensor: REVIEW_OFF } };
  const rows: [string, Layer, "machine" | "project", string, string, Layer, string][] = [
    ["machine, nothing chosen", {}, "machine", "As the kit has it: Jev, the kit's sensor", "", {}, "jev"],
    ["project under the machine's Off", off, "project", "As Machine defaults: Off", "", {}, REVIEW_OFF],
    [
      "project naming the kit's sensor under the machine's Off",
      off,
      "project",
      "As Machine defaults: Off",
      "Jev, the kit's sensor",
      { review: { sensor: "jev" } },
      "jev",
    ],
    [
      "project naming another under the machine's Off",
      off,
      "project",
      "As Machine defaults: Off",
      "Other",
      { review: { sensor: "other" } },
      "other",
    ],
    ["project turning review Off", {}, "project", "As the kit has it: Jev, the kit's sensor", "Off", off, REVIEW_OFF],
  ];
  for (const [what, machine, layer, empty, picked, saved, resolved] of rows) {
    const options = reviewOptions(sensors, "jev", machine, layer);
    assert.equal(options[0]!.label, empty, `${what}: the empty choice`);
    const value = picked ? options.find((option) => option.label === picked)?.value : "";
    assert.notEqual(value, undefined, `${what}: ${picked} is offered`);
    const layered = setReviewSensor({}, value || undefined);
    assert.deepEqual(layered, saved, `${what}: what is saved`);
    const { review } = resolveTeam(kit, machine, layer === "project" ? layered : {});
    assert.equal(review.off ? REVIEW_OFF : review.sensor?.id, resolved, `${what}: what review resolves to`);
  }
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

const judge = { label: "Jev", minutes: null, detail: null, keyless: null };
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
    { ...judge, label: "The Watcher", state: "waiting", keyless: { label: "Jev", key: "OpenRouter key" } },
    {
      title: "Jev is asked nothing: it has no key. The Watcher answers the watch's questions",
      hint: `Add its OpenRouter key on Team, under Machine defaults, on the Judge. Nothing has been asked of it yet. ${kept}`,
      tone: "muted",
    },
  ],
  [
    {
      ...judge,
      label: "The Watcher",
      state: "failing",
      minutes: 4,
      detail: "503: busy",
      keyless: { label: "Jev", key: "OpenRouter key" },
    },
    {
      title: "Jev is asked nothing: it has no key. The Watcher is not answering",
      hint: "Add its OpenRouter key on Team, under Machine defaults, on the Judge. 503: busy. The code's own facts go on; nothing waits for an answer.",
      tone: "warning",
    },
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
