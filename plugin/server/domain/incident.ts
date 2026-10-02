import { Lifecycle } from "./lifecycle.ts";

export type Held = "nobody";

/** How much a fact asks of whoever watches: a page now, attention soon, or only a note on the record. */
export type Level = "page" | "attend" | "note";

/**
 * What a watch saw that the desk books as an incident; `theirs` when its quote is only the seat's words or command, and
 * `brain` when a brain read it rather than the code measured it: a brain may add to what the code saw, never stand in for
 * it, and so it `joins` the code's open incident of that kind as evidence rather than opening its own beside it.
 * `digest` tells apart the whole commands a cut quote cannot.
 */
export type Finding = {
  kind: string;
  level: Exclude<Level, "note">;
  quote: string;
  digest?: string;
  facts: string[];
  theirs?: true;
  brain?: true;
  joins?: string;
};

export type Incident = {
  id: string;
  seat: string;
  provider?: string;
  where: string;
  lane?: string;
  task?: string;
  kind: string;
  level: "page" | "attend";
  quote: string;
  digest?: string;
  theirs?: true;
  brain?: true;
  later?: string;
  evidence?: string[];
  facts: string[];
  opened: number;
  last: number;
  count: number;
  open: boolean;
  told?: number;
  held?: Held;
  label?: "useful" | "noise" | "unknown";
  note?: string;
  closed?: number;
};

/**
 * Every fact the code raises and its level; one that can open an incident has the title a person reads it by, `theirs`
 * when its quote is the seat's own text with no word of the watch's in it, and a `next` where it asks more than the plain
 * next step of whoever supervises: the call stays the Lead's.
 */
const FACTS = {
  destructive: { level: "page", title: "Ran a command that cannot be undone", theirs: true },
  secret: { level: "page", title: "Read, printed or wrote a secret" },
  boundary: { level: "page", title: "Sent data out, ran a download, or ran code from outside its copy", theirs: true },
  dependency: { level: "attend", title: "Added a dependency" },
  guard: {
    level: "page",
    title: "Got round a guard: skipped hooks, changed what fences it, or re-ran what was refused",
  },
  stuck: { level: "attend", title: "Going round in circles" },
  "no-recovery": { level: "attend", title: "Did not recover from a failure" },
  flaky: { level: "attend", title: "A check that failed, then passed with no edit between" },
  "refusal-loop": { level: "attend", title: "Refused again and again" },
  "test-weakened": { level: "attend", title: "A test or check weakened" },
  suppressed: { level: "attend", title: "Silenced a check instead of fixing it" },
  "checker-touched": { level: "attend", title: "Changed what checks the work or instructs the agents" },
  unverified: { level: "attend", title: "Handed back without running the gate" },
  "claim-contradicted": { level: "attend", title: "Handed back as complete while its last check failed" },
  "long-turn": { level: "attend", title: "A turn running far longer than usual" },
  "context-pressure": { level: "attend", title: "A context nearly full" },
  "rework-loop": {
    level: "attend",
    title: "Sent back again and again",
    next: "Nothing, if its record shows each round closing in; else ask its Lead what the rounds keep missing. Sending it back to the same Peer stays the Lead's default; one way out is to seat the task afresh, briefed with what the rounds learned. Then mark_incident it.",
  },
  "patched-not-fixed": { level: "attend", title: "Several tasks patched, none fixed" },
  "accepted-unfinished": { level: "attend", title: "Work taken in unfinished" },
  "reviews-unconverged": { level: "attend", title: "Reviews piling up with nothing accepted" },
  "certainty-only": { level: "attend", title: "A review told to report only certainties" },
  "accepted-unread": { level: "attend", title: "Accepted with nothing read or run since the hand-back" },
  overbuilt: { level: "attend", title: "Far more test than source, or no source at all" },
  "rework-unrun": { level: "attend", title: "Sent back on a review that ran nothing" },
  "no-pushback": { level: "attend", title: "A long lane with no push-back from any seat" },
  "gate-slowing": { level: "attend", title: "A gate growing slower run after run" },
  "brief-pasted": { level: "attend", title: "A brief carrying a pasted history" },
  "review-unchecked": { level: "attend", title: "A review accepted with nothing run, or changed files unread" },
  "brief-prewritten": { level: "attend", title: "A brief that writes the answer out" },
  "detour-late": { level: "attend", title: "A detour opened after the lane it clears was sent back" },
  "reviews-fanned": { level: "attend", title: "Reviews fanned out with none reconciled" },
  stalled: {
    level: "attend",
    title: "A task stalled: quiet, or stopped on a refused call",
    next: "Nothing, if its record shows it climbing out; else send its Lead one open question carrying where it stuck. Then mark_incident it.",
  },
  architecture: {
    level: "attend",
    title: "A task's reach widened: structure settling",
    next: "A reach past what a task was given is structure settling. Nothing, if the directive foresaw it; else ask its Lead why. Then mark_incident it.",
  },
  "goal-turned": {
    level: "attend",
    title: "A task's goal turned sharply",
    next: "A turn this sharp often has a reason nobody wrote down. Nothing, if its record gives one; else ask its Lead whether the outcome holds. Then mark_incident it.",
  },
  "lane-idle": {
    level: "attend",
    title: "A Lead idle with nothing going",
    next: "Nothing, if its record shows what it waits on; else read the lane's record, since its words may read worse than the work looks, and take the smallest step that unblocks it. Then mark_incident it.",
  },
  "ask-waiting": { level: "attend", title: "An ask left waiting on its reader" },
  "waits-on-each-other": { level: "attend", title: "Two seats idle, each waiting on the other" },
  "desk-unreached": {
    level: "attend",
    title: "Ended a turn without ever reaching the team's tools",
    next: "Its team's tools may never have reached it, and then it can neither hand back nor ask. Nothing, if its record shows it had no call to make yet; else a Lead is replaced with replace_lead, and a Peer's Lead is told to seat its task again. Then mark_incident it.",
  },
  "call-failed": { level: "note" },
  "gate-failed": { level: "note" },
  "outside-scope": { level: "attend", title: "Wrote outside what it holds" },
  "edit-before-look": { level: "note" },
} as const satisfies Record<
  string,
  { level: "note" } | { level: Exclude<Level, "note">; title: string; theirs?: true; next?: string }
