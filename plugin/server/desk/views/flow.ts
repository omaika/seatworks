import { minutesSince } from "../../core/time.ts";
import { createHash } from "node:crypto";
import type { SeatView } from "../../core/ports.ts";
import { AT_WORK, SETTLED } from "../../domain/task.ts";
import { keptCopy, keptPeers } from "../seats/kept.ts";
import type { Lane } from "../../domain/lane.ts";
import type { Question } from "../../domain/question.ts";
import { type Ledger, laneSpent } from "../../domain/ledger.ts";
import type { FlowAsk, FlowLane, FlowQuestion, FlowSeat, FlowTask, FlowView } from "../../../shared/flow-views.ts";

type FlowLandApproval = NonNullable<FlowLane["landApproval"]>;
import type { Project } from "../project/project.ts";

const LANE_CAP = 50;

/** The kit's roles as the Team tab names seats: each role's label, and whether it supervises or judges for the watch. */
type FlowRoles = ReadonlyMap<string, { label: string; supervises: boolean; judges: boolean }>;

/** Each seat's role, as Paseo has it for a seat seated now and as the ledger recorded it for one gone. */
type RoleOf = (id: string) => string | undefined;

/** A seat as the Team tab names it, and whether it runs with no OS sandbox, which only a seat seated now can. */
type WhoOf = (id: string | undefined) => { label: string | null; unsandboxed: boolean };

/** A project's seat seated now: its role, and whether its agent has no OS sandbox on this platform. */
type Seated = { id: string; role: string; unsandboxed: boolean };

const minutes = (now: number, at: number | string | undefined): number =>
  at === undefined ? 0 : minutesSince(now, at);

function seatOf(
  seats: Map<string, SeatView>,
  id: string | undefined,
  { label, unsandboxed }: ReturnType<WhoOf>,
  now: number,
  heard?: number,
): FlowSeat | null {
  if (!id) return null;
  const seat = seats.get(id);
  // Stamped zero, a seat gone for a week read as gone just now.
  if (!seat)
    return { id, label, status: "gone", minutes: heard ? minutes(now, heard) : 0, waiting: [], unsandboxed: false };
  return {
    id,
    label,
    unsandboxed,
    status: seat.status,
    minutes: minutes(now, seat.updatedAt),
    waiting: (seat.pendingPermissions ?? []).map((request) => request.title ?? request.name ?? "a request"),
  };
}

type Counted = { total: number; running: number };

/** Every lane's count of unsettled tasks, and the tasks themselves for the lanes the panel has open. */
function tasksByLane(
  ledger: Ledger,
  seats: Map<string, SeatView>,
  now: number,
  open: ReadonlySet<string>,
  whoOf: WhoOf,
): { counts: Map<string, Counted>; held: Map<string, FlowTask[]> } {
  const counts = new Map<string, Counted>();
  const held = new Map<string, FlowTask[]>();
  for (const task of Object.values(ledger.tasks)) {
    if (SETTLED.includes(task.status)) continue;
    const count = counts.get(task.lane) ?? { total: 0, running: 0 };
    count.total += 1;
    if (AT_WORK.includes(task.status)) count.running += 1;
    counts.set(task.lane, count);
    if (!open.has(task.lane)) continue;
    const peer = seatOf(seats, task.peer, whoOf(task.peer), now);
    const built: FlowTask = {
      id: task.id,
      title: task.title,
      status: task.status,
      kind: task.kind,
      mode: task.mode,
      copy: task.mode === "parallel" ? (task.slot ?? null) : null,
      after: task.after ?? [],
      held: (task.startHeld ?? task.mergeHeld)?.why ?? null,
      peer,
      handback: task.handback ? minutes(now, task.handback.at) : null,
      brief: {
        goal: task.goal,
        choices: task.choices ?? [],
        unknowns: task.unknowns ?? [],
        settled: task.settled === true,
      },
    };
    held.set(task.lane, [...(held.get(task.lane) ?? []), built]);
  }
  return { counts, held };
}

function laneOf(
  lane: Lane,
  ledger: Ledger,
  seats: Map<string, SeatView>,
  now: number,
  count: Counted,
  tasks: FlowTask[],
  open: boolean,
  whoOf: WhoOf,
): FlowLane {
  const land = lane.landApproval;
  const closed = lane.status === "closed";
  const idle = closed ? [] : keptPeers(ledger, lane.id).filter((peer) => seats.has(peer.id));
  const spent = laneSpent(ledger, lane.id);
  return {
    id: lane.id,
    title: lane.title,
    status: lane.status,
    branch: lane.branch,
    ...(lane.onBranch ? {} : { base: lane.base }),
    copy: (closed ? keptCopy(ledger, lane) : lane.slot) ?? null,
    lead: seatOf(seats, lane.lead, whoOf(lane.lead), now),
    kept: idle.map((peer) => ({ ...seatOf(seats, peer.id, whoOf(peer.id), now)!, task: peer.task! })),
    ...(closed ? { landed: Boolean(lane.landed) } : {}),
    tasks,
    taskCount: count.total,
    running: count.running,
    open,
    ...(lane.status === "waiting" ? { after: lane.after ?? [], ...(lane.held ? { held: lane.held.why } : {}) } : {}),
    ...(land ? { landApproval: landApprovalView(land, now) } : {}),
    ...(lane.workspaceId ? { workspaceId: lane.workspaceId } : {}),
    ...(lane.onHold ? { onHold: { minutes: minutes(now, lane.onHold.at), reason: lane.onHold.reason } } : {}),
    ...(lane.ready ? { ready: minutes(now, lane.ready.at) } : {}),
    ...(spent === undefined ? {} : { spent }),
  };
}

