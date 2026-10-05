import { z } from "zod";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** A server setting's value: one, or an ordered list where its spec says so, the first tried first. */
export const SettingValue = z.union([Scalar, z.array(z.union([z.string(), z.number()])).min(1)]);

export const RoleChoice = z.strictObject({
  harness: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  rules: z.string().optional(),
});

export const Connect = z.strictObject({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpChoice = z.strictObject({
  enabled: z.boolean().optional(),
  removed: z.boolean().optional(),
  label: z.string().min(1).optional(),
  connect: Connect.optional(),
  roles: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.array(z.string())).optional(),
  rule: z.string().optional(),
  settings: z.record(z.string(), SettingValue).optional(),
});

export type SettingValue = z.infer<typeof SettingValue>;
export type RoleChoice = z.infer<typeof RoleChoice>;
export type Connect = z.infer<typeof Connect>;
export type McpChoice = z.infer<typeof McpChoice>;

/** A pattern handed to `new RegExp` later, inside a try that reads a failure as "not reachable", so a typo must be caught here. */
export const Pattern = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new RegExp(value, "i");
        return true;
      } catch {
        return false;
      }
    },
    { error: "is not a pattern this machine can read" },
  );

export const AttentionChoice = z.strictObject({
  tickSeconds: z.number().int().min(5).optional(),
  leadIdleMinutes: z.number().int().min(1).optional(),
  /** How long an open ask waits on its reader before the watch notes it. */
  askWaitingMinutes: z.number().int().min(1).optional(),
  /** With the Human out of the loop, how long a Lead's ask waits on whoever supervises before it goes back to the Lead. */
  askLapseMinutes: z.number().int().min(1).optional(),
  destructive: Pattern.optional(),
  /** Where removing is scratch clean-up rather than a page: a path it matches, read case by case as it is written. */
  scratch: Pattern.optional(),
  /** A path that holds a secret, a command that reads or dumps secrets, and a string shaped like one: reading, printing or writing one is paged. */
  secretPath: Pattern.optional(),
  /** What an example of a secret file is named like: no secret, whatever path it lies on. */
  secretExample: Pattern.optional(),
  secretCommand: Pattern.optional(),
  secretString: Pattern.optional(),
  /** Sending data out or running a download (`boundary`), and the programs that run a script (`interpreter`), paged on one outside the copy. */
  boundary: Pattern.optional(),
  /** An address on this machine: data sent there does not leave it, so `boundary` passes it. */
  localHost: Pattern.optional(),
  interpreter: Pattern.optional(),
  /** An install of a named package, a dependency manifest, and an entry in one: a new dependency is noted. */
  dependencyInstall: Pattern.optional(),
  dependencyManifest: Pattern.optional(),
  dependencyEntry: Pattern.optional(),
  /** The files that fence a seat (its agent's permissions, hooks, sandbox) and a command that moves git's hooks: changing either is paged. */
  guardPath: Pattern.optional(),
  guardCommand: Pattern.optional(),
  testPath: Pattern.optional(),
  repeatsAt: z.number().int().min(2).optional(),
  /** Steps after a failed command with neither it nor the gate passing, before the watch calls it no recovery. */
  recoverWithin: z.number().int().min(2).optional(),
  /** Refusals in a row, by a seat's own permissions or by the desk, that make a refusal loop. */
  refusalsAt: z.number().int().min(2).optional(),
  reworksAt: z.number().int().min(2).optional(),
  reviewsAt: z.number().int().min(2).optional(),
  /** Test lines to each source line at which an accepted task is overbuilt, as are tests with no source at all. */
  testToSourceAt: z.number().min(1).optional(),
  /** Tasks in a lane reported ready with no ask from any of its seats at which nobody pushed back. */
  quietLaneTasks: z.number().int().min(2).optional(),
  /** How much slower a lane's gate grows over its last three runs, each slower than the one before, before it is told. */
  gateSlowerTimes: z.number().min(1).optional(),
  /** How long a brief's context runs before it reads as a pasted history rather than a brief. */
  briefContextChars: z.number().int().min(1).optional(),
  suppressed: Pattern.optional(),
  /** What a product file gains to stop or skip instead of doing the work: an exit that says success, a test skipped from inside. */
  productBail: Pattern.optional(),
  /** Files the gate or the agents' instructions read: test runner and CI config, the project's instruction files. */
  checkerPath: Pattern.optional(),
  longTurnMinutes: z.number().int().min(1).optional(),
  /** Past `longTurnAfterTurns` turns, one is long at `longTurnTimes` the median of the last `longTurnMedianOf`. */
  longTurnTimes: z.number().min(1).optional(),
  longTurnAfterTurns: z.number().int().min(1).optional(),
  longTurnMedianOf: z.number().int().min(1).optional(),
  /** How many turns a Peer may end with no hand-back or ask before its task counts as stalled. */
  silentTurns: z.number().int().min(1).optional(),
  /** How much a seat may write after a refused or unanswered call and still count as stopped on it. */
  quietChars: z.number().int().min(0).optional(),
  /** How full a seat's context may get, as its agent reports it, before the watch says so. */
  contextShare: z.number().gt(0).max(1).optional(),
  /** Times a seat's context is compacted since its instruction before the watch says so. */
  compactionsAt: z.number().int().min(1).optional(),
  /** How many of a seat's latest steps are read for going round in circles. */
  stuckWithin: z.number().int().min(2).optional(),
  /** Thoughts and sayings in a row with no call between them that make a seat talking round in circles. */
  monologueAt: z.number().int().min(2).optional(),
  /** How often the watch's eye reads a running seat's new words; it also reads at every turn's end. */
  lookMinutes: z.number().int().min(1).optional(),
  /** How much of each word, thought or brief the brains read, and of what a brain found an incident quotes. */
  lookItemChars: z.number().int().min(1).optional(),
  /** How much of the project's concept file, the Human's settled words, a Lead's look is read beside. */
  conceptChars: z.number().int().min(1).optional(),
  /** How much of a decision's desk call, and of the words that led to it, newest first, the case judging it reads. */
  decisionChars: z.number().int().min(1).optional(),
  /** A decision is asked against at most `ruleLines` lines of the concept and what the work asks, each sharing at least `ruleWordsShared` content words with it. */
  ruleLines: z.number().int().min(1).optional(),
  ruleWordsShared: z.number().int().min(1).optional(),
  quoteChars: z.number().int().min(1).optional(),
  /** Looks with words and no thinking, never any, after which a seat is recorded as one the watch cannot read thinking of. */
  thoughtlessLooks: z.number().int().min(1).optional(),
  incidentsKept: z.number().int().min(1).optional(),
  /** How long a case waits on the Watcher seat's answer before it is given up. */
  watcherAnswerMinutes: z.number().int().min(1).optional(),
  /** Whether the watch runs at all: off, neither its eye nor its brains open an incident, and nothing is told. */
  watch: z.boolean().optional(),
  /** Which brains read what the watch's eye sees: none, the sensor, the Watcher seat, or both (the sensor sifts, the seat judges). */
  brain: z.enum(["off", "sensor", "seat", "both"]).optional(),
  sensor: z.string().min(1).optional(),
});

