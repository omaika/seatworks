import { readFileSync } from "node:fs";
import { can, seatOf } from "../../catalog/kit/roles.ts";
import { detailOf } from "../../catalog/kit/timeline.ts";
import { fileKinds } from "../../catalog/kit/ecosystem-patterns.ts";
import { diffCounts } from "../../core/git-diff.ts";
import type { StreamRow } from "../../core/ports.ts";
import { oneLine, plural } from "../../core/text.ts";
import { type Fact, fact, findingsOf } from "../../domain/incident.ts";
import { type Ledger, laneOfLead, taskOfPeer, tasksOf } from "../../domain/ledger.ts";
import type { Lane } from "../../domain/lane.ts";
import type { Task } from "../../domain/task.ts";
import type { Caller } from "../context.ts";
import type { DeskServices } from "../services.ts";
import { eventsSince } from "../views/events-since.ts";
import { loadLedger } from "../store/ledger.ts";
import { notice } from "./notice.ts";

type Deciding = Pick<DeskServices, "kit" | "incidents" | "teamFor" | "mail" | "roster">;

/** How far back a seat's own record is read at a decision: its calls since the letter the decision answers. */
const HISTORY = 200;

const said = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * What the record shows at a decision a seat makes through the desk, read by code as it makes it: evidence for whoever
 * supervises, never a refusal. The seat's own calls are read from its history only here, at the decision.
 */
export async function decisionFacts(
  services: Deciding,
  caller: Caller,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const ledger = loadLedger(caller.project.state);
  const facts = await factsAt(services, caller, ledger, tool, args);
  if (facts.length === 0) return;
  const provider = (await services.roster.look(caller.id)).provider ?? "";
  await notice(services, caller.project, { id: caller.id, provider, title: caller.title }, findingsOf(facts));
}

async function factsAt(
  services: Deciding,
  caller: Caller,
  ledger: Ledger,
  tool: string,
  args: Record<string, unknown>,
): Promise<Fact[]> {
  const { attention } = services.teamFor(caller.project);
  if (can(caller.role, "lead")) {
    const lane = laneOfLead(ledger, caller.id);
    const task = ledger.tasks[said(args.task).toUpperCase()];
    if (tool === "accept" && task) return accepted(services, caller.id, ledger, task, attention.testToSourceAt);
    if (tool === "rework" && task) return sentBackOnUnrun(ledger, task);
    if (tool === "report" && lane && args.ready === true)
      return readyOver(caller.project.state, ledger, lane, attention);
    if (tool === "add_tasks" || tool === "amend_task") return briefsPasted(args, attention.briefContextChars);
  }
  const review = taskOfPeer(ledger, caller.id);
  if (tool === "done" && review?.kind === "review" && args.verdict === "accept")
    return reviewUnchecked(services, caller.id, ledger, review);
  return [];
}

const letterOf = (row: StreamRow) => (row.item.type === "user_message" ? said(row.item.text) : "");

type Detail = Record<string, unknown> | undefined;

/** The seat's history, each call's detail read as its harness writes it: a shell Paseo leaves unread is a shell. */
async function historyOf(services: Deciding, seat: string): Promise<{ rows: StreamRow[]; details: Detail[] }> {
  const [rows, look] = await Promise.all([
    services.roster.history(seat, HISTORY).catch(() => []),
    services.roster.look(seat).catch(() => undefined),
  ]);
  const quirks = (look && seatOf(services.kit, look.provider)?.harness.timeline) ?? {};
  return { rows, details: rows.map((row) => (row.item.type === "tool_call" ? detailOf(row.item, quirks) : undefined)) };
}

/** The details of the seat's calls since the last letter that hands back `ids`: none found, the record cannot say, so nothing is read into it. */
async function callsSince(
  services: Deciding,
  seat: string,
  ids: string[],
): Promise<Record<string, unknown>[] | undefined> {
  const { rows, details } = await historyOf(services, seat);
  const from = rows.findLastIndex((row) => ids.some((id) => letterOf(row).includes(`HANDBACK ${id} (`)));
  if (from < 0) return undefined;
  return details.slice(from + 1).filter((detail) => detail !== undefined);
}

const LOOKS = new Set(["read", "search", "shell"]);

/** An accept with nothing read, searched or run since the hand-back or its review's verdict; and one far heavier in tests. */
async function accepted(
  services: Deciding,
  lead: string,
  ledger: Ledger,
  task: Task,
  testToSourceAt: number,
): Promise<Fact[]> {
  const facts: Fact[] = [];
  const reviews = Object.values(ledger.tasks).filter((entry) => entry.kind === "review" && entry.of === task.id);
  const calls = await callsSince(services, lead, [task.id, ...reviews.map((review) => review.id)]);
  const looked = calls?.some((detail) => LOOKS.has(said(detail.type)));
  if (calls && !looked)
    facts.push(
      fact(
        "accepted-unread",
        `${task.id} was accepted with nothing read, searched or run since its last hand-back or review`,
      ),
    );
  const lane = ledger.lanes[task.lane];
  if (task.startSha && task.branch && lane?.worktree) {
    const counts = await diffCounts(lane.worktree, task.startSha, task.branch, fileKinds(services.kit)).catch(
      () => undefined,
    );
    if (counts && counts.test > 0 && (counts.src === 0 || counts.test >= testToSourceAt * counts.src))
      facts.push(
        fact(
          "overbuilt",
          `${task.id} changes ${counts.test} test lines against ${counts.src} source ${plural(counts.src, "line", "lines")}`,
        ),
      );
  }
  return facts;
}

