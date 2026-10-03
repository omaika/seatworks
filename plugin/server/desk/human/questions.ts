import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { coverGlob, firstOverlap } from "../../core/scope.ts";
import { clip } from "../../core/text.ts";
import { DAY_MS } from "../../core/time.ts";
import { QUESTION, type Question, type QuestionClass } from "../../domain/question.ts";
import type { DeskBase } from "../base.ts";
import { type Caller, type ToolReply, no, ok, str } from "../context.ts";
import { putOnHold } from "../lanes/hold.ts";
import { humanSaid } from "./said.ts";
import { askLetters } from "../letters/ask-letters.ts";
import { askFirstHits, changeOf } from "../lanes/land-facts.ts";
import type { Lane } from "../../domain/lane.ts";
import { findLane, nextQuestionId } from "../../domain/ledger.ts";
import { loadLedger, readLedger } from "../store/ledger.ts";
import { type Project, loadConfig } from "../project/project.ts";
import type { DeskServices } from "../services.ts";
import { recordEvent } from "../store/event-log.ts";

type AskHumanCall = {
  question: string;
  why: string;
  lane?: string;
  options: { label: string; effect: string }[];
  recommend: string;
  reason: string;
  ifSilent: string;
  class: QuestionClass;
};

const WHILE_SILENT_ALONE: Record<QuestionClass, string> = {
  reversible:
    "Nothing waits for it: what it decides goes ahead as you said it would if they are silent, and they can overturn that.",
  costly:
    "What it decides goes ahead as you said it would if they are silent; with no lane named, nothing stops for it at a report of ready.",
  irreversible: "Nothing it decides goes ahead until they answer.",
};

const WHILE_SILENT: Record<QuestionClass, string> = {
  reversible:
    "Nothing waits for it: the lane goes on as you said it would if they are silent, and they can overturn that.",
  costly:
    "The lane goes on as you said it would if they are silent, and stops at its next report of ready if they have not answered by then.",
  irreversible:
    "Nothing it decides goes ahead until they answer: its Lead is told to keep off it and carry on with the rest. Holding the whole lane is yours, with hold_lane.",
};

export async function askHuman(desk: DeskServices, caller: Caller, args: AskHumanCall): Promise<ToolReply> {
  const { project } = caller;
  if (!desk.teamFor(project).hitl.on)
    return no(
      "The Human is out of the loop on this project, so nothing queues for them: decide it yourself. If it is what the project does or how it behaves, or what a lane is for or what it costs past what they agreed, or a heavy run, ask them directly with your own question tool; write what settles the concept into CONTEXT.md.",
    );
  const invalid = optionsProblem(args);
  if (invalid) return no(invalid);
  const named = args.lane ? findLane(loadLedger(project.state), args.lane) : undefined;
  // The Supervisor may only raise a question's class above what the Human's standing orders make it.
  const floor =
    named && named.status !== "closed" && args.class === "reversible" ? await askFirstOf(project, named) : undefined;
  // What cannot be undone, or what their standing orders raised, is never the Supervisor's: it queues past the limit.
  const over = args.class === "irreversible" || floor ? undefined : overBudget(desk, project);
  if (over) return no(over);
  const opened = recordQuestion(desk, caller, args, floor ? "costly" : args.class);
  if (typeof opened === "string") return no(opened);
  recordEvent(project, { kind: "question.asked", question: opened.id, lane: opened.lane ?? null, class: opened.class });
  const why = `it waits for the Human's answer to ${opened.id}: ${clip(opened.question, 200)}`;
  // Held by the desk, not the Supervisor: only the Human's word lifts what waits for it.
  const parked = opened.parked ? await putOnHold(desk, project, opened.lane!, "desk", why) : undefined;
  const lane = opened.lane ? loadLedger(project.state).lanes[opened.lane] : undefined;
  if (opened.class === "irreversible")
    await desk.mail.post(await desk.roster.seatedLead(lane), askLetters.pending(opened));
  const held =
    parked === undefined
      ? ""
      : typeof parked === "string"
        ? ` Its lane was not put on hold: ${parked}`
        : ` Lane ${opened.lane} is on hold for it.`;
  const raised = floor ? ` It is costly, not reversible. ${floor}` : "";
  const silent = !opened.lane
    ? WHILE_SILENT_ALONE[opened.class]
    : opened.class === "costly" && opened.parked
      ? "Its lane has already reported ready, so it stops now until they answer."
      : WHILE_SILENT[opened.class];
  return ok(
    `Asked the Human as ${opened.id}; it waits in their question queue.${raised} ${silent}${held} An answer they give you here goes on record with record_human_answer.`,
  );
}