>;

export type FactKind = keyof typeof FACTS;

export type Fact = { kind: FactKind; level: Level; quote: string; digest?: string; theirs?: true };

export const fact = (kind: FactKind, quote: string, digest?: string): Fact => ({
  kind,
  level: FACTS[kind].level,
  quote,
  ...(digest !== undefined && { digest }),
  ...("theirs" in FACTS[kind] ? { theirs: true as const } : {}),
});

const FIRST: FactKind[] = ["destructive", "secret", "stuck", "no-recovery", "long-turn"];

const rank = ({ kind, level }: Finding) =>
  (level === "page" ? 0 : 100) + (FIRST.includes(kind as FactKind) ? FIRST.indexOf(kind as FactKind) : FIRST.length);

/** What of `facts` asks for attention, as the incident book takes it, a loop before a claim: a note stays on the record. */
export const findingsOf = (facts: Fact[]): Finding[] =>
  facts
    .flatMap(({ kind, level, quote, digest, theirs }): Finding[] =>
      level === "note"
        ? []
        : [{ kind, level, quote, ...(digest !== undefined && { digest }), facts: [kind], ...(theirs && { theirs }) }],
    )
    .sort((a, b) => rank(a) - rank(b));

/** The title of a kind the incident book holds, which may be one this code no longer raises. */
export function factTitle(kind: string): string | undefined {
  return (FACTS as Record<string, { title?: string }>)[kind]?.title;
}

export function factNext(kind: string): string | undefined {
  return (FACTS as Record<string, { next?: string }>)[kind]?.next;
}

type Delivery = "unsent" | "held" | "told";

type Delivered = { told?: number; held?: Held };

const DELIVERY = new Lifecycle<Delivery, "tell" | "unheard">({
  tell: { from: ["unsent", "held"], to: "told" },
  unheard: { from: ["told"], to: "held" },
});

/** Where an incident stands on being told, read from what it keeps: when it was told, and why it was not. */
export const deliveryOf = (incident: Delivered): Delivery =>
  incident.told !== undefined ? "told" : incident.held ? "held" : "unsent";

export function tell(incident: Delivered, at: number): boolean {
  if (!DELIVERY.may(deliveryOf(incident), "tell")) return false;
  delete incident.held;
  incident.told = at;
  return true;
}

/** A letter that found nobody to read it: the incident waits for somebody to be seated instead. */
export function unheard(incident: Delivered): boolean {
  if (!DELIVERY.may(deliveryOf(incident), "unheard")) return false;
  delete incident.told;
  incident.held = "nobody";
  return true;
}

/** Closing is apart from being told: a closed incident keeps whether it was told, and why not. */
export function close(incident: { open: boolean; closed?: number }, at: number): boolean {
  if (!incident.open) return false;
  incident.open = false;
  incident.closed = at;
  return true;
}