/** A sending-back on a review that ran nothing: the verdict's words, not its checks, carried it. */
function sentBackOnUnrun(ledger: Ledger, task: Task): Fact[] {
  const review = Object.values(ledger.tasks)
    .filter((entry) => entry.kind === "review" && entry.of === task.id && entry.handback)
    .sort((a, b) => a.handback!.at - b.handback!.at)
    .at(-1);
  if (!review?.handback || review.handback.outcome === "accept") return [];
  let body: string;
  try {
    body = readFileSync(review.handback.file, "utf-8");
  } catch {
    return [];
  }
  return /^Ran: nothing$/m.test(body)
    ? [fact("rework-unrun", `${task.id} was sent back on ${review.id}, a review that ran nothing`)]
    : [];
}

/**
 * A lane reported ready after a long run of tasks with no push-back from any of its seats, or over a gate growing slower
 * run after run. What its reviews and gate say at that moment the desk's own REPORT letter already carries.
 */
function readyOver(
  state: string,
  ledger: Ledger,
  lane: Lane,
  attention: { quietLaneTasks: number; gateSlowerTimes: number },
): Fact[] {
  const facts: Fact[] = [];
  const code = tasksOf(ledger, lane.id).filter((task) => task.kind === "code");
  const asked = Object.values(ledger.asks).some((ask) => ask.lane === lane.id);
  if (code.length >= attention.quietLaneTasks && !asked)
    facts.push(
      fact("no-pushback", `${lane.id} reported ready after ${code.length} tasks with no ask from any of its seats`),
    );
  const seconds = eventsSince(state, lane.openedAt).flatMap((event) =>
    (event.kind === "gate.passed" || event.kind === "gate.failed") && event.lane === lane.id ? [event.seconds] : [],
  );
  const last = seconds.slice(-3);
  if (
    last.length === 3 &&
    last[0]! < last[1]! &&
    last[1]! < last[2]! &&
    last[2]! >= attention.gateSlowerTimes * last[0]!
  )
    facts.push(fact("gate-slowing", `${lane.id}'s gate took ${last.join(", ")} seconds over its last three runs`));
  return facts;
}

/** A brief whose context runs past what a brief needs: a transcript or a whole history pasted in. */
function briefsPasted(args: Record<string, unknown>, limit: number): Fact[] {
  const briefs = Array.isArray(args.tasks) ? (args.tasks as Record<string, unknown>[]) : [args];
  const long = briefs.filter((brief) => said(brief.context).length > limit);
  return long.map((brief) =>
    fact(
      "brief-pasted",
      `${oneLine(said(brief.title) || said(brief.task), 60)}'s context runs ${said(brief.context).length} characters`,
    ),
  );
}

/** A review's accept with no command run, or with files its change touched never read, as the reviewer's own calls show. */
async function reviewUnchecked(services: Deciding, reviewer: string, ledger: Ledger, review: Task): Promise<Fact[]> {
  const details = (await historyOf(services, reviewer)).details.filter((detail) => detail !== undefined);
  const commands = details.filter((detail) => detail.type === "shell").map((detail) => said(detail.command));
  const read = details.map((detail) => said(detail.filePath)).filter(Boolean);
  const target = review.of ? ledger.tasks[review.of] : undefined;
  const lane = ledger.lanes[review.lane];
  const changed =
    target?.startSha && target.branch && lane?.worktree
      ? ((
          await diffCounts(lane.worktree, target.startSha, target.branch, fileKinds(services.kit)).catch(
            () => undefined,
          )
        )?.files ?? [])
      : [];
  // A whole diff shown is every changed file read.
  const whole = commands.some((command) => /\bgit\s+(?:diff|show)\b(?![^|;&]*\s--\s)/.test(command));
  const unread = whole
    ? []
    : changed.filter((file) => ![...read, ...commands].some((seen) => seen.includes(file.split("/").at(-1)!)));
  const gaps = [
    ...(commands.length === 0 ? ["no command run"] : []),
    ...(unread.length > 0
      ? [`${unread.length} changed ${plural(unread.length, "file", "files")} unread: ${unread.slice(0, 5).join(", ")}`]
      : []),
  ];
  return gaps.length > 0 ? [fact("review-unchecked", `${review.id} accepted with ${gaps.join(", and ")}`)] : [];
}