function asksOf(ledger: Ledger, now: number, roles: FlowRoles, labelOf: (id: string) => string | null): FlowAsk[] {
  return Object.values(ledger.asks)
    .filter((ask) => ask.status === "open")
    .map((ask) => ({
      id: ask.id,
      kind: ask.kind,
      from: roles.get(ask.fromRole)?.label ?? null,
      to: labelOf(ask.to),
      minutes: minutes(now, ask.openedAt),
    }));
}

/** A held landing as the Human reads it, on the Team tab and on its card in the Supervisor's chat. */
export function landApprovalView(land: NonNullable<Lane["landApproval"]>, now: number): FlowLandApproval {
  return {
    minutes: minutes(now, land.since),
    approved: Boolean(land.approved),
    signals: land.signals,
    evidence: land.evidence,
  };
}

/** A question as the Human reads it, on the waiting pill and on its card in the Supervisor's chat. */
export function questionView(
  { id, question, why, lane, class: kind, options, recommend, reason, ifSilent, openedAt }: Question,
  now: number,
): FlowQuestion {
  return {
    id,
    question,
    why,
    lane: lane ?? null,
    class: kind,
    options,
    recommend,
    reason,
    ifSilent,
    minutes: minutes(now, openedAt),
  };
}

function questionsOf(ledger: Ledger, now: number): FlowQuestion[] {
  return Object.values(ledger.questions)
    .filter((question) => question.status === "open")
    .map((question) => questionView(question, now));
}

/** Every supervising seat, one per concern; a concern with nobody seated shows its last seat as gone. */
function supervisorsOf(
  ledger: Ledger,
  seats: Map<string, SeatView>,
  now: number,
  roles: FlowRoles,
  seated: Seated[],
): FlowSeat[] {
  const supervises = (role: string) => roles.get(role)?.supervises === true;
  // The Supervisor seated now: `ledger.agents` keeps each role's newest gone seat, so its first entry may be archived.
  const recorded = Object.values(ledger.agents).filter((agent) => supervises(agent.role));
  const live = recorded
    .filter((agent) => seats.has(agent.id))
    .sort((a, b) => Date.parse(seats.get(b.id)!.updatedAt) - Date.parse(seats.get(a.id)!.updatedAt));
  const shown = new Map<string, { role: string; seat: FlowSeat }>();
  const heard = (id: string) => ledger.agents[id]?.recordedAt;
  const bare = (id: string) => seated.some((each) => each.id === id && each.unsandboxed);
  const show = (id: string, role: string) =>
    shown.set(id, {
      role,
      seat: seatOf(seats, id, { label: roles.get(role)!.label, unsandboxed: bare(id) }, now, heard(id))!,
    });
  for (const entry of [...seated.filter((each) => supervises(each.role)), ...live])
    if (!shown.has(entry.id)) show(entry.id, entry.role);
  const covered = new Set([...shown.values()].map((entry) => entry.role));
  for (const agent of [...recorded].reverse()) {
    if (covered.has(agent.role)) continue;
    covered.add(agent.role);
    show(agent.id, agent.role);
  }
  return [...shown.values()].map((entry) => entry.seat);
}

/** The project's seat seated now that judges for the watch, the one heard from last; `seated` is newest first. */
export function judgeSeat(
  seats: Map<string, SeatView>,
  now: number,
  roles: FlowRoles,
  seated: Seated[],
): FlowSeat | null {
  const found = seated.find((each) => roles.get(each.role)?.judges);
  return found
    ? seatOf(seats, found.id, { label: roles.get(found.role)!.label, unsandboxed: found.unsandboxed }, now)
    : null;
}

/** `seated` is the project's seats Paseo has now, newest first, with their roles: the ledger records a seat only after its first successful tool call. */
export function flowView(
  project: Project,
  ledger: Ledger,
  seats: Map<string, SeatView>,
  now: number,
  open: ReadonlySet<string> = new Set(),
  roles: FlowRoles = new Map(),
  seated: Seated[] = [],
): Omit<FlowView, "watch"> {
  const live = new Map(seated.map((entry) => [entry.id, entry]));
  const roleOf: RoleOf = (id) => live.get(id)?.role ?? ledger.agents[id]?.role;
  const labelOf = (id: string | undefined) => {
    const role = id ? roleOf(id) : undefined;
    return (role && roles.get(role)?.label) ?? null;
  };
  const whoOf: WhoOf = (id) => ({ label: labelOf(id), unsandboxed: (id && live.get(id)?.unsandboxed) === true });
  const { counts, held } = tasksByLane(ledger, seats, now, open, whoOf);
  // A closed lane stays live while its Lead is kept, until the Supervisor releases it or the Human archives it.
  const active = Object.values(ledger.lanes).filter(
    (lane) => lane.status !== "closed" || (lane.lead !== undefined && seats.has(lane.lead)),
  );
  const lanes = active
    .slice(0, LANE_CAP)
    .map((lane) =>
      laneOf(
        lane,
        ledger,
        seats,
        now,
        counts.get(lane.id) ?? { total: 0, running: 0 },
        held.get(lane.id) ?? [],
        open.has(lane.id),
        whoOf,
      ),
    );
  const body = {
    project: project.slug,
    supervisors: supervisorsOf(ledger, seats, now, roles, seated),
    lanes,
    moreLanes: Math.max(0, active.length - LANE_CAP),
    asks: asksOf(ledger, now, roles, labelOf),
    questions: questionsOf(ledger, now),
  };
  const revision = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, revision };
}
