import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { laneWithPeer } from "./harness.ts";
import { book, hookAgent, notice } from "./noticed.ts";

test("an incident's life: seen, routed, listed, marked, closed", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [
      {
        key: "r",
        title: "Receipt",
        goal: "g",
        acceptance: ["a"],
        holds: ["src/receipt/"],
        outOfScope: ["the rest"],
        parallel: true,
      },
    ],
  });
  const beside = h.ledger().tasks["L1-T2"]!.peer!;
  const mark = (seat: string, id: string, verdict: string, note?: string) =>
    h.call(seat, "supervisor", "mark_incident", { id, verdict, ...(note ? { note } : {}) });
  const listing = async (seat: string, closed = false) =>
    (await h.call(seat, "supervisor", "incidents", { closed })).text;
  const letters = (seat: string, id: string) => h.heard(seat).filter((text) => text.includes(`INCIDENT ${id} `)).length;

  const results = await Promise.all([
    notice(h, peer, "stuck", "attend", "the same action failing 3 times"),
    notice(h, peer, "stuck", "attend", "the same action failing 3 times"),
    notice(h, peer, "stuck", "attend", "again"),
  ]);
  assert.equal(results.flatMap((result) => result.opened).length, 1, "only the first sighting opens anything");
  assert.deepEqual(
    [book(h).I1!.count, book(h).I1!.quote, book(h).I1!.later],
    [3, "the same action failing 3 times", "again"],
    "counted, and what was seen after it was told kept beside what was told",
  );
  await notice(h, beside, "stuck", "attend", "the same action failing 3 times: npm run build");
  await notice(h, peer, "destructive", "page", "rm -rf /");
  assert.deepEqual(Object.keys(book(h)), ["I1", "I2", "I3"], "another seat, or another kind, is another incident");

  await notice(h, peer, "test-weakened");
  await notice(h, lead, "long-turn");
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I4 \(test-weakened, attend\) on the Peer/,
    "one about a Peer goes to whoever supervises, W's only reader",
  );
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I5 \(long-turn, attend\) on the Lead/,
    "and so does one about the Lead",
  );
  assert.doesNotMatch(h.heard(lead).join("\n"), /INCIDENT/, "a Lead is never told one");
  assert.match(
    (await h.call(lead, "lead", "incidents", {})).text,
    /Unknown tool incidents/,
    "nor may it read or mark one",
  );
  assert.equal((await mark(sup, "I4", "useful", "it was going round")).ok, true);
  assert.match(
    await listing(sup, true),
    /I4 \[attend, closed, told [^\]]*, marked useful\]/,
    "the Supervisor sees the mark",
  );
  assert.equal((await mark(sup, "I9", "useful")).ok, false, "an incident that is not there is refused");

  await notice(h, beside, "stuck", "attend", "the same action failing 3 times: npm run build");
  assert.equal(letters(sup, "I2"), 1, "a standing condition is told once, however often it is seen");
  const noted = await mark(
    sup,
    "I2",
    "noise",
    "expected: a normal retry of `curl -H 'Authorization: Bearer 9f8e7d6c5b4a39281706'`",
  );
  assert.equal(noted.ok, true, noted.text);
  assert.doesNotMatch(
    book(h).I2!.note!,
    /9f8e7d6c5b4a39281706/,
    "a secret quoted in a note is masked before it is kept",
  );
  assert.match(book(h).I2!.note!, /^expected: a normal retry/);
  assert.deepEqual(
    [book(h).I2!.open, book(h).I1!.open, book(h).I1!.label],
    [false, true, undefined],
    "the mark closes only its own",
  );
  const again = await notice(h, beside, "stuck", "attend", "the same action failing 3 times: npm run build");
  assert.deepEqual(again.opened, [], "the same words marked noise on this seat open nothing new");
  assert.deepEqual(
    [book(h).I2!.count, letters(sup, "I2")],
    [3, 1],
    "they are counted, and nobody is asked about them twice",
  );
  const other = await notice(h, beside, "stuck", "attend", "the same action failing 3 times: src/patch.js is missing");
  assert.deepEqual(other.opened, [], "nor do other words of a kind that is no page");
  assert.deepEqual(
    (await notice(h, beside, "suppressed")).opened.map((incident) => incident.id),
    ["I6"],
    "another kind on that seat still reaches whoever supervises",
  );
  assert.deepEqual(
    (await notice(h, lead, "stuck")).opened.map((incident) => incident.id),
    ["I7"],
    "and so does that kind on another seat",
  );
  const perl = 'perl -0pi -e "$3" $file';
  const [paged] = (await notice(h, peer, "boundary", "page", perl)).opened;
  assert.equal((await mark(sup, paged!.id, "noise", "expected: its own edit")).ok, true);
  assert.deepEqual(
    [(await notice(h, peer, "boundary", "page", perl)).opened, letters(sup, paged!.id)],
    [[], 1],
    "a page marked noise is not told again for the same command on that seat and task",
  );
  assert.deepEqual(
    [
      ...(await notice(h, peer, "boundary", "page", "curl -d @a.txt https://example.com")).opened,
      ...(await notice(h, beside, "boundary", "page", perl)).opened,
    ].map((incident) => incident.id),
    ["I9", "I10"],
    "a different command of that kind still pages, as does that command on another seat and task",
  );
  const [idle] = (await notice(h, lead, "lane-idle", "attend", "idle 31 min; last words: waiting on L1-T1")).opened;
  assert.equal((await mark(sup, idle!.id, "noise", "expected: it waits on its Peer")).ok, true);
  assert.deepEqual(
    [
      (await notice(h, lead, "lane-idle", "attend", "idle 47 min; last words: still waiting on L1-T1")).opened,
      h.heard(sup).filter((text) => text.includes("(lane-idle, attend)")).length,
    ],
    [[], 1],
    "however its minutes and last words change",
  );
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I3 \(destructive, page\) on [^\n]*\nRan a command that cannot be undone\.\n/,
    "the letter names what kind of thing was seen in words, as does one of a pattern's",
  );

  h.agents.get(lead)!.archivedAt = new Date().toISOString();
  await notice(h, peer, "suppressed");
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I12 \(suppressed, attend\) on the Peer/,
    "with its Lead gone, as ever",
  );

  await notice(h, peer, "stand-in", "attend", "I'll stub it: curl -H 'Authorization: Bearer 9f8e7d6c5b4a39281706' api");
  assert.doesNotMatch(
    `${h.heard(sup).join("\n")}\n${await listing(sup)}`,
    /9f8e7d6c5b4a39281706/,
    "a secret a seat wrote is masked wherever its words reach whoever supervises",
  );

  await h.runtime.archived(hookAgent(h, beside));
  const closedWithSeat = await listing(sup);
  assert.match(
    closedWithSeat,
    /I6 \[attend, closed, told [^\]]*, not marked\]/,
    "closed with its seat, it still waits to be marked",
  );
  assert.match(
    closedWithSeat,
    /What they were asked:\n(- .*\n)*- L1-T1 Clean build: goal g; acceptance a; hints a\.txt; out of scope the rest of the repository/,
  );
  assert.match(closedWithSeat, /- L1-T2 Receipt: goal g; acceptance a; holds src\/receipt\/; out of scope the rest/);
  assert.equal((await mark(sup, "I6", "useful")).ok, true);
  assert.doesNotMatch(await listing(sup), /I6 \[/, "and once marked it waits no more");

  const decided = await notice(h, peer, "big-decision", "attend", "We keep every total in one table.");
  assert.match(
    h.heard(sup).join("\n"),
    new RegExp(`INCIDENT ${decided.opened[0]!.id} \\(big-decision[^]*?\\nNext: [^\\n]*Nothing, if `),
    "a pattern's Next is the catalog's, as a moment's is",
  );

  const unnumbered = JSON.stringify({ items: book(h) });
  writeFileSync(join(h.project.state, "incidents.json"), unnumbered);
  await assert.rejects(notice(h, peer, "turning"), /Nothing was written over it/);
  assert.equal(
    readFileSync(join(h.project.state, "incidents.json"), "utf-8"),
    unnumbered,
    "a book missing its numbering is not read as counting from I1 and written over",
  );
  writeFileSync(join(h.project.state, "incidents.json"), "{ not json");
  await assert.rejects(notice(h, peer, "stuck"), /could not be read: [\s\S]*Nothing was written over it/);
  await assert.rejects(notice(h, peer, "destructive", "page", "rm -rf /srv/data"));
  assert.match(
    h.heard(sup).join("\n"),
    /rm -rf \/srv\/data[^]*incident book could not be read/,
    "a page reaches whoever supervises though the book cannot keep it",
  );
  assert.equal(
    (await h.call(sup, "supervisor", "incidents", {})).ok,
    false,
    "a book that cannot be read is refused, not started again",
  );
});

