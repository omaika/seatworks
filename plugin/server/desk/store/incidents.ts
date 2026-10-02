import { join } from "node:path";
import { isRecord } from "../../core/json.ts";
import { readJsonFile, readKept, writeJson } from "../../core/store.ts";
import { type Incident, close } from "../../domain/incident.ts";

export type Incidents = { next: number; items: Record<string, Incident> };

type Sighting = Omit<
  Incident,
  "id" | "opened" | "last" | "count" | "open" | "told" | "held" | "label" | "note" | "closed" | "later"
>;

function incidentsFile(state: string): string {
  return join(state, "incidents.json");
}

const empty = (): Incidents => ({ next: 1, items: {} });

const isIncidents = (value: unknown): value is Incidents =>
  isRecord(value) && Number.isInteger(value.next) && (value.next as number) > 0 && isRecord(value.items);

/** The book from one read, or why it cannot be read: written over, what it holds would be lost. */
export function readIncidentsFile(state: string): { incidents: Incidents } | { fault: string } {
  const read = readKept(incidentsFile(state), empty(), isIncidents);
  return "fault" in read ? read : { incidents: read.value };
}

/** For a view: a book that cannot be read shows as empty. */
export function loadIncidents(state: string): Incidents {
  const read = readJsonFile(incidentsFile(state));
  return "value" in read && isIncidents(read.value) ? read.value : empty();
}

export function saveIncidents(state: string, incidents: Incidents): void {
  writeJson(incidentsFile(state), incidents);
}

/** The open incident of a kind on a seat, seen by the same eye, so a brain's never adds to the code's. */
export function openFor(incidents: Incidents, seat: string, kind: string, brain = false): Incident | undefined {
  return Object.values(incidents.items).find(
    (item) => item.open && item.seat === seat && item.kind === kind && Boolean(item.brain) === brain,
  );
}

/** Whether this exact sentence was already recorded for this seat and kind, open or closed: the book, not the process, survives a restart. */
export function saidBefore(incidents: Incidents, seat: string, kind: string, quote: string): boolean {
  return Object.values(incidents.items).some(
    (item) => item.seat === seat && item.kind === kind && (item.quote === quote || item.later === quote),
  );
}

const episode = (item: { task?: string; lane?: string }) => item.task ?? item.lane;

/** The same seat, kind and eye, and for a page the same command too, since another may be the dangerous one. */
const alike = (item: Incident, sighting: Sighting) =>
  item.seat === sighting.seat &&
  item.kind === sighting.kind &&
  Boolean(item.brain) === Boolean(sighting.brain) &&
  (sighting.level !== "page" || item.quote === sighting.quote);

/**
 * Already settled as noise: counts the sighting and answers true. `mark_incident` closes an incident, so a standing
 * condition would reopen after every mark. A mark settles its kind on that seat and task, or lane where there is no
 * task, in whatever words; a page only for the command it was told, since another may be the dangerous one. Each eye's
 * marks settle only its own.
 */
export function settledAsNoise(incidents: Incidents, sighting: Sighting, now: number): boolean {
  const marked = Object.values(incidents.items).find(
    (item) => !item.open && item.label === "noise" && alike(item, sighting) && episode(item) === episode(sighting),
  );
  if (!marked) return false;
  marked.count += 1;
  marked.last = now;
  return true;
}

/** Adds a sighting to the open incident it is alike, or opens one: a different command of a page kind pages on its own. */
export function sight(incidents: Incidents, sighting: Sighting, now: number): { incident: Incident; opened: boolean } {
  const seen = Object.values(incidents.items).find((item) => item.open && alike(item, sighting));
  if (seen) {
    Object.assign(seen, { facts: [...new Set([...seen.facts, ...sighting.facts])], last: now, count: seen.count + 1 });
    if (seen.told === undefined) seen.quote = sighting.quote;
    else seen.later = sighting.quote;
    return { incident: seen, opened: false };
  }
  const incident: Incident = { ...sighting, id: `I${incidents.next}`, opened: now, last: now, count: 1, open: true };
  incidents.next += 1;
  incidents.items[incident.id] = incident;
  return { incident, opened: true };
}

export function closeSeat(incidents: Incidents, seat: string, now: number): string[] {
  const closed: string[] = [];
  for (const item of Object.values(incidents.items)) {
    if (item.seat === seat && close(item, now)) closed.push(item.id);
  }
  return closed;
}

/** Trims the oldest closed incidents past `kept`, by when last seen or closed: a noise mark still settling goes last. */
export function forget(incidents: Incidents, kept: number): void {
  const since = (item: Incident) => Math.max(item.closed ?? 0, item.last);
  const done = Object.values(incidents.items)
    .filter((item) => !item.open)
    .sort((a, b) => since(a) - since(b));
  for (const item of done.slice(0, Math.max(0, done.length - kept))) delete incidents.items[item.id];
}