function optionsProblem(args: AskHumanCall): string | undefined {
  const labels = args.options.map((option) => option.label.trim());
  const reserved = labels.some((label) => ["decline", "cancel"].includes(label.toLowerCase()));
  if (new Set(labels.map((label) => label.toLowerCase())).size < labels.length || reserved)
    return "Give each option a label of its own, and none called decline or cancel: those are the Human's to say without an option.";
  if (!labels.includes(args.recommend.trim()))
    return `recommend names none of the options: give one of ${labels.join(", ")}.`;
  return undefined;
}

function overBudget({ teamFor }: Pick<DeskServices, "teamFor">, project: Project): string | undefined {
  const budget = teamFor(project).hitl.questionsPerDay;
  const asked = askedSince(project.state, Date.now() - DAY_MS);
  if (asked.length < budget) return undefined;
  const ids = asked.map((question) => question.id).join(", ");
  return `The Human has had ${asked.length} questions in the last day (${ids}), and ${budget} is what they allow: decide this yourself if it is yours to, fold it into one still open, or ask it once the day turns.`;
}

function recordQuestion(
  { ledgers }: Pick<DeskServices, "ledgers">,
  caller: Caller,
  args: AskHumanCall,
  kind: QuestionClass,
): Question | string {
  return ledgers.transact(caller.project, (ledger) => {
    const lane = args.lane ? findLane(ledger, args.lane) : undefined;
    if (args.lane && (!lane || lane.status === "closed")) return `There is no open or waiting lane ${str(args.lane)}.`;
    // A costly question stops its lane at the ready report; asked once the lane has reported ready, that is now. An
    // irreversible one stops only what it decides: the Lead keeps off it, and holding more is the Supervisor's call.
    const parked = lane !== undefined && kind === "costly" && lane.ready !== undefined;
    const question: Question = {
      id: nextQuestionId(ledger),
      from: caller.id,
      lane: lane?.id,
      question: str(args.question),
      why: str(args.why),
      options: args.options.map((option) => ({ label: option.label.trim(), effect: str(option.effect) })),
      recommend: args.recommend.trim(),
      reason: str(args.reason),
      ifSilent: str(args.ifSilent),
      class: kind,
      status: "open",
      openedAt: Date.now(),
      parked: parked || undefined,
    };
    ledger.questions[question.id] = question;
    return question;
  });
}

/** Why a question about `lane` stops it at its ready report at least: it writes where the Human asked to be asked. */
async function askFirstOf(project: Project, lane: Lane): Promise<string | undefined> {
  const declared = loadConfig(project.state).askFirst.find((path) => firstOverlap(lane.writeSet, [coverGlob(path)]));
  if (declared) return `Lane ${lane.id} may write under ${declared}, which the Human asked to be asked about first.`;
  const hit = lane.status === "open" ? askFirstHits(project, await changeOf(project, lane))[0] : undefined;
  return hit && `Lane ${lane.id}: ${hit.text}`;
}

/** The questions put to the Human since `since` in every project on this machine: they have one attention for all. */
export function askedSince(state: string, since: number): Question[] {
  const projects = dirname(state);
  return readdirSync(projects).flatMap((slug) => {
    try {
      return Object.values(readLedger(join(projects, slug)).questions).filter((question) => question.openedAt >= since);
    } catch {
      // A project whose ledger cannot be read has no questions to count; the desk refuses to write it elsewhere.
      return [];
    }
  });
}

