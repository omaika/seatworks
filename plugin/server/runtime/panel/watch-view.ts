import { minutesSince } from "../../core/time.ts";
import { join } from "node:path";
import type { WatchCases, WatchJudge, WatchView } from "../../../shared/flow-views.ts";
import type { Kit } from "../../catalog/kit/kit.ts";
import type { Team } from "../../catalog/team/team.ts";
import { lastBytes } from "../../core/gate.ts";
import { readJson } from "../../core/store.ts";
import { loadIncidents } from "../../desk/store/incidents.ts";
import { eventsSince } from "../../desk/views/events-since.ts";
import { seenAt } from "./report-seen.ts";
import type { Project } from "../../desk/project/project.ts";

/** Which brains read for the project and how that stands, as the last answer the watch kept says; a line by another is not theirs. */
function judgeLine(project: Project, team: Team, kit: Kit, now: number): WatchJudge {
  const { sensor, seat } = team.brains;
  if (!sensor && !seat) return { label: "", state: "off", minutes: null, detail: null };
  const seatLabel = seat && `the ${kit.roles.find((role) => role.role === seat)?.label ?? seat}`;
  const named = [sensor?.sensor.label, seatLabel].filter(Boolean).join(" and ");
  const label = named.charAt(0).toUpperCase() + named.slice(1);
  if (sensor && !sensor.key && !seat) return { label, state: "nokey", minutes: null, detail: sensor.sensor.key };
  let last: { at?: string; by?: string; unasked?: string } | undefined;
  for (const kept of lastBytes(join(project.state, "assessments.log"), 16 * 1024)
    .trim()
    .split("\n")
    .reverse()) {
    try {
      last = JSON.parse(kept) as NonNullable<typeof last>;
      break;
    } catch {
      // A line cut mid-write says nothing of how the brains answer.
    }
  }
  if (!last?.at || (last.by !== sensor?.id && last.by !== seat))
    return { label, state: "waiting", minutes: null, detail: null };
  const minutes = minutesSince(now, last.at);
  return last.unasked
    ? { label, state: "failing", minutes, detail: last.unasked }
    : { label, state: "answering", minutes, detail: null };
}

/** The Watcher's cases nobody judged: those waiting now, and since `from` those given up or folded into a newer one. */
function unjudged(project: Project, team: Team, from: number): WatchCases {
  const waiting = readJson<unknown>(join(project.state, "watch-cases.json"), []);
  const cases = { waiting: Array.isArray(waiting) ? waiting.length : 0, expired: 0, dropped: 0, superseded: 0 };
  for (const event of eventsSince(project.state, from)) {
    if (event.kind === "watch.superseded") cases.superseded += 1;
    else if (event.kind === "watch.unasked" && event.by === team.brains.seat)
      cases[/^(no answer within|never reached)/.test(event.error) ? "expired" : "dropped"] += 1;
  }
  return cases;
}

/**
 * What the panel shows of a project's watch: how many incidents stand where, how many cases went unjudged, and who
 * answers its questions; what closed or went unjudged counts since the Human last read the report.
 */
export function watchView(project: Project, team: Team, kit: Kit, now = Date.now()): Omit<WatchView, "seat"> {
  const from = seenAt(project) ?? 0;
  const incidents = { told: 0, held: 0, recorded: 0, closed: 0 };
  for (const item of Object.values(loadIncidents(project.state).items)) {
    if (item.open) incidents[item.told !== undefined ? "told" : item.held ? "held" : "recorded"] += 1;
    else if (item.told !== undefined && (item.closed ?? item.last) >= from) incidents.closed += 1;
  }
  return {
    incidents,
    cases: unjudged(project, team, from),
    judge: judgeLine(project, team, kit, now),
  };
}
