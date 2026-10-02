import type { Ask } from "./ask.ts";
import type { Lane } from "./lane.ts";
import type { Question } from "./question.ts";
import { ACTIVE, SETTLED, type Task, openWork } from "./task.ts";

/** A teardown waiting on the seats still writing in the copy. On the record, so a restart does not lose it. */
type Releasing = { writers: string[]; dropBranch?: string; into?: string };

export type Slot = {
  id: string;
  path: string;
  workspaceId?: string;
  lane?: string;
  task?: string;
  throwaway?: true;
  createdAt: number;
  releasing?: Releasing;
};

export type AgentRef = {
  id: string;
  role: string;
  lane?: string;
  task?: string;
  gone?: boolean;
  recordedAt?: number;
  spokeAt?: number;
  spent?: Spent;
};

/** Dollars a seat's agent reported, which count from its agent's start: `banked` is what earlier starts had reached. */
type Spent = { banked: number; last: number };

export type Ledger = {
  seq: { lane: number; ask: number; slot?: number; question?: number; tip?: number };
  lanes: Record<string, Lane>;
  tasks: Record<string, Task>;
  asks: Record<string, Ask>;
  questions: Record<string, Question>;
  agents: Record<string, AgentRef>;
  slots: Record<string, Slot>;
  left?: Record<string, LeftCopy>;
  tips?: Record<string, string>;
};

/** A copy the desk let go of that held work nobody committed: it stays where it is, off the slots, until someone clears it. */
type LeftCopy = { slot: string; why: string; at: number };

export function emptyLedger(): Ledger {
  return { seq: { lane: 0, ask: 0 }, lanes: {}, tasks: {}, asks: {}, questions: {}, agents: {}, slots: {} };
}

export function nextLaneId(ledger: Ledger): string {
  ledger.seq.lane += 1;
  return `L${ledger.seq.lane}`;
}

export function nextTaskId(lane: Lane, kind: Task["kind"]): string {
  if (kind === "review") {
    lane.reviews = (lane.reviews ?? 0) + 1;
    return `${lane.id}-R${lane.reviews}`;
  }
  lane.tasks += 1;
  return `${lane.id}-T${lane.tasks}`;
}

/** Never handed out twice: a reused id gave a copy the sweep was removing the same path as the next one created. */
export function nextSlotId(ledger: Ledger): string {
  const taken = Object.keys(ledger.slots)
    .map((id) => Number(id.replace(/^S/, "")))
    .filter((n) => Number.isInteger(n));
  const next = Math.max(ledger.seq.slot ?? -1, ...taken) + 1;
  ledger.seq.slot = next;
  return `S${next}`;
}

export function nextAskId(ledger: Ledger): string {
  ledger.seq.ask += 1;
  return `A${ledger.seq.ask}`;
}

export function nextQuestionId(ledger: Ledger): string {
  ledger.seq.question = (ledger.seq.question ?? 0) + 1;
  return `H${ledger.seq.question}`;
}

export function findTask(ledger: Ledger, id: string): Task | undefined {
  return ledger.tasks[id.trim().toUpperCase()];
}

export function findLane(ledger: Ledger, id: string): Lane | undefined {
  return ledger.lanes[id.trim().toUpperCase()];
}

export function laneOfLead(ledger: Ledger, agentId: string): Lane | undefined {
  return Object.values(ledger.lanes).find((lane) => lane.lead === agentId && lane.status === "open");
}

/** The lane a seat leads by its binding, closed ones included: a Lead kept after its lane closed answers for it. */
export function leadLaneOf(ledger: Ledger, agentId: string): Lane | undefined {
  const lane = ledger.lanes[ledger.agents[agentId]?.lane ?? ""];
  return lane?.lead === agentId ? lane : undefined;
}

/** The seats working in a lane: its Lead, then the Peer or reviewer of each task not yet settled. */
export function laneSeats(ledger: Ledger, lane: Lane): { seat: string; task?: Task }[] {
  const working = Object.values(ledger.tasks).filter(
    (task) => task.lane === lane.id && task.peer && !SETTLED.includes(task.status),
  );
  return [...(lane.lead ? [{ seat: lane.lead }] : []), ...working.map((task) => ({ seat: task.peer!, task }))];
}

/** The task a Peer or reviewer is on: its binding names it, and it has no other. */
export function taskOfPeer(ledger: Ledger, agentId: string): Task | undefined {
  const task = ledger.tasks[ledger.agents[agentId]?.task ?? ""];
  return task?.peer === agentId ? task : undefined;
}

export function openAsksTo(ledger: Ledger, agentId: string): Ask[] {
  return Object.values(ledger.asks).filter((ask) => ask.status === "open" && ask.to === agentId);
}

export function openAsksFrom(ledger: Ledger, agentId: string): Ask[] {
  return Object.values(ledger.asks).filter((ask) => ask.status === "open" && ask.from === agentId);
}

/** The lane in the project's own copy: open with no copy of its own, or closed while its Lead ends a turn there. */
export function ownCopyHolder(lanes: Lane[]): Lane | undefined {
  return lanes.find((lane) => lane.status === "open" && !lane.slot) ?? lanes.find((lane) => lane.restoring);
}

export function tasksOf(ledger: Ledger, laneId: string): Task[] {
  return Object.values(ledger.tasks).filter((task) => task.lane === laneId);
}

export function othersLeft(ledger: Ledger, task: Task): Task[] {
  return tasksOf(ledger, task.lane).filter((entry) => entry.id !== task.id && openWork(entry));
}

export function activeTasks(ledger: Ledger, laneId: string): Task[] {
  return tasksOf(ledger, laneId).filter((task) => ACTIVE.includes(task.status));
}

/** Whether `task` waits on the task `on` through `after`, however far down: it comes after it, not beside it. */
function waitsOn(ledger: Ledger, task: Task, on: string, seen = new Set<string>()): boolean {
  return (task.after ?? []).some((id) => {
    if (id === on) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const before = ledger.tasks[id];
    return before !== undefined && waitsOn(ledger, before, on, seen);
  });
}

/** The lane's code tasks written beside `task`, or soon to be: for a task in the lane's copy, those in their own. */
export function besideOf(ledger: Ledger, task: Task): Task[] {
  return Object.values(ledger.tasks).filter(
    (other) =>
      other.lane === task.lane &&
      other.id !== task.id &&
      other.kind === "code" &&
      !SETTLED.includes(other.status) &&
      (task.mode === "parallel" || other.mode === "parallel") &&
      !waitsOn(ledger, other, task.id),
  );
}

/** What the seats of a lane spent, as their agents report it; undefined when none of them reports any. */
export function laneSpent(ledger: Ledger, lane: string): number | undefined {
  const spent = Object.values(ledger.agents).flatMap((agent) =>
    agent.lane === lane && agent.spent ? [agent.spent.banked + agent.spent.last] : [],
  );
  return spent.length > 0 ? Math.round(spent.reduce((sum, each) => sum + each, 0) * 100) / 100 : undefined;
}
