/** The team as the desk has it, over RPC: lanes, tasks, asks, questions and what the watch noticed, for the Team tab and the waiting pill. */
import { z } from "zod";
import { Refused } from "./views.ts";

/**
 * `label` is the seat's role as the kit labels it; none when neither Paseo nor the ledger says which role it has.
 * `unsandboxed`: its agent has no OS sandbox on the platform it runs on, as the kit's harness says.
 */
const FlowSeat = z.object({
  id: z.string(),
  label: z.string().nullable(),
  unsandboxed: z.boolean(),
  status: z.string(),
  minutes: z.number(),
  waiting: z.array(z.string()),
});
export type FlowSeat = z.infer<typeof FlowSeat>;
/** `copy` names a parallel task's own copy; `after` is what a waiting task waits for, and `held` why a task cannot start or merge yet. */
const FlowTask = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  mode: z.enum(["lane", "parallel"]),
  copy: z.string().nullable(),
  after: z.array(z.string()),
  held: z.string().nullable(),
  peer: FlowSeat.nullable(),
  handback: z.number().nullable(),
  /** What the task is briefed to: the Lead's goal, the choices open to its Peer's question, and what nobody knows yet. */
  brief: z.object({
    goal: z.string(),
    choices: z.array(z.string()),
    unknowns: z.array(z.string()),
    settled: z.boolean(),
  }),
});
export type FlowTask = z.infer<typeof FlowTask>;
/** A Peer kept idle after its task was accepted, until its Lead releases it. */
const FlowKept = FlowSeat.extend({ task: z.string() });
/** `copy` is the lane's own working copy, none for the Human's checkout; `kept` its Peers idle after their tasks; `landed` how a lane whose Lead is kept closed. */
export const FlowLane = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  branch: z.string(),
  base: z.string().optional(),
  copy: z.string().nullable(),
  lead: FlowSeat.nullable(),
  kept: z.array(FlowKept),
  landed: z.boolean().optional(),
  tasks: z.array(FlowTask),
  taskCount: z.number(),
  running: z.number(),
  open: z.boolean(),
  after: z.array(z.string()).optional(),
  held: z.string().optional(),
  landApproval: z
    .object({ minutes: z.number(), approved: z.boolean(), signals: z.array(z.string()), evidence: z.array(z.string()) })
    .optional(),
  workspaceId: z.string().optional(),
  onHold: z.object({ minutes: z.number(), reason: z.string() }).optional(),
  ready: z.number().optional(),
  spent: z.number().optional(),
});
export type FlowLane = z.infer<typeof FlowLane>;
/** An open ask between seats, as the Human reads it: who asked whom and how long ago, never the words, which are the seats'. */
const FlowAsk = z.object({
  id: z.string(),
  kind: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  minutes: z.number(),
});
export type FlowAsk = z.infer<typeof FlowAsk>;
export const FlowQuestion = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
  lane: z.string().nullable(),
  class: z.enum(["reversible", "costly", "irreversible"]),
  options: z.array(z.object({ label: z.string(), effect: z.string() })),
  recommend: z.string(),
  reason: z.string(),
  ifSilent: z.string(),
  minutes: z.number(),
});
export type FlowQuestion = z.infer<typeof FlowQuestion>;
/**
 * How many open incidents stand where: told whoever supervises, held while nobody is seated to tell, or only recorded;
 * and how many told were closed since the Human last read the report.
 */
const WatchCounts = z.object({ told: z.number(), held: z.number(), recorded: z.number(), closed: z.number() });
export type WatchCounts = z.infer<typeof WatchCounts>;
/** Who answers the watch's questions, and how that stands: off, a sensor with no key, nothing asked yet, its last answer, or its last failure. */
const WatchJudge = z.object({
  label: z.string(),
  state: z.enum(["off", "nokey", "waiting", "answering", "failing"]),
  minutes: z.number().nullable(),
  detail: z.string().nullable(),
});
export type WatchJudge = z.infer<typeof WatchJudge>;
/**
 * The Watcher's cases nobody judged: waiting now, and since the Human last read the report, expired with no answer,
 * dropped for want of a Watcher or a Supervisor, and folded into a newer case.
 */
const WatchCases = z.object({ waiting: z.number(), expired: z.number(), dropped: z.number(), superseded: z.number() });
export type WatchCases = z.infer<typeof WatchCases>;
/**
 * What the code noticed about the seats and nobody has marked yet, the cases left unjudged, who answers the watch's
 * questions, and the seat seated now that judges for it, if any.
 */
const WatchView = z.object({ incidents: WatchCounts, cases: WatchCases, judge: WatchJudge, seat: FlowSeat.nullable() });
export type WatchView = z.infer<typeof WatchView>;
const FlowView = z.object({
  project: z.string(),
  revision: z.string(),
  supervisors: z.array(FlowSeat),
  lanes: z.array(FlowLane),
  moreLanes: z.number(),
  asks: z.array(FlowAsk),
  questions: z.array(FlowQuestion),
  watch: WatchView,
});
export type FlowView = z.infer<typeof FlowView>;
export const FlowRead = z.union([FlowView, z.object({ unchanged: z.literal(true), revision: z.string() }), Refused]);
export type FlowRead = z.infer<typeof FlowRead>;
