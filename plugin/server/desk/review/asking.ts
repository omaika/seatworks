import type { CheckSpec } from "../../catalog/kit/kit.ts";
import type { Team } from "../../catalog/team/team.ts";
import { errorText } from "../../core/errors.ts";
import { daemonLog } from "../../core/logger.ts";
import type { Answer, Judge, Judgement, Question } from "../../core/ports.ts";
import { caseLetters } from "../letters/case-letters.ts";
import { loadLedger } from "../store/ledger.ts";
import type { Project } from "../project/project.ts";
import { type Assessments, askKept, holds, keepUnasked } from "../store/assessments.ts";
import type { DeskServices } from "../services.ts";

/**
 * One moment of the record review asks about as evidence for whoever accepts the work: whose (`subject`), which of theirs
 * (`episode`), the state its questions read, and each question by name with its check and the fields the code fills.
 */
export type Case = {
  subject: string;
  episode: string;
  state: Record<string, unknown>;
  asked: Record<string, { check: string; fill?: Record<string, string> }>;
};

const REVIEW: Assessments = { log: "reviews", unasked: "review.unasked" };

/** The sensor that asks review's checks, or why none can: no sensor, no key, or a host with no way to ask. */
function judgeFor(
  { sensorFor }: Pick<DeskServices, "sensorFor">,
  { sensor }: Team["review"],
): { id: string; label: string; judge: Judge } | { id: string; unasked: string } {
  if (!sensor) return { id: "", unasked: "no sensor the kit knows is set to ask review's checks" };
  if (!sensor.key)
    return { id: sensor.id, unasked: `${sensor.sensor.label} has no ${sensor.sensor.key} on this machine` };
  const judge = sensorFor(sensor.sensor, sensor.key);
  return judge
    ? { id: sensor.id, label: sensor.sensor.label, judge }
    : { id: sensor.id, unasked: "this host has no way to ask a sensor" };
}

/** The check's wording with the fields the code fills; one left unfilled is the code's mistake, and nothing is asked. */
function questionOf(check: CheckSpec, fill: Record<string, string> = {}): Question {
  const { instructions } = check;
  if (typeof instructions === "string") return { type: check.type, instructions, criteria: check.criteria };
  const filled = Object.fromEntries(
    Object.entries(instructions).map(([field, value]) => [field, value ?? fill[field]]),
  );
  const missing = Object.keys(filled).filter((field) => filled[field] === undefined);
  if (missing.length > 0) throw new Error(`nothing filled ${missing.join(", ")} in ${JSON.stringify(instructions)}`);
  return { type: check.type, instructions: filled as Record<string, string>, criteria: check.criteria };
}

function verdictOf(check: CheckSpec, answer: Answer | undefined): string {
  if (check.type === "condition") return holds(check, answer);
  return answer && "pick" in answer && answer.confidence >= check.sure ? answer.pick : "unclear";
}

const sureOf = (answer: Answer | undefined): number | undefined =>
  answer === undefined ? undefined : "likely" in answer ? answer.likely : answer.confidence;

type Asking = Pick<DeskServices, "kit" | "teamFor" | "sensorFor" | "roster" | "mail">;

/**
 * Asks review's sensor about one case, keeps what came back, or why nothing could be asked, and sends what it answered
 * to whoever decides on the work as evidence. Nothing the desk does waits on it, so it never throws.
 */
export async function judge(services: Asking, project: Project, found: Case): Promise<void> {
  try {
    await ask(services, project, found);
  } catch (error) {
    daemonLog.error(`${project.slug}: review's evidence could not be asked about ${found.subject}:`, error);
  }
}

async function ask(services: Asking, project: Project, found: Case): Promise<void> {
  const { kit } = services;
  const asked = Object.entries(found.asked).filter(([, { check }]) => kit.checks[check] !== undefined);
  const review = services.teamFor(project).review;
  // Off is the settings' choice, not something missing, so nothing is kept as unasked.
  if (asked.length === 0 || review.off) return;
  const chosen = judgeFor(services, review);
  const about = {
    subject: found.subject,
    episode: found.episode,
    by: chosen.id,
    state: found.state,
    checks: Object.fromEntries(asked.map(([name, { check }]) => [name, check])),
  };
  if ("unasked" in chosen) return keepUnasked(project, REVIEW, about, chosen.unasked);
  let questions: Record<string, Question>;
  try {
    questions = Object.fromEntries(
      asked.map(([name, { check, fill }]) => [name, questionOf(kit.checks[check]!, fill)]),
    );
  } catch (error) {
    return keepUnasked(project, REVIEW, about, errorText(error));
  }
  const verdicts = (judged: Judgement) =>
    Object.fromEntries(asked.map(([name, { check }]) => [name, verdictOf(kit.checks[check]!, judged.answers[name])]));
  const judged = await askKept(project, REVIEW, about, chosen.judge, questions, (answered) => ({
    verdicts: verdicts(answered),
  }));
  if (!judged) return;
  const read = Object.entries(verdicts(judged)).map(([name, verdict]) => ({
    question: questions[name]!,
    verdict,
    sure: sureOf(judged.answers[name]),
  }));
  const to = await deciderOf(services, project, found.subject);
  await services.mail.post(to, caseLetters.evidence(found.subject, found.episode, chosen.label, read));
}

/** Who decides on `subject`'s work: a task's lane's reader, who accepts it, or whoever supervises a lane, who lands it. */
async function deciderOf(
  { roster }: Pick<DeskServices, "roster">,
  project: Project,
  subject: string,
): Promise<string | undefined> {
  const ledger = loadLedger(project.state);
  const task = ledger.tasks[subject];
  if (task) return (await roster.readerOf(project, ledger.lanes[task.lane])).to;
  return roster.supervisorFor(project, ledger.lanes[subject]?.opener);
}