/** The Human's word on question `id`, from chat or panel: an option, decline, or cancel; the record, or why not. */
export function settleQuestion(
  { ledgers }: Pick<DeskBase, "ledgers">,
  project: Project,
  id: string,
  choice: string,
  given: { text?: string; by: "panel" | "chat" | "supervisor"; quote?: string },
): Question | string {
  const move = choice.toLowerCase() === "decline" ? "decline" : choice.toLowerCase() === "cancel" ? "cancel" : "answer";
  const recorded = ledgers.transact(project, (ledger) => {
    const question = ledger.questions[id];
    if (!question) return `There is no question ${id}.`;
    const options = question.options.map((option) => option.label);
    if (move === "answer" && !options.includes(choice))
      return `${choice} is none of ${id}'s options: ${options.join(", ")}, or decline or cancel.`;
    if (!QUESTION.move(question, move)) return `${id} is already ${question.status}.`;
    question.answer = { choice, ...given, at: Date.now() };
    return { ...question };
  });
  if (typeof recorded !== "string")
    recordEvent(project, { kind: "question.answered", question: id, status: recorded.status, by: given.by });
  return recorded;
}

/**
 * A settled question whose lane's Lead keeps off what it decides: that Lead hears it is settled, if it is there, and
 * the words for what whoever supervises is told of it; nothing when no Lead keeps off it.
 */
export async function tellKeptOff(
  { mail, roster }: Pick<DeskServices, "mail" | "roster">,
  project: Project,
  question: Question,
): Promise<string> {
  if (question.class !== "irreversible" || !question.lane) return "";
  const lead = await roster.seatedLead(loadLedger(project.state).lanes[question.lane]);
  if (!lead) return "";
  await mail.post(lead, askLetters.settled(question));
  return ` The Lead of ${question.lane} hears only that it is settled: tell it how the lane goes on.`;
}

export async function withdrawQuestion(
  desk: Pick<DeskServices, "ledgers" | "mail" | "roster">,
  caller: Caller,
  args: { question: string; why: string },
): Promise<ToolReply> {
  const id = args.question.trim().toUpperCase();
  const withdrawn = settleQuestion(desk, caller.project, id, "cancel", { text: args.why.trim(), by: "supervisor" });
  if (typeof withdrawn === "string") return no(withdrawn);
  const lane = withdrawn.parked && withdrawn.lane ? loadLedger(caller.project.state).lanes[withdrawn.lane] : undefined;
  const held = lane?.onHold ? ` Lane ${lane.id} is still on hold for it: resume_lane it when it may go on.` : "";
  const told = await tellKeptOff(desk, caller.project, withdrawn);
  return ok(`${id} is off the Human's queue; they read why on its card in your chat.${held}${told}`);
}

export async function recordHumanAnswer(
  desk: DeskServices,
  caller: Caller,
  args: { question: string; choice: string; quote: string; text?: string },
): Promise<ToolReply> {
  const { project } = caller;
  const id = args.question.trim().toUpperCase();
  const said = await humanSaid(desk.roster, caller.id, str(args.quote));
  if (!said)
    return no(
      `The Human's own words "${clip(str(args.quote), 200)}" are not in this chat as far back as the desk reads: quote a message they wrote, whole or twenty characters of it, or put it to them with ask_human.`,
    );
  const choice = args.choice.trim();
  // What they wrote goes on record whole beside the choice: the words are the evidence, not the part quoted.
  const recorded = settleQuestion(desk, project, id, choice, {
    text: str(args.text) || undefined,
    by: "chat",
    quote: said,
  });
  if (typeof recorded === "string") return no(recorded);
  const lane = recorded.parked && recorded.lane ? loadLedger(project.state).lanes[recorded.lane] : undefined;
  const held = lane?.onHold
    ? ` Lane ${lane.id} is still on hold for it: resume_lane it once the answer is carried into the lane.`
    : "";
  const told = await tellKeptOff(desk, project, recorded);
  return ok(`${id} is ${recorded.status}: ${choice}.${held}${told}`);
}