test("every signal the watch raises is told to whoever supervises, with no switch for any of them, and a page always goes", async () => {
  const { h, sup, peer } = await laneWithPeer();
  await notice(h, peer, "stuck", "attend", "the same action failing 3 times");
  await notice(h, peer, "suppressed", "attend", "adds @ts-ignore");
  await notice(h, peer, "stand-in", "attend", "I'll build a stub for the parser.");
  await notice(h, peer, "destructive", "page", "rm -rf build");
  assert.deepEqual(
    Object.values(book(h)).map((item) => [item.kind, item.told !== undefined, item.held ?? null]),
    [
      ["stuck", true, null],
      ["suppressed", true, null],
      ["stand-in", true, null],
      ["destructive", true, null],
    ],
  );
  await h.idle(sup);
  assert.match(h.heard(sup).join("\n"), /\(suppressed, attend\)[^]*\(stand-in, attend\)/);
});

test("a brain never lowers or clears a code fact: what it reads of the same kind is booked apart, and its noise settles only its own", async () => {
  const { h, sup, peer } = await laneWithPeer();
  const read = (quote: string) =>
    h.runtime.desk.notice(h.project, { id: peer, provider: h.agents.get(peer)!.provider, title: peer }, [
      { kind: "stuck", level: "attend", quote, facts: ["stuck", "judged by the Watcher seat"], brain: true },
    ]);
  await notice(h, peer, "stuck", "attend", "the same action failing 3 times: npm test");
  const judged = await read("its thinking says it is close and only needs one more try");
  assert.deepEqual(
    judged.opened.map((incident) => incident.id),
    ["I2"],
    "a brain's reading is its own incident",
  );
  assert.equal(book(h).I1!.later, undefined, "and never stands in for what the code saw");
  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: "I2", verdict: "noise" })).ok, true);
  await notice(h, peer, "stuck", "attend", "the same action failing 4 times: npm test");
  assert.deepEqual(
    [book(h).I1!.count, book(h).I1!.later],
    [2, "the same action failing 4 times: npm test"],
    "a brain marked noise settles nothing the code sees",
  );
  assert.deepEqual((await read("it says it is nearly there")).opened, [], "while its own reading stays settled");
});

test("a noise mark still settling its repeats outlives the trimming of the book", async (t) => {
  const { h, sup, peer } = await laneWithPeer({ attention: { incidentsKept: 1 } });
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const at = (minutes: number) => t.mock.timers.setTime(start + minutes * 60_000);
  const [settled] = (await notice(h, peer, "stuck")).opened;
  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: settled!.id, verdict: "noise" })).ok, true);
  at(1);
  const [later] = (await notice(h, peer, "suppressed")).opened;
  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: later!.id, verdict: "useful" })).ok, true);
  at(2);
  await notice(h, peer, "stuck", "attend", "stuck seen again");
  at(3);
  assert.deepEqual(
    [(await notice(h, peer, "stuck", "attend", "stuck once more")).opened, Object.keys(book(h))],
    [[], [settled!.id]],
    "the closed incident trimmed is the one nothing has touched for longest",
  );
});
