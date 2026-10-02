import { recordEvent } from "../store/event-log.ts";
import type { Kit } from "../../catalog/kit/kit.ts";
import { seatOf } from "../../catalog/kit/roles.ts";
import { type Finding, type Incident, deliveryOf, factNext, factTitle, tell, unheard } from "../../domain/incident.ts";
import { closeSeat, forget, openFor, settledAsNoise, sight } from "../store/incidents.ts";
import type { Lane } from "../../domain/lane.ts";
import type { Task } from "../../domain/task.ts";
import { type Ledger, laneOfLead, taskOfPeer } from "../../domain/ledger.ts";
import { loadLedger } from "../store/ledger.ts";
import { errorText } from "../../core/errors.ts";
import { watchLetters } from "../letters/watch-letters.ts";
import type { Project } from "../project/project.ts";
import type { DeskServices } from "../services.ts";

export type Noticed = { id: string; provider: string; title?: string | null };

export type Placed = { where: string; lane?: Lane; task?: Task };

/** Where a seat works, as a letter names it: its role as the kit calls it on a task or of a lane, or its title alone. */
export function placeIn(kit: Kit, ledger: Ledger | undefined, seat: Noticed): Placed {
  const task = ledger && taskOfPeer(ledger, seat.id);
  const lane = task ? ledger.lanes[task.lane] : ledger && laneOfLead(ledger, seat.id);
  const role = seatOf(kit, seat.provider)?.role.label;
  if (task && role) return { where: `the ${role} on ${task.id} (${task.title})`, lane, task };
  if (lane && role) return { where: `the ${role} of ${lane.id} (${lane.title})`, lane };
  const named = seat.title ? `${seat.title} (${seat.id})` : seat.id;
  if (task) return { where: `${named} on ${task.id} (${task.title})`, lane, task };
  if (lane) return { where: `${named} of ${lane.id} (${lane.title})`, lane };
  return { where: named };
}

/** The ledger if it can be read: one that cannot leaves a seat named by its title alone. */
export function ledgerOf(project: Project): Ledger | undefined {
  try {
    return loadLedger(project.state);
  } catch {
    return undefined;
  }
}

export const placeOf = (kit: Kit, project: Project, seat: Noticed): Placed => placeIn(kit, ledgerOf(project), seat);

type Noticing = Pick<DeskServices, "kit" | "incidents" | "teamFor" | "mail" | "roster">;

export async function notice(
  services: Noticing,
  project: Project,
  seat: Noticed,
  findings: Finding[],
  place = placeOf(services.kit, project, seat),
  now = Date.now(),
): Promise<{ opened: Incident[]; sent: string[]; place: Placed }> {
  if (findings.length === 0) return { opened: [], sent: [], place };
  for (const finding of findings) {
    recordEvent(project, {
      kind: "watch.finding",
      agent: seat.id,
      finding: finding.kind,
      level: finding.level,
      quote: finding.quote,
      facts: finding.facts,
    });
  }
  let booked: { opened: Incident[]; sending: Incident[] };
  try {
    booked = openIncidents(services, project, seat, place, findings, now);
  } catch (error) {
    await pageUnbooked(services, project, seat, place, findings, errorText(error));
    throw error;
  }
  const { opened, sending } = booked;
  const sent = sending.length > 0 ? await deliver(services, project, seat, place, sending, now) : [];
  return { opened, sent, place };
}

/** A page reaches whoever supervises whatever the book can keep: with none to read, it goes unbooked. */
async function pageUnbooked(
  { roster, mail, teamFor }: Pick<DeskServices, "roster" | "mail" | "teamFor">,
  project: Project,
  seat: Noticed,
  place: Placed,
  findings: Finding[],
  fault: string,
): Promise<void> {
  const pages = findings.filter((finding) => finding.level === "page");
  if (pages.length === 0) return;
  const to = await roster.supervisorFor(project, place.lane?.opener).catch(() => undefined);
  if (!to || to === seat.id) return;
  const human = teamFor(project).hitl.on;
  for (const page of pages) await mail.post(to, watchLetters.unbooked(page, place, seat.id, fault, { human }));
}

