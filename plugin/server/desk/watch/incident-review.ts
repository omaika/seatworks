import { mask } from "../../core/mask.ts";
import { oneLine } from "../../core/text.ts";
import { close } from "../../domain/incident.ts";
import { type Caller, type ToolReply, no, ok, str } from "../context.ts";
import type { Incident } from "../../domain/incident.ts";
import { readIncidentsFile } from "../store/incidents.ts";
import { loadLedger } from "../store/ledger.ts";
import type { DeskServices } from "../services.ts";
import { recordEvent } from "../store/event-log.ts";

type Verdict = NonNullable<Incident["label"]>;

const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function line(item: Incident): string {
  const sent = `told ${at(item.told ?? item.last)}`;
  const state = item.open ? sent : ["closed", sent, item.label ? `marked ${item.label}` : "not marked"].join(", ");
  const seen = item.count > 1 ? ` (seen ${item.count} times, last ${at(item.last)})` : "";
  const later = item.later !== undefined ? `; seen after you were told: ${oneLine(item.later, 200)}` : "";
  const evidence = (item.evidence ?? []).map((quote) => `; also read: ${oneLine(quote, 300)}`).join("");
  return `- ${item.id} [${item.level}, ${state}] ${item.where}, agent ${item.seat}: ${item.kind}${seen} — ${oneLine(item.quote, 300)}${later}${evidence}`;
}

function briefs(state: string, shown: Incident[]): string[] {
  let ledger;
  try {
    ledger = loadLedger(state);
  } catch {
    // What they were asked is context, not the list: an unreadable ledger leaves it out.
    return [];
  }
  const text = oneLine;
  const out: string[] = [];
  for (const id of [...new Set(shown.flatMap((item) => (item.task ? [item.task] : [])))]) {
    const task = ledger.tasks[id];
    if (task)
      out.push(
        `- ${task.id} ${text(task.title, 120)}: goal ${text(task.goal, 300)}; acceptance ${text(task.acceptance.join("; "), 300)}; ${task.holds.length > 0 ? `holds ${text(task.holds.join(", "), 200)}` : `hints ${text(task.hints.join(", ") || "none", 200)}`}; out of scope ${text(task.outOfScope.join("; ") || "nothing named", 200)}`,
      );
  }
  for (const id of [...new Set(shown.flatMap((item) => (item.lane && !item.task ? [item.lane] : [])))]) {
    const lane = ledger.lanes[id];
    if (lane)
      out.push(
        `- ${lane.id} ${text(lane.title, 120)}: outcome ${text(lane.outcome, 300)}; acceptance ${text(lane.acceptance.join("; "), 300)}; out of scope ${text(lane.outOfScope.join("; ") || "nothing named", 200)}`,
      );
  }
  return out.length > 0 ? ["", "What they were asked:", ...out] : [];
}

/** The incidents told to whoever supervises and not yet marked, newest first, with what their seats were asked. */
export function listIncidents(caller: Caller, withClosed: boolean): ToolReply {
  const read = readIncidentsFile(caller.project.state);
  if ("fault" in read) return no(`${read.fault}. Only the Human can repair it or move it aside.`);
  const all = Object.values(read.incidents.items).filter((item) => item.told !== undefined);
  const waiting = all.filter((item) => item.open || !item.label).sort((a, b) => b.last - a.last);
  const shown = waiting.slice(0, 50);
  const lines = [waiting.length > 0 ? `${waiting.length} not yet marked:` : "Nothing waiting to be marked."];
  lines.push(...shown.map(line));
  if (waiting.length > shown.length) lines.push(`… and ${waiting.length - shown.length} older ones not shown.`);
  lines.push(...briefs(caller.project.state, shown));
  if (withClosed) {
    const marked = all
      .filter((item) => item.label)
      .sort((a, b) => (b.closed ?? b.last) - (a.closed ?? a.last))
      .slice(0, 20);
    lines.push("", marked.length > 0 ? "Recently marked:" : "Nothing marked yet.", ...marked.map(line));
  }
  if (waiting.length > 0)
    lines.push(
      "",
      "Each is a signal to look at, not a verdict. Mark each one with mark_incident once you have looked at the agent's record: a mark of noise keeps that kind on that seat and its task, or its lane where it has none, from coming back to you in any words; a page, only for that same command.",
    );
  recordEvent(caller.project, { kind: "incident.read", agent: caller.id, waiting: waiting.length });
  return ok(lines.join("\n"));
}

/** Marks an incident the caller may see as useful, noise or unknown, and closes it: noise settles its kind on that seat and task, a page only for that command. */
export function markIncident(
  { incidents }: Pick<DeskServices, "incidents">,
  caller: Caller,
  marked: { id: string; verdict: Verdict; note?: string },
): ToolReply {
  const id = str(marked.id);
  const { verdict } = marked;
  const note = mask(str(marked.note));
  const now = Date.now();
  const done = incidents.transact(caller.project, (held) => {
    const item = held.items[id];
    if (!item || item.told === undefined) return undefined;
    item.label = verdict;
    if (note) item.note = note;
    close(item, now);
    return { ...item };
  });
  if (!done) return no(`There is no incident ${id} told to you to mark: incidents lists those.`);
  recordEvent(caller.project, {
    kind: "incident.ack",
    id,
    agent: caller.id,
    verdict,
    note: note || null,
    seat: done.seat,
    finding: done.kind,
    opened: done.opened,
    last: done.last,
  });
  const later =
    done.later !== undefined
      ? ` It was seen ${done.count} times, the last at ${at(done.last)} after you were told: ${oneLine(done.later, 200)}`
      : "";
  return ok(`${id} marked ${verdict} and closed.${later}`);
}