export const REVIEW_OFF = "off";

/** Which sensor asks review's checks, apart from the watch's brains, or REVIEW_OFF for none; the machine keeps its key under `sensor`.
 * "" or null, written by hand, is no choice, as unset is, rather than a fault that leaves the layer and its key unread. */
const ReviewChoice = z.strictObject({
  sensor: z
    .string()
    .nullish()
    .transform((sensor) => sensor || undefined)
    .optional(),
});

/** Off, only the concept is the Human's; on, questions may queue for them, at most `questionsPerDay` across this machine. */
export const HitlChoice = z.strictObject({
  on: z.boolean().optional(),
  questionsPerDay: z.number().int().min(0).optional(),
});

/** A sensor's key buys paid calls, so it is kept on this machine only and the screen never reads it back: it sees KEPT. */
const SensorChoice = z.strictObject({ key: z.string().min(1).optional() });

export const KEPT = "kept, not shown";

/** Levels the Human sets up on this machine, each some seats' agent, model and thinking, to pick one from when adding a project. */
export const LEVELS = [
  { id: "cheap", label: "Cheap" },
  { id: "balanced", label: "Balanced" },
  { id: "max", label: "Max" },
] as const;

export type LevelId = (typeof LEVELS)[number]["id"];

const LevelSeats = z.record(z.string(), RoleChoice.pick({ harness: true, model: true, thinking: true }));

const LevelsChoice = z.strictObject({
  cheap: LevelSeats.optional(),
  balanced: LevelSeats.optional(),
  max: LevelSeats.optional(),
});

/** One shape for both layers: the machine's, and a project's over it. */
export const LayerSchema = z.strictObject({
  roles: z.record(z.string(), RoleChoice).optional(),
  mcp: z.record(z.string(), McpChoice).optional(),
  rules: z.string().optional(),
  attention: AttentionChoice.optional(),
  review: ReviewChoice.optional(),
  hitl: HitlChoice.optional(),
  sensor: z.record(z.string(), SensorChoice).optional(),
  /** The language whoever supervises speaks to the Human in; the rest of the team writes English, which the watch reads. */
  language: z.string().min(1).optional(),
  /** How many gates, rehearsals and setups run at once across this machine's projects: they share its processors. */
  gatesAtOnce: z.number().int().min(1).optional(),
  /** The machine's only: a project is set up from a level, and keeps what it copied. */
  levels: LevelsChoice.optional(),
});

export type Layer = z.infer<typeof LayerSchema>;
export type AttentionChoice = z.infer<typeof AttentionChoice>;
export type HitlChoice = z.infer<typeof HitlChoice>;
