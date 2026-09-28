import type { FlowLane, FlowSeat, FlowTask } from "../../shared/flow-views.ts";
import type { Tone } from "./tone.ts";

/** A seat by its role's label, as the kit names it; the desk may not know yet which role a seat has. */
export const seatName = (seat: FlowSeat | null): string => seat?.label ?? "Seat";

/** Who answers a seat's permission prompt: the Human while they are in the loop, else whoever supervises. */
export type Answers = { human: boolean; supervisor: string };

const answerer = ({ human, supervisor }: Answers) => (human ? "you" : supervisor);

/**
 * A lane in one short phrase and a tone, what its line in the Team list says: the Human's part first, and a Lead that
 * waits or has gone before any count, since a lane's line is the only place that shows until it is opened.
 */
export function laneLine(lane: FlowLane, asked: boolean, answers: Answers): { tone: Tone; text: string } {
  if (lane.landed) return { tone: "done", text: "landed" };
  if (lane.landApproval && !lane.landApproval.approved)
    return answers.human
      ? { tone: "you", text: "waits on you" }
      : { tone: "wait", text: "held from while you were in" };
  if (asked) return { tone: "you", text: "waits on your answer" };
  if (lane.landApproval) return { tone: "work", text: "landing" };
  if (lane.onHold) return { tone: "wait", text: "on hold" };
  if (lane.lead && lane.lead.waiting.length > 0) return seatLine(lane.lead, answers);
  if (lane.lead?.status === "gone") return { tone: "wait", text: "Lead gone" };
  if (lane.ready !== undefined) return { tone: "work", text: "reported ready" };
  if (lane.running > 0) return { tone: "work", text: `${lane.running} running` };
  return { tone: lane.lead ? "work" : "wait", text: lane.lead ? lane.lead.status : "no Lead yet" };
}

/** A seat in one short phrase and a tone, for the line under its lane. */
export function seatLine(seat: FlowSeat | null, answers: Answers): { tone: Tone; text: string } {
  if (!seat) return { tone: "wait", text: "no seat yet" };
  if (seat.waiting.length > 0) return { tone: answers.human ? "you" : "wait", text: `waits on ${answerer(answers)}` };
  if (seat.status === "gone") return { tone: "wait", text: "gone" };
  return { tone: "work", text: seat.status };
}

/** What running with no OS sandbox means for a seat, in the panel's words; nothing for a sandboxed seat or none. */
export const sandboxLine = (seat: FlowSeat | null): string | null =>
  seat?.unsandboxed ? "Unsandboxed: its shell commands can read and write whatever your account can" : null;

/** Seats the Team tab names only to mark them, the supervising and the kept: those unsandboxed, so a sandboxed one shows nothing new. */
export const marked = <Seat extends FlowSeat>(seats: Seat[]): Seat[] => seats.filter((seat) => seat.unsandboxed);

/** A task in one short phrase and a tone: held, waiting, handed back, else what its seat does. */
export function taskLine(task: FlowTask, answers: Answers): { tone: Tone; text: string } {
  if (task.held) return { tone: "wait", text: "held" };
  if (task.status === "waiting")
    return { tone: "wait", text: task.after.length ? `waits on ${task.after[0]}` : "waiting" };
  if (task.handback !== null) return { tone: "done", text: "handed back" };
  return seatLine(task.peer, answers);
}