function openIncidents(
  { incidents, teamFor }: Pick<DeskServices, "incidents" | "teamFor">,
  project: Project,
  seat: Noticed,
  place: Placed,
  findings: Finding[],
  now: number,
): { opened: Incident[]; sending: Incident[] } {
  const kept = teamFor(project).attention.incidentsKept;
  return incidents.transact(project, (book) => {
    const opened: Incident[] = [];
    const sending: Incident[] = [];
    for (const finding of findings) {
      const sighting = {
        seat: seat.id,
        provider: seat.provider,
        where: place.where,
        lane: place.lane?.id,
        task: place.task?.id,
        kind: finding.kind,
        level: finding.level,
        quote: finding.quote,
        ...(finding.digest !== undefined && { digest: finding.digest }),
        facts: finding.facts,
        ...(finding.theirs && { theirs: finding.theirs }),
        ...(finding.brain && { brain: finding.brain }),
      };
      const joined = finding.joins ? openFor(book, seat.id, finding.joins) : undefined;
      if (joined) {
        joined.evidence = [...(joined.evidence ?? []), `${finding.kind}: ${finding.quote}`];
        joined.facts = [...new Set([...joined.facts, ...finding.facts])];
        recordEvent(project, { kind: "incident.evidence", id: joined.id, agent: seat.id, finding: finding.kind });
        continue;
      }
      if (settledAsNoise(book, sighting, now)) continue;
      const { incident, opened: isNew } = sight(book, sighting, now);
      if (deliveryOf(incident) !== "told" && tell(incident, now)) sending.push({ ...incident });
      if (isNew) {
        recordEvent(project, {
          kind: "incident.open",
          id: incident.id,
          agent: seat.id,
          finding: incident.kind,
          level: incident.level,
          held: incident.held ?? null,
        });
        opened.push({ ...incident });
      }
    }
    forget(book, kept);
    return { opened, sending };
  });
}

/**
 * Tells whoever supervises the seat's lane each incident, pages first: W's only edge is to the Supervisor, never to a Lead
 * and never to the seat it watched. With nobody seated to tell, each is held until somebody sits down.
 */
async function deliver(
  services: Noticing,
  project: Project,
  seat: Noticed,
  place: Placed,
  sending: Incident[],
  now: number,
): Promise<string[]> {
  const { kit, incidents, mail, roster, teamFor } = services;
  const human = teamFor(project).hitl.on;
  let to: string | undefined;
  try {
    to = await roster.supervisorFor(project, place.lane?.opener);
  } catch (error) {
    recordEvent(project, { kind: "incident.lookup-failed", error: errorText(error) });
  }
  if (!to || to === seat.id) {
    unheardAll(
      incidents,
      project,
      sending.map((sent) => sent.id),
      now,
    );
    for (const sent of sending) recordEvent(project, { kind: "incident.held", id: sent.id, held: "nobody" });
    return [];
  }
  const pagesFirst = [...sending].sort((a, b) => Number(a.level !== "page") - Number(b.level !== "page"));
  const told: string[] = [];
  const failed: string[] = [];
  for (const incident of pagesFirst) {
    try {
      const pattern = kit.patterns[incident.kind];
      const title = pattern?.title ?? factTitle(incident.kind);
      const next = pattern?.next ?? factNext(incident.kind);
      const words = { human, ...(title ? { title } : {}), ...(next ? { next } : {}) };
      await mail.post(to, watchLetters.incident(incident, place, words));
      told.push(incident.id);
    } catch (error) {
      failed.push(incident.id);
      recordEvent(project, { kind: "incident.post-failed", id: incident.id, error: errorText(error) });
    }
  }
  // A letter that never left told nobody: the incident waits, as for nobody seated, and a later round tells it.
  if (failed.length > 0) unheardAll(incidents, project, failed, now);
  recordEvent(project, { kind: "incident.told", ids: told, to });
  return told;
}

function unheardAll(incidents: DeskServices["incidents"], project: Project, ids: string[], now: number): void {
  incidents.transact(project, (book) => {
    for (const id of ids) {
      const incident = book.items[id];
      if (incident?.told === now) unheard(incident);
    }
  });
}

export async function retell(services: Noticing, project: Project, now = Date.now()): Promise<string[]> {
  const { incidents } = services;
  const told: string[] = [];
  const nobody = incidents.transact(project, (incidents) =>
    Object.values(incidents.items)
      .filter((item) => item.open && item.held === "nobody" && item.told === undefined)
      .map((item) => ({ ...item })),
  );
  for (const seat of [...new Set(nobody.map((item) => item.seat))]) {
    const noticed = { id: seat, provider: nobody.find((item) => item.seat === seat)!.provider ?? "" };
    const place = placeOf(services.kit, project, noticed);
    // Only once somebody is seated to read them; `deliver` then finds that somebody again.
    let reader: string | undefined;
    try {
      reader = await services.roster.supervisorFor(project, place.lane?.opener);
    } catch {
      // Nobody could be looked up: these stay held for nobody until a later round finds someone.
    }
    if (!reader || reader === seat) continue;
    const mine = nobody.filter((item) => item.seat === seat);
    const sending = incidents.transact(project, (incidents) => {
      const taken: Incident[] = [];
      for (const item of mine) {
        const incident = incidents.items[item.id];
        if (incident?.open && incident.held === "nobody" && tell(incident, now)) taken.push({ ...incident });
      }
      return taken;
    });
    if (sending.length > 0) told.push(...(await deliver(services, project, noticed, place, sending, now)));
  }
  return told;
}

export function closeIncidentsOf(
  { incidents }: Pick<DeskServices, "incidents">,
  project: Project,
  seat: string,
  now = Date.now(),
): string[] {
  return incidents.transact(project, (book) => closeSeat(book, seat, now));
}
